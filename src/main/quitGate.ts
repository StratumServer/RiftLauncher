/**
 * The before-quit gate: holds the quit until the pending config write and the workers that
 * have to stop cleanly have settled, then quits again.
 *
 * Two things it deliberately does not do. It does not tear anything down while a close guard
 * holds the quit, because the window's close handler vetoes that quit after this event runs
 * (#702), and cancelling an install or shutting a lane cannot be taken back (#758). And it does
 * not stay latched after the quit it triggered: if that quit was vetoed, the app keeps running
 * and the next quit has to flush and wait again.
 *
 * Kept apart from main/index.ts so it can be tested without booting the app.
 */
export interface QuitGateDeps {
  /** Null unless an Inno extraction is running: that worker is asked to stop and let go of its native stream first, because ending the thread under it aborts the launcher (#758). */
  terminateWorkers: () => Promise<void> | null
  flushConfigWrites: () => Promise<unknown> | null
  /**
   * True when the window's close handler is going to veto this quit (a task, the game or a
   * backup holds the close guard). Nothing may be cancelled or shut down in that case.
   */
  closeGuardHoldsQuit: () => boolean
  quit: () => void
}

export function createBeforeQuitHandler(deps: QuitGateDeps): (event: { preventDefault: () => void }) => void {
  let isWaitingForConfigFlush = false
  let isFiringOwnQuit = false

  return (event) => {
    // Checked before anything is torn down: a vetoed quit leaves the launcher running, so its
    // tasks keep running too. A pending config write needs no help here, since the process stays
    // up and writes it on its own; the next quit flushes it.
    if (deps.closeGuardHoldsQuit()) return

    const workersEnding = deps.terminateWorkers()

    if (isWaitingForConfigFlush) {
      // Only the quit this gate fires itself may pass while it waits. Any other one (a second
      // Ctrl+Q, a tray quit) would otherwise end the app under the very cancel it is waiting for.
      if (!isFiringOwnQuit) event.preventDefault()
      return
    }
    const pendingConfigWrite = deps.flushConfigWrites()
    if (pendingConfigWrite === null && workersEnding === null) return

    event.preventDefault()
    isWaitingForConfigFlush = true
    void Promise.allSettled([pendingConfigWrite, workersEnding]).then(() => {
      // `quit` emits before-quit synchronously: that re-entrant pass must go through untouched.
      isFiringOwnQuit = true
      try {
        deps.quit()
      } finally {
        isFiringOwnQuit = false
        // Cleared after `quit` returns, never before: the before-quit it emits runs this handler
        // again and must not hold or flush a second time. Once it has returned, either the app is
        // closing or a close guard vetoed that quit, and either way the next quit starts over.
        isWaitingForConfigFlush = false
      }
    })
  }
}
