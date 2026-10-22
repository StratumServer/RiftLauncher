import { logMessage } from "./logManager"

const tasksBlockingClose = new Set()

export const getShouldPreventClose = (): boolean => tasksBlockingClose.size > 0

export const setShouldPreventClose = (action: "add" | "remove", id: string, desc: string): void => {
  logMessage("info", `[back] [shouldPreventClose] [utils/shouldPreventClose.ts] [setShouldPreventClose] [${id}] [${action}] ${desc}`)

  if (action === "add") {
    tasksBlockingClose.add(id)
  } else if (action === "remove") {
    tasksBlockingClose.delete(id)
  }
}

// Whether a window exists whose close handler can still veto a quit. Set by main/index.ts; without
// one, nothing is left to hold the guard against, so the app quits regardless of it.
let hasWindowToVeto: () => boolean = () => true

export const setCloseVetoWindowProbe = (probe: () => boolean): void => {
  hasWindowToVeto = probe
}

/**
 * True when a quit that is starting now will be vetoed: a close guard is held and a window is
 * there to veto it. The one predicate every before-quit listener uses, so none of them cancels or
 * shuts down work on a quit another one has already seen vetoed (#758).
 */
export const isQuitGoingToBeVetoed = (): boolean => getShouldPreventClose() && hasWindowToVeto()
