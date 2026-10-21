/**
 * The worker side of a pooled worker's life. A worker no longer reads its task out of
 * `workerData` and lets the thread fall idle so the parent can terminate it: it waits on
 * `parentPort` for one task at a time and stays alive for the next one.
 *
 * All four worker shims are this function plus a handler, so the protocol lives in exactly
 * one place on this side of the port: the token echo that lets the parent tell a live
 * task's messages from an abandoned one's, the guard that drops a progress report arriving
 * after its own task already settled, and the promise-or-value handling that accepts a
 * handler that answers without awaiting anything.
 *
 * Attaching the "message" listener is also what keeps the thread alive between tasks: a
 * started MessagePort refs the worker's event loop.
 */

import { parentPort } from "node:worker_threads"

/** Reports 0 to 100 for the task currently running. Ignored once that task has settled. */
export type ProgressReporter = (progress: number) => void

/** What a finished task hands back. Merged into the "finished" message. */
export type TaskResult = Record<string, unknown> | void

/**
 * Aborted when the parent sends `cancel` for the running task. A handler that holds something
 * that must be let go of before its thread ends (the native LZMA2 stream, #758) stops at its next
 * safe point and cleans up; one that ignores it just runs to its end, and the parent's grace
 * period decides how long it waits.
 */
export type TaskSignal = AbortSignal

export type TaskHandler = (payload: Record<string, unknown>, onProgress: ProgressReporter, signal: TaskSignal) => Promise<TaskResult> | TaskResult

/**
 * Turns a rejection into the message text the parent sees. Per worker on purpose:
 * extraction, compression and Inno extraction all forward their own reason; only the
 * download worker still reports a fixed one, matching what each already did before this
 * file existed.
 */
export type FailureDescriber = (error: unknown) => string

type TaskMessage = { type: "task"; token: number; payload: Record<string, unknown> }
type CancelMessage = { type: "cancel"; token: number }

function isCancelMessage(value: unknown): value is CancelMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<CancelMessage>
  return message.type === "cancel" && typeof message.token === "number"
}

function isTaskMessage(value: unknown): value is TaskMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<TaskMessage>
  return message.type === "task" && typeof message.token === "number" && typeof message.payload === "object" && message.payload !== null
}

export function serveTasks(handler: TaskHandler, describeFailure: FailureDescriber): void {
  const port = parentPort
  if (!port) throw new Error("Worker started outside a worker thread")

  let busy = false
  let running: { token: number; abort: () => void; settled: Promise<void> } | undefined

  port.on("message", (message: unknown) => {
    // The parent wants this thread's task stopped before it ends the thread. `cancelled` goes out
    // once the handler has settled (so its own cleanup is done), or at once when there is nothing
    // running under that token.
    if (isCancelMessage(message)) {
      const task = running?.token === message.token ? running : undefined
      task?.abort()
      void (task?.settled ?? Promise.resolve()).then(() => port.postMessage({ type: "cancelled", token: message.token }))
      return
    }

    // Only the pool ever posts here, so anything else is dropped rather than answered:
    // there is no token to answer it under.
    if (!isTaskMessage(message)) return
    const token = message.token

    if (busy) {
      // Unreachable while the pool holds one lease per worker at a time. If it ever
      // happens anyway, retire is what stops the pool handing this worker out again.
      port.postMessage({ type: "error", token, message: "Worker received a task while busy", retire: true })
      return
    }

    busy = true
    let settled = false
    const controller = new AbortController()
    let markSettled: () => void = () => {}
    running = {
      token,
      abort: (): void => controller.abort(),
      settled: new Promise<void>((resolve) => {
        markSettled = resolve
      })
    }

    const finish = (result: TaskResult): void => {
      if (settled) return
      settled = true
      busy = false
      markSettled()
      // The spread comes first on purpose: a handler's result cannot overwrite the real
      // type or token with a field of its own.
      port.postMessage(result ? { ...result, type: "finished", token } : { type: "finished", token })
    }

    const failTask = (error: unknown): void => {
      if (settled) return
      settled = true
      busy = false
      markSettled()
      port.postMessage({ type: "error", token, message: describeFailure(error) })
    }

    const onProgress: ProgressReporter = (progress) => {
      // The stream readers this app uses can emit one last progress event after their
      // own end event. Posting it was harmless while the worker died with its task
      // right after; now the worker can already be sitting idle in the pool.
      if (settled) return
      port.postMessage({ type: "progress", token, progress })
    }

    try {
      const outcome = handler(message.payload, onProgress, controller.signal)
      if (outcome instanceof Promise) void outcome.then(finish, failTask)
      else finish(outcome)
    } catch (error) {
      failTask(error)
    }
  })
}
