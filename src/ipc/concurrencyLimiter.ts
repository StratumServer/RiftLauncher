/**
 * A counting semaphore: `run` starts its task immediately while fewer than `limit` tasks
 * are already in flight, and queues it (FIFO) otherwise, starting it as soon as a slot
 * frees up.
 *
 * Exists to cap how many worker threads a burst of same-kind IPC calls can spin up at
 * once (e.g. installing several mods at once, each downloading and then extracting):
 * acquireWorker itself has no ceiling, so without this, N concurrent renderer calls
 * meant N concurrent worker threads with no bound. A queued task shows up to the caller as
 * a promise that simply hasn't resolved yet, no different from a slow worker; TaskManagerContext
 * already renders that as "pending" until the first progress event arrives.
 *
 * No Electron import here on purpose, the same split workerPool.ts/workerManager.ts uses:
 * this is plain, host-agnostic bookkeeping, testable under bare Node. The module that owns
 * the instances (ipc/handlers/pathsHandlers.ts) is what ties shutdown() to app quit.
 */

/** What every task the limiter refuses after `shutdown()` rejects with. */
export const LIMITER_SHUTDOWN_MESSAGE = "Cancelled because the app is quitting"

interface QueuedWaiter {
  /** Takes the freed slot and lets `run` proceed into its task. */
  start: () => void
  /** Gives up the place in line, rejecting the caller's `run` promise. */
  abort: (error: Error) => void
}

export class ConcurrencyLimiter {
  private active = 0
  private shuttingDown = false
  private readonly queue: QueuedWaiter[] = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()

    try {
      // Checked again here, not only inside acquire(): acquire() can resolve on a microtask,
      // so shutdown can begin in the gap between it resolving and this line, and a task
      // started in that gap is exactly the one the flag exists to stop.
      if (this.shuttingDown) throw new Error(LIMITER_SHUTDOWN_MESSAGE)
      return await task()
    } finally {
      this.release()
    }
  }

  /**
   * Stops the limiter from ever starting another task: everything queued rejects now, and
   * anything arriving later rejects on arrival. Tasks already in flight are left alone --
   * the limiter never had a way to cancel one, and terminateActiveWorkers is what ends them.
   *
   * Why this has to exist: before-quit's terminateActiveWorkers rejects every in-flight
   * task, each rejection runs run()'s finally, and each release() used to hand its freed
   * slot straight to the next queued task, which acquired a brand-new worker after the
   * sweep had already iterated the set. Since before-quit can preventDefault (the config
   * flush in main/index.ts), that left a live window where fresh downloads and extractions
   * started writing to disk during shutdown.
   *
   * One-way on purpose, matching WorkerPool's own shuttingDown: nothing here un-quits.
   */
  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true

    const waiting = this.queue.splice(0, this.queue.length)
    for (const waiter of waiting) waiter.abort(new Error(LIMITER_SHUTDOWN_MESSAGE))
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.queue.length
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  private acquire(): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error(LIMITER_SHUTDOWN_MESSAGE))

    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }

    return new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({
        start: () => {
          this.active++
          resolvePromise()
        },
        abort: rejectPromise
      })
    })
  }

  private release(): void {
    this.active--

    // Defensive hardening for shutdown ordering: shutdown() drains the queue before any
    // in-flight task can release its slot, so this normally sees no waiter. If another
    // caller ever changes that ordering, a release after shutdown must still not start work.
    if (this.shuttingDown) return

    const next = this.queue.shift()
    if (next) next.start()
  }
}
