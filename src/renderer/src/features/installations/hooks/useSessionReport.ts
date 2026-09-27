import { useEffect, useState } from "react"

import { fetchSessionReport } from "@renderer/features/installations/adapters/logReport"

export type SessionReportStatus = "loading" | "ready" | "no-logs" | "failed"

export interface SessionReportState {
  status: SessionReportStatus
  report: SessionReportType | null
}

/**
 * Reads one Installation's last session, once.
 *
 * Nothing is cached and nothing is watched: the page is opened deliberately, the file on disk
 * already is the last session, and a player who wants a fresh read leaves the page and comes back.
 */
export function useSessionReport(installationPath: string | undefined): SessionReportState {
  const [state, setState] = useState<SessionReportState>({ status: "loading", report: null })

  useEffect(() => {
    if (!installationPath) return setState({ status: "no-logs", report: null })

    let live = true
    setState({ status: "loading", report: null })

    fetchSessionReport(installationPath)
      .then((answer) => {
        if (!live) return
        if (answer.ok) return setState({ status: "ready", report: answer.report })
        setState({ status: answer.reason === "no-logs" ? "no-logs" : "failed", report: null })
      })
      .catch(() => {
        if (live) setState({ status: "failed", report: null })
      })

    return (): void => {
      live = false
    }
  }, [installationPath])

  return state
}
