/**
 * A counting semaphore: `run` starts its task immediately while fewer than `limit` tasks
 * are already in flight, and queues it (FIFO) otherwise, starting it as soon as a slot
 * frees up.
 *
 * Exists to cap how many worker threads a burst of same-kind IPC calls can spin up at
 * once (e.g. installing several mods at once, each downloading and then extracting):
 * createTrackedWorker itself has no ceiling, so without this, N concurrent renderer calls
 * meant N concurrent worker threads with no bound. A queued task shows up to the caller as
 * a promise that simply hasn't resolved yet, no different from a slow worker; TaskManagerContext
 * already renders that as "pending" until the first progress event arrives.
 */
export class ConcurrencyLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.queue.length
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }

    return new Promise((resolvePromise) => {
      this.queue.push(() => {
        this.active++
        resolvePromise()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}
