/**
 * The before-quit gate: holds the quit until the pending config write and the workers that
 * have to stop cleanly have settled, then quits again.
 *
 * Kept apart from main/index.ts so it can be tested without booting the app.
 */
export interface QuitGateDeps {
  /** Null unless an Inno extraction is running: that worker is asked to stop and let go of its native stream first, because ending the thread under it aborts the launcher (#758). */
  terminateWorkers: () => Promise<void> | null
  flushConfigWrites: () => Promise<unknown> | null
  quit: () => void
}

export function createBeforeQuitHandler(deps: QuitGateDeps): (event: { preventDefault: () => void }) => void {
  let isWaitingForConfigFlush = false

  return (event) => {
    const workersEnding = deps.terminateWorkers()

    if (isWaitingForConfigFlush) return
    const pendingConfigWrite = deps.flushConfigWrites()
    if (pendingConfigWrite === null && workersEnding === null) return

    event.preventDefault()
    isWaitingForConfigFlush = true
    void Promise.allSettled([pendingConfigWrite, workersEnding]).then(() => deps.quit())
  }
}
