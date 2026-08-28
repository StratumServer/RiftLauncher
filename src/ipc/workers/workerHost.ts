/**
 * The worker side of a pooled worker's life. A worker no longer reads its task out of
 * `workerData` and lets the thread fall idle so the parent can terminate it: it waits on
 * `parentPort` for one task at a time and stays alive for the next one.
 *
 * All five worker shims are this function plus a handler, so the protocol lives in exactly
 * one place on this side of the port: the token echo that lets the parent tell a live
 * task's messages from an abandoned one's, the guard that drops a progress report arriving
 * after its own task already settled, and the promise-or-value handling that lets the
 * synchronous permissions handler share a shape with the four asynchronous ones.
 *
 * Attaching the "message" listener is also what keeps the thread alive between tasks: a
 * started MessagePort refs the worker's event loop.
 */

import { parentPort } from "node:worker_threads"

/** Reports 0 to 100 for the task currently running. Ignored once that task has settled. */
export type ProgressReporter = (progress: number) => void

/** What a finished task hands back. Merged into the "finished" message. */
export type TaskResult = Record<string, unknown> | void

export type TaskHandler = (payload: Record<string, unknown>, onProgress: ProgressReporter) => Promise<TaskResult> | TaskResult

/**
 * Turns a rejection into the message text the parent sees. Per worker on purpose:
 * extraction forwards its own reason, the other four report a fixed one, matching what
 * each already did before this file existed.
 */
export type FailureDescriber = (error: unknown) => string

type TaskMessage = { type: "task"; token: number; payload: Record<string, unknown> }

function isTaskMessage(value: unknown): value is TaskMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<TaskMessage>
  return message.type === "task" && typeof message.token === "number" && typeof message.payload === "object" && message.payload !== null
}

export function serveTasks(handler: TaskHandler, describeFailure: FailureDescriber): void {
  const port = parentPort
  if (!port) throw new Error("Worker started outside a worker thread")

  let busy = false

  port.on("message", (message: unknown) => {
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

    const finish = (result: TaskResult): void => {
      if (settled) return
      settled = true
      busy = false
      // The spread comes first on purpose: a handler's result cannot overwrite the real
      // type or token with a field of its own.
      port.postMessage(result ? { ...result, type: "finished", token } : { type: "finished", token })
    }

    const failTask = (error: unknown): void => {
      if (settled) return
      settled = true
      busy = false
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
      const outcome = handler(message.payload, onProgress)
      if (outcome instanceof Promise) void outcome.then(finish, failTask)
      else finish(outcome)
    } catch (error) {
      failTask(error)
    }
  })
}
