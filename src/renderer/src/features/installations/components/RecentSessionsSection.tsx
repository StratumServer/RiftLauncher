import { useState } from "react"
import { useTranslation } from "react-i18next"

import { MAX_SESSIONS_PER_INSTALLATION, peakRssBytes } from "@domain/sessions/sampling"
import { usePlaySessions } from "@renderer/features/installations/hooks/usePlaySessions"
import { formatBytes, formatDuration } from "@renderer/features/installations/components/SessionMemoryChart"

import { FormButton, FormFieldDescription, FormGroupWrapper } from "@renderer/components/ui/FormComponents"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"

/**
 * What the launcher measured of this Installation's last sessions (#461).
 *
 * Read only, and after the fact: nothing appears while the game runs, because the game is what the
 * player is looking at then. A row is a date, a length, a peak; the chart is one click away.
 *
 * The section is absent altogether when there is nothing to show and nothing is being measured,
 * rather than explaining a feature that is turned off.
 */
export interface RecentSessionsSectionProps {
  installationId: string
  /** The Installation's own `_playing` flag, which is how this learns a session has ended. */
  isPlaying: boolean
  /** The setting. False with sessions still on disk still shows them: the history is the player's. */
  measuring: boolean
}

export function RecentSessionsSection({ installationId, isPlaying, measuring }: Readonly<RecentSessionsSectionProps>): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const { sessions, problem, forget } = usePlaySessions(installationId, isPlaying)
  const [openSession, setOpenSession] = useState<PlaySession | null>(null)

  if (!measuring && sessions.length === 0) return null

  return (
    <FormGroupWrapper title={t("features.sessions.recentSessions")}>
      {problem ? (
        <FormFieldDescription content={t(problem === "newer-format" ? "features.sessions.newerFormat" : "features.sessions.unreadable")} />
      ) : sessions.length === 0 ? (
        <FormFieldDescription content={t("features.sessions.empty", { kept: MAX_SESSIONS_PER_INSTALLATION })} />
      ) : (
        <div className="w-full flex flex-col gap-2">
          <ul className="w-full flex flex-col gap-1">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => setOpenSession(session)}
                  title={t("features.sessions.openSession")}
                  className="w-full flex gap-3 items-center justify-between rounded-sm p-2 text-left text-sm text-zinc-200 bg-zinc-800/30 hover:bg-zinc-800/60 focus:outline-none focus-visible:outline-2 focus-visible:outline-vsl cursor-pointer"
                >
                  <span className="shrink-0">{new Date(session.startedAt).toLocaleString(i18n.resolvedLanguage)}</span>
                  <span className="shrink-0 text-zinc-400">{formatDuration(session.endedAt - session.startedAt)}</span>
                  <span className="shrink-0 text-zinc-400">{formatBytes(peakRssBytes(session.samples))}</span>
                </button>
              </li>
            ))}
          </ul>

          <FormFieldDescription content={t("features.sessions.whatThisIs")} />

          <div className="w-full flex justify-end">
            <FormButton onClick={forget} title={t("features.sessions.forget")} variant="secondary" size="sm" />
          </div>
        </div>
      )}

      <PopupDialogPanel title={t("features.sessions.sessionTitle")} isOpen={openSession !== null} close={() => setOpenSession(null)} fixedWidth={false}>
        <>
          {openSession && (
            <div className="w-full max-w-[40rem] flex flex-col gap-2 text-left">
              <p className="text-sm text-zinc-200">
                {t("features.sessions.ranFor", {
                  duration: formatDuration(openSession.endedAt - openSession.startedAt),
                  ended: new Date(openSession.endedAt).toLocaleString(i18n.resolvedLanguage)
                })}
              </p>

              {openSession.partial && <FormFieldDescription content={t("features.sessions.partial")} />}
            </div>
          )}
        </>
      </PopupDialogPanel>
    </FormGroupWrapper>
  )
}
