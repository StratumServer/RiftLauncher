import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PiEraserDuotone } from "react-icons/pi"

import { MAX_SESSIONS_PER_INSTALLATION, peakRssBytes } from "@domain/sessions/sampling"
import { steadyClimbVerdict } from "@domain/sessions/steadyClimb"
import { usePlaySessions } from "@renderer/features/installations/hooks/usePlaySessions"
import { formatBytes, formatDuration, SessionMemoryChart, SessionSparkline } from "@renderer/features/installations/components/SessionMemoryChart"

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
                  <SessionSparkline session={session} />
                </button>
              </li>
            ))}
          </ul>

          <FormFieldDescription content={t("features.sessions.whatThisIs")} />

          <div className="w-full flex justify-end">
            <FormButton onClick={forget} title={t("features.sessions.forget")} variant="secondary" size="sm" icon={<PiEraserDuotone />} />
          </div>
        </div>
      )}

      <PopupDialogPanel title={t("features.sessions.sessionTitle")} isOpen={openSession !== null} close={() => setOpenSession(null)} fixedWidth={false}>
        <>
          {openSession && (
            <div className="w-full max-w-[40rem] flex flex-col gap-2 text-left">
              {/*
                The date sits beside the sentence rather than inside it: i18next escapes what it
                interpolates and a date carries slashes, which would reach the page as entities.
                Every other date in the launcher is printed straight into the markup for the same
                reason.
              */}
              <p className="text-sm text-zinc-200">
                {t("features.sessions.ranFor", { duration: formatDuration(openSession.endedAt - openSession.startedAt) })}{" "}
                <span className="text-zinc-400">
                  {t("features.sessions.ended")} {new Date(openSession.endedAt).toLocaleString(i18n.resolvedLanguage)}
                </span>
              </p>

              <SessionMemoryChart session={openSession} />

              {openSession.partial && <FormFieldDescription content={t("features.sessions.partial")} />}

              {/*
                The one verdict, and only when it is the flag. "not-steady-climb" is never rendered:
                the sampler stands outside the game, so a session it did not flag is not a session
                it has cleared, and saying so would be a claim nothing here can make.
              */}
              {steadyClimbVerdict(openSession) === "steady-climb" && (
                <div className="w-full flex flex-col gap-1">
                  <p className="text-sm text-zinc-200 text-left">{t("features.sessions.steadyClimb")}</p>
                  <FormFieldDescription content={t("features.sessions.steadyClimbMeaning")} />
                </div>
              )}
            </div>
          )}
        </>
      </PopupDialogPanel>
    </FormGroupWrapper>
  )
}
