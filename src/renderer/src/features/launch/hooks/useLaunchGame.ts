import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useGameVersions, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"
import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"
import { pickPlayOutcomeNotification } from "@renderer/utils/playOutcomeNotifications"
import { getInstallationVersionStatus } from "@domain/installations/versionReference"
import { logLaunch, preventAppClose, runGame } from "@renderer/features/launch/adapters/launch"

const LOG_TAG = "[front] [launch] [features/launch/hooks/useLaunchGame.ts] [useLaunchGame > launchGame]"

export interface LaunchGame {
  /**
   * Starts one Installation, optionally connecting it to one of that Installation's own saved
   * servers. `serverId` is a bookmark id and nothing else: the main process resolves it against
   * the stored list itself, so a stale id refuses the launch rather than reaching the game.
   */
  launchGame: (installation: InstallationType | undefined, serverId?: string) => Promise<void>
  /** True while the launch is parked on #338's question. Render {@link LaunchBackupPrompt} with it. */
  skipBackupPromptOpen: boolean
  /** Closes the prompt and lets the waiting launch carry on, or not. */
  answerSkipBackupPrompt: (launchAnyway: boolean) => void
}

/**
 * The launcher's one launch path.
 *
 * It used to live inside MainMenu as `PlayHandler`, which was fine while Play was the only way to
 * start the game. Joining a saved server (#460) needs every single thing that function does: the
 * prevent-close token, both `_playing` flags, #338's auto-backup question, the playtime stamp and
 * the outcome notification. A second copy of all that is a second set of the bugs each of those
 * pieces was added to fix, so the function moved here whole and gained one optional argument.
 *
 * The backup question is deliberately still awaited from inside the launch rather than driven from
 * a click handler, so the launch stays one linear function and the `finally` block keeps owning the
 * `_playing` flags and the close guard on every path. Both stay held while the question is on
 * screen, which is what a launch waiting on an answer is.
 */
export function useLaunchGame(): LaunchGame {
  const { t } = useTranslation()
  const gameVersions = useGameVersions()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const { openOnBrowser: openExternalLink } = useExternalLinks()
  const { os } = useAppInfo()

  const makeInstallationBackup = useMakeInstallationBackup()

  const [skipBackupPromptOpen, setSkipBackupPromptOpen] = useState(false)
  const skipBackupAnswerRef = useRef<((launchAnyway: boolean) => void) | null>(null)

  /** Closes the prompt and hands the answer to the launch call waiting on it. */
  function answerSkipBackupPrompt(launchAnyway: boolean): void {
    setSkipBackupPromptOpen(false)
    skipBackupAnswerRef.current?.(launchAnyway)
    skipBackupAnswerRef.current = null
  }

  /** Asks whether to launch without a backup. Cancel, Escape and a click outside all answer no. */
  function askToLaunchWithoutBackup(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      skipBackupAnswerRef.current = resolve
      setSkipBackupPromptOpen(true)
    })
  }

  // Answers "do not launch" on teardown rather than leaving the launch parked on a promise nobody
  // can resolve, which would hold the close guard until the process exits.
  useEffect(() => {
    return (): void => {
      skipBackupAnswerRef.current?.(false)
      skipBackupAnswerRef.current = null
    }
  }, [])

  async function launchGame(installation: InstallationType | undefined, serverId?: string): Promise<void> {
    const id = crypto.randomUUID()
    preventAppClose("add", id, "Started playing Vintage Story.")

    // Only set once _playing has actually been flipped to true below, so the
    // finally block never clears a flag this call did not set itself (the
    // early "already playing" guard reads someone else's _playing, and must
    // not stomp on it if this call unwinds before ever taking it over).
    let playingInstallationId: string | undefined
    let playingGameVersionId: string | undefined

    try {
      if (!installation) return addNotification(t("features.installations.noInstallationSelected"), "error")
      if (installation._playing) return addNotification(t("features.installations.gameAlreadyRunning"), "error")
      // Update all deletes each old archive before downloading its replacement, so a game started
      // mid-run would load a Mods folder with some of its Mods missing.
      if (installation._updatingMods) return addNotification(t("features.mods.cantPlayWhileUpdatingMods"), "error")

      const gameVersionToRun = installation.version ? gameVersions.find((gv) => gv.id === installation.gameVersionId) : undefined
      if (!gameVersionToRun) {
        // An Installation with no version at all reaches here too (configManager normalizes a
        // missing version to ""), and interpolating that into versionNotInstalled reads as
        // "VS Version  not installed." with a blank name (#118).
        const status = getInstallationVersionStatus(installation, gameVersions)
        const message =
          status === "unset"
            ? t("features.versions.noVersionSet")
            : status === "unlinked"
              ? t("features.versions.versionUnlinked")
              : t("features.versions.versionNotInstalled", { version: installation.version })
        return addNotification(message, "error")
      }
      if (gameVersionToRun._installing) return addNotification(t("features.versions.versionInstalling", { version: installation.version }), "error")
      if (gameVersionToRun._deleting) return addNotification(t("features.versions.versionDeleting", { version: installation.version }), "error")
      if (gameVersionToRun._playing) return addNotification(t("features.versions.versionPlaying", { version: installation.version }), "error")

      playingInstallationId = installation.id
      playingGameVersionId = gameVersionToRun.id

      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { _playing: true } } })
      configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: gameVersionToRun.id, updates: { _playing: true } } })

      if (installation.backupsAuto) {
        const backupOutcome = await makeInstallationBackup(installation.id)

        // Only an archive compression or pruning failure is recoverable: the
        // installation still exists and the player can knowingly launch
        // without this backup (#338). Busy, playing, restoring, and missing
        // installation states are hard stops and must not offer an override.
        if (!backupOutcome.ok) {
          const canLaunchWithoutBackup = backupOutcome.reason === "compress-failed" || backupOutcome.reason === "prune-failed"
          if (!canLaunchWithoutBackup) return

          const launchAnyway = await askToLaunchWithoutBackup()
          if (!launchAnyway) return
        }
      }

      const startedPlaying = Date.now()
      const result = await runGame(gameVersionToRun, installation, serverId)

      // Playtime is only recorded once the game actually ran: a launch that
      // never started played for 0 seconds, and crediting it with the sliver
      // of time between the two Date.now() calls would misreport "just
      // played" for a session that never happened.
      if (result.ok) {
        const finishedPlaying = Date.now()
        const ttp = finishedPlaying - startedPlaying + installation.totalTimePlayed
        configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { lastTimePlayed: finishedPlaying, totalTimePlayed: ttp } } })
        // Stamped exactly where lastTimePlayed is, and says exactly as much: the launcher spawned
        // the game with this bookmark's connect argument and the process started. Whether the
        // connection itself landed is something only the game ever learns.
        //
        // Its own action rather than an EDIT_INSTALLATION carrying the array: `installation` here
        // is the one Join closed over, and the window stayed usable for the whole session, so
        // writing that list back would revert every bookmark added, edited or removed while the
        // game ran. The reducer stamps the list it currently holds.
        if (serverId) configDispatch({ type: CONFIG_ACTIONS.STAMP_SERVER_LAUNCH, payload: { id: installation.id, serverId, when: finishedPlaying } })
      }

      const outcomeNotification = pickPlayOutcomeNotification(result, os)
      if (outcomeNotification) {
        const link = outcomeNotification.link
        const options = link ? { actions: [{ id: "open-guide", label: t(link.labelKey), onClick: (): void => openExternalLink(link.url) }] } : undefined
        addNotification(t(outcomeNotification.key), "error", options)
      }
    } catch (err) {
      logLaunch("error", `${LOG_TAG} Error executing the game.`)
      logLaunch("debug", `${LOG_TAG} Error executing the game: ${err}`)
      addNotification(t("notifications.body.errorExecutingGame"), "error")
    } finally {
      // Runs on every outcome, the two early-return backup and error paths
      // included, so a failed launch never leaves the installation and game
      // version stuck at _playing: true until the app restarts (issue #40).
      if (playingInstallationId) configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: playingInstallationId, updates: { _playing: false } } })
      if (playingGameVersionId) configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: playingGameVersionId, updates: { _playing: false } } })
      preventAppClose("remove", id, "Finished playing vintage Story.")
    }
  }

  return { launchGame, skipBackupPromptOpen, answerSkipBackupPrompt }
}
