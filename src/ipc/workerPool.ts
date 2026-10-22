/**
 * A pool of worker_threads.Worker instances, reused across tasks of the same script
 * instead of spawned fresh and terminated per task.
 *
 * No Electron import here on purpose: this is plain, host-agnostic pool bookkeeping, with
 * the actual `new Worker(...)` call injected so it stays testable with a fake factory.
 */

import type { Worker } from "node:worker_threads"

/**
 * Whether a finished task's worker goes back in the pool or gets terminated. `cancel` is for a
 * worker whose task is still running and that was acquired as cancellable: it is asked to stop the
 * task and let go of what it holds, and is terminated once it confirms or after the grace period.
 */
export type WorkerDisposition = "reuse" | "discard" | "cancel"

export interface WorkerLease {
  /** The worker itself, for the caller's own message/error/exit listeners. */
  readonly worker: Worker
  /** Correlates this task's messages. Anything else the worker posts belongs to nobody. */
  readonly token: number
  /** Posts the task. Call it last, only once the caller's own listeners are attached. */
  dispatch(payload: object): void
  /** Ends the lease. Idempotent: only the first call counts. */
  release(disposition: WorkerDisposition): Promise<void> | null
}

interface PooledWorker {
  worker: Worker
  scriptPath: string
  state: "busy" | "idle" | "cancelling" | "dead"
  cancellable: boolean
  token: number
  /** Set while a cancel is in flight; settles once the worker confirmed or was terminated. */
  ending: Promise<void> | undefined
  tasksRun: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

export interface WorkerPoolOptions {
  idleTimeoutMs?: number
  maxTasksPerWorker?: number
  cancelGraceMs?: number
  /** Called when a cancelled worker did not confirm within the grace period and is about to be terminated mid-task. */
  onCancelGraceExpired?: (scriptPath: string) => void
}

export interface AcquireOptions {
  /**
   * The worker script answers a `cancel` message with `cancelled` once its task has stopped (see
   * `serveTasks`). Only such a worker may be released as `cancel` or have `terminateAll` wait on it.
   */
  cancellable?: boolean
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

/**
 * How long a cancelled worker gets to stop its task and let go of what it holds before its thread
 * is terminated anyway. Stopping the Inno extraction takes its next installer read, the native
 * stream's settle time and removing the staging folder, so this is generous on purpose: past it
 * the thread is ended whatever state it is in, as it always was before the cancel existed.
 */
const CANCEL_GRACE_MS = 5_000

export class WorkerPool {
  private readonly idle = new Map<string, PooledWorker[]>()
  private readonly live = new Set<PooledWorker>()
  private readonly idleTimeoutMs: number
  private readonly maxTasksPerWorker: number
  private readonly cancelGraceMs: number
  private readonly onCancelGraceExpired: ((scriptPath: string) => void) | undefined
  private nextToken = 0
  private shuttingDown = false

  constructor(
    private readonly createWorker: (scriptPath: string) => Worker,
    options: WorkerPoolOptions = {}
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_WORKER_TIMEOUT_MS
    this.maxTasksPerWorker = options.maxTasksPerWorker ?? MAX_TASKS_PER_WORKER
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS
    this.onCancelGraceExpired = options.onCancelGraceExpired
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
  acquire(scriptPath: string, maxIdle: number, options: AcquireOptions = {}): WorkerLease {
    // Same asymmetry the ConcurrencyLimiter fix closes upstream: returnWorker already
    // refuses to re-idle a worker once shuttingDown, but nothing stopped acquire() itself
    // from spawning a brand-new thread after terminateAll() had already run.
    if (this.shuttingDown) throw new Error("Worker pool is shutting down")

    const pooled = this.take(scriptPath)
    pooled.state = "busy"
    pooled.cancellable = options.cancellable === true
    const token = ++this.nextToken
    pooled.token = token
    let released = false

    return {
      worker: pooled.worker,
      token,
      dispatch: (payload: object): void => {
        pooled.worker.postMessage({ type: "task", token, payload })
      },
      release: (disposition: WorkerDisposition): Promise<void> | null => {
        if (released) return null
        released = true
        return this.returnWorker(pooled, disposition, maxIdle)
      }
    }
  }

  /**
   * Kills every worker, idle or mid-task, and stops pooling. Call on app quit.
   *
   * A busy worker that was acquired as cancellable is asked to stop its task first, and the
   * returned promise settles once each of those confirmed or ran out of grace, and is null when
   * there was none. Every other worker is terminated before this returns, exactly as before, so a
   * caller that ignores the promise still gets the old behavior for them.
   */
  terminateAll(): Promise<void> | null {
    this.shuttingDown = true
    const ending: Promise<void>[] = []
    for (const pooled of [...this.live]) {
      if (pooled.state === "busy" && pooled.cancellable) ending.push(this.endGracefully(pooled))
      else if (pooled.state === "cancelling" && pooled.ending) ending.push(pooled.ending)
      else this.forget(pooled)
    }
    this.idle.clear()
    return ending.length > 0 ? Promise.all(ending).then(() => undefined) : null
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
    const pooled: PooledWorker = { worker, scriptPath, state: "busy", cancellable: false, token: 0, ending: undefined, tasksRun: 0, idleTimer: undefined }

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

  private returnWorker(pooled: PooledWorker, disposition: WorkerDisposition, maxIdle: number): Promise<void> | null {
    if (pooled.state === "dead") return null
    pooled.tasksRun++

    if (disposition === "cancel" && pooled.cancellable) return this.endGracefully(pooled)

    if (disposition === "cancel" || disposition === "discard" || this.shuttingDown || pooled.tasksRun >= this.maxTasksPerWorker) {
      this.forget(pooled)
      return null
    }

    let idleList = this.idle.get(pooled.scriptPath)
    if (!idleList) {
      idleList = []
      this.idle.set(pooled.scriptPath, idleList)
    }
    if (idleList.length >= maxIdle) {
      this.forget(pooled)
      return null
    }

    pooled.state = "idle"
    pooled.worker.unref()
    const idleTimer = setTimeout(() => this.forget(pooled), this.idleTimeoutMs)
    idleTimer.unref()
    pooled.idleTimer = idleTimer
    idleList.push(pooled)
    return null
  }

  /**
   * Asks a busy worker to stop its task and terminates it once it says `cancelled`, exits, or the
   * grace period ends. The worker stays in `live` until then, so `terminateAll` can still find it.
   */
  private endGracefully(pooled: PooledWorker): Promise<void> {
    if (pooled.ending) return pooled.ending
    if (pooled.state === "dead") return Promise.resolve()

    pooled.state = "cancelling"
    const token = pooled.token
    pooled.ending = new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        pooled.worker.off("message", onMessage)
        pooled.worker.off("exit", done)
        this.forget(pooled)
        resolve()
      }
      const onMessage = (message: unknown): void => {
        const candidate = message as { type?: unknown; token?: unknown } | null
        if (candidate?.type === "cancelled" && candidate.token === token) done()
      }
      const timer = setTimeout(() => {
        // Only reached when neither `cancelled` nor an exit arrived: the thread is ended with the
        // task still running, which is what the cancel exists to avoid.
        const expired = pooled.state !== "dead"
        try {
          if (expired) this.onCancelGraceExpired?.(pooled.scriptPath)
        } catch {
          // The hook only reports. Swallowed on purpose: this runs in a timer, so letting it
          // escape would crash the process with the worker still running, and skipping `done`
          // would leave the worker live and `ending` unsettled. The pool has no logger by design
          // (no Electron import here), so the host's hook is the thing that must not throw.
        } finally {
          done()
        }
      }, this.cancelGraceMs)
      pooled.worker.on("message", onMessage)
      pooled.worker.on("exit", done)
      pooled.worker.postMessage({ type: "cancel", token })
    })
    return pooled.ending
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
