/**
 * A pool of worker_threads.Worker instances, reused across tasks of the same script
 * instead of spawned fresh and terminated per task.
 *
 * No Electron import here on purpose: this is plain, host-agnostic pool bookkeeping, with
 * the actual `new Worker(...)` call injected so it stays testable with a fake factory.
 */

import type { Worker } from "node:worker_threads"

/** Whether a finished task's worker goes back in the pool or gets terminated. */
export type WorkerDisposition = "reuse" | "discard"

export interface WorkerLease {
  /** The worker itself, for the caller's own message/error/exit listeners. */
  readonly worker: Worker
  /** Correlates this task's messages. Anything else the worker posts belongs to nobody. */
  readonly token: number
  /** Posts the task. Call it last, only once the caller's own listeners are attached. */
  dispatch(payload: object): void
  /** Ends the lease. Idempotent: only the first call counts. */
  release(disposition: WorkerDisposition): void
}

interface PooledWorker {
  worker: Worker
  scriptPath: string
  state: "busy" | "idle" | "dead"
  tasksRun: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

export interface WorkerPoolOptions {
  idleTimeoutMs?: number
  maxTasksPerWorker?: number
}

/**
 * How long an unused worker waits for the next task of its kind before its thread is
 * terminated.
 *
 * The reuse this exists for happens in milliseconds, not minutes: the ConcurrencyLimiter
 * hands its queued task to a just-freed slot immediately, and extracting a mod follows
 * downloading it right away. What 30 seconds buys on top of that is the gap a person takes
 * between clicking install on one mod and the next. Past that, the odds of a follow-up task
 * fall off while the resident cost of the idle isolate does not.
 */
const IDLE_WORKER_TIMEOUT_MS = 30_000

/**
 * A worker is retired after this many tasks even while it is still being reused. Not a
 * tuning knob, a bound on any per-task leak inside one isolate, so a launcher left open for
 * a week can't grow one worker's heap without limit.
 */
const MAX_TASKS_PER_WORKER = 50

export class WorkerPool {
  private readonly idle = new Map<string, PooledWorker[]>()
  private readonly live = new Set<PooledWorker>()
  private readonly idleTimeoutMs: number
  private readonly maxTasksPerWorker: number
  private nextToken = 0
  private shuttingDown = false

  constructor(
    private readonly createWorker: (scriptPath: string) => Worker,
    options: WorkerPoolOptions = {}
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_WORKER_TIMEOUT_MS
    this.maxTasksPerWorker = options.maxTasksPerWorker ?? MAX_TASKS_PER_WORKER
  }

  /**
   * Hands out a worker for one task: an idle one of the same script if there is one, a
   * fresh thread otherwise.
   *
   * Synchronous on purpose. Nothing yields between taking a worker off the idle list and
   * marking it busy, so two callers racing for the same script can never be handed the
   * same worker, and an idle timer can never fire on a worker that was just taken.
   *
   * @param maxIdle How many workers of this script may sit idle at once. 0 never pools.
   */
  acquire(scriptPath: string, maxIdle: number): WorkerLease {
    // Same asymmetry the ConcurrencyLimiter fix closes upstream: returnWorker already
    // refuses to re-idle a worker once shuttingDown, but nothing stopped acquire() itself
    // from spawning a brand-new thread after terminateAll() had already run.
    if (this.shuttingDown) throw new Error("Worker pool is shutting down")

    const pooled = this.take(scriptPath)
    pooled.state = "busy"
    const token = ++this.nextToken
    let released = false

    return {
      worker: pooled.worker,
      token,
      dispatch: (payload: object): void => {
        pooled.worker.postMessage({ type: "task", token, payload })
      },
      release: (disposition: WorkerDisposition): void => {
        if (released) return
        released = true
        this.returnWorker(pooled, disposition, maxIdle)
      }
    }
  }

  /** Kills every worker, idle or mid-task, and stops pooling. Call on app quit. */
  terminateAll(): void {
    this.shuttingDown = true
    for (const pooled of this.live) this.forget(pooled)
    this.idle.clear()
  }

  get idleWorkerCount(): number {
    let total = 0
    for (const list of this.idle.values()) total += list.length
    return total
  }

  get liveWorkerCount(): number {
    return this.live.size
  }

  private take(scriptPath: string): PooledWorker {
    // pop(), not shift(): reusing the most recently used worker lets the oldest idle ones
    // age out and die instead of every idle worker staying warm forever.
    const pooled = this.idle.get(scriptPath)?.pop()
    if (!pooled) return this.spawn(scriptPath)
    clearTimeout(pooled.idleTimer)
    pooled.idleTimer = undefined
    pooled.worker.ref()
    return pooled
  }

  private spawn(scriptPath: string): PooledWorker {
    const worker = this.createWorker(scriptPath)
    const pooled: PooledWorker = { worker, scriptPath, state: "busy", tasksRun: 0, idleTimer: undefined }

    // Permanent, never removed, for two reasons: a worker that dies while idle has to
    // leave the pool immediately, or the next acquire hands out a dead thread whose
    // postMessage goes nowhere and the caller's task hangs until its own timeout; and a
    // Worker that emits "error" with no listener attached throws that error into the main
    // process instead.
    const forget = (): void => this.forget(pooled)
    worker.on("error", forget)
    worker.on("exit", forget)

    this.live.add(pooled)
    return pooled
  }

  private returnWorker(pooled: PooledWorker, disposition: WorkerDisposition, maxIdle: number): void {
    if (pooled.state === "dead") return
    pooled.tasksRun++

    if (disposition === "discard" || this.shuttingDown || pooled.tasksRun >= this.maxTasksPerWorker) {
      this.forget(pooled)
      return
    }

    let idleList = this.idle.get(pooled.scriptPath)
    if (!idleList) {
      idleList = []
      this.idle.set(pooled.scriptPath, idleList)
    }
    if (idleList.length >= maxIdle) {
      this.forget(pooled)
      return
    }

    pooled.state = "idle"
    pooled.worker.unref()
    const idleTimer = setTimeout(() => this.forget(pooled), this.idleTimeoutMs)
    idleTimer.unref()
    pooled.idleTimer = idleTimer
    idleList.push(pooled)
  }

  /** Idempotent: a crashing worker's "error" and "exit" listeners both land here for the same death. */
  private forget(pooled: PooledWorker): void {
    if (pooled.state === "dead") return
    pooled.state = "dead"
    clearTimeout(pooled.idleTimer)
    pooled.idleTimer = undefined

    const idleList = this.idle.get(pooled.scriptPath)
    const index = idleList?.indexOf(pooled) ?? -1
    if (idleList && index >= 0) idleList.splice(index, 1)

    this.live.delete(pooled)
    void pooled.worker.terminate()
  }
}
