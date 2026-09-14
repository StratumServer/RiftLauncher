import { useCallback, useEffect, useState } from "react"

import { forgetPlaySessions, loadPlaySessions } from "@renderer/features/installations/adapters/sessions"

/** Why there is nothing to show, when that is not simply "nothing has been recorded yet". */
export type PlaySessionsProblem = "newer-format" | "unreadable" | "refused"

export interface UsePlaySessionsResult {
  /** Newest first. Empty while loading, and empty when the file could not be read. */
  sessions: PlaySession[]
  problem: PlaySessionsProblem | undefined
  loading: boolean
  /** Clears the file and the list with it. */
  forget: () => Promise<void>
}

/**
 * The sessions recorded for one Installation, reloaded when a session ends.
 *
 * `isPlaying` is how this page learns a session ended: nothing is pushed at the renderer while the
 * game runs, so the reload is hung off the flag falling back to false. The list is left alone
 * while the game is up, since the file it would read is the one the game is still adding to.
 */
export function usePlaySessions(installationId: string | undefined, isPlaying: boolean): UsePlaySessionsResult {
  const [sessions, setSessions] = useState<PlaySession[]>([])
  const [problem, setProblem] = useState<PlaySessionsProblem | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!installationId || isPlaying) return

    // A reload asked for by a session that has just ended can land after the player has navigated
    // to another Installation, so only the latest request may write.
    let latest = true
    setLoading(true)

    void loadPlaySessions(installationId).then(
      (read) => {
        if (!latest) return
        setSessions(read.ok ? read.sessions : [])
        setProblem(read.ok ? undefined : read.reason)
        setLoading(false)
      },
      () => {
        if (!latest) return
        setProblem("unreadable")
        setLoading(false)
      }
    )

    return (): void => {
      latest = false
    }
  }, [installationId, isPlaying])

  const forget = useCallback(async (): Promise<void> => {
    if (!installationId) return
    if (!(await forgetPlaySessions(installationId))) return
    setSessions([])
    setProblem(undefined)
  }, [installationId])

  return { sessions, problem, loading, forget }
}
