import { ReactNode, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation } from "react-router-dom"
import {
  PiBoxArrowDownDuotone,
  PiFolderOpenDuotone,
  PiGearDuotone,
  PiWrenchDuotone,
  PiGitForkDuotone,
  PiHouseLineDuotone,
  PiPencilDuotone,
  PiPlusCircleDuotone,
  PiInfoDuotone,
  PiXCircleDuotone,
  PiPlayCircleDuotone
} from "react-icons/pi"
import clsx from "clsx"

import { useInstallations, useGameVersions, useSettingsConfig, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { BACKUP_NO_INSTALLATION, useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"
import { pickPlayOutcomeNotification } from "@renderer/utils/playOutcomeNotifications"
import { checkInstallationPathExists, logLaunch, preventAppClose, runGame } from "@renderer/features/launch/adapters/launch"

import InstallationsDropdownMenu from "@renderer/features/installations/components/InstallationsDropdownMenu"
import ActivityCenter from "@renderer/components/ui/ActivityCenter"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { FormButton, FormLinkButton } from "@renderer/components/ui/FormComponents"
import SessionButton from "../ui/SessionButton"

interface MainMenuLinkProps {
  icon: ReactNode
  text: string
  desc: string
  to: string
}

function MainMenu(): JSX.Element {
  const { t } = useTranslation()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const { lastUsedInstallation } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const makeInstallationBackup = useMakeInstallationBackup()

  const [selectedInstallation, setSelectedInstallation] = useState<InstallationType | undefined>(undefined)

  // #338's question is awaited from inside PlayHandler rather than driven from a
  // click handler, so the launch stays one linear function: the finally block
  // still owns clearing _playing and releasing the close guard on every path.
  // Both stay held while the question is on screen, which is what a launch
  // waiting on an answer is.
  const [skipBackupPromptOpen, setSkipBackupPromptOpen] = useState(false)
  const skipBackupAnswerRef = useRef<((launchAnyway: boolean) => void) | null>(null)

  /** Closes the prompt and hands the answer to the PlayHandler call waiting on it. */
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

  useEffect(() => {
    const si = installations.find((i) => i.id === lastUsedInstallation)
    setSelectedInstallation(si)
  }, [lastUsedInstallation, installations])

  // App.tsx keeps MainMenu mounted for as long as the launcher runs, so this
  // only fires on teardown. It answers "do not launch" rather than leaving
  // PlayHandler parked on a promise nobody can resolve, which would hold the
  // close guard until the process exits.
  useEffect(() => {
    return (): void => {
      skipBackupAnswerRef.current?.(false)
      skipBackupAnswerRef.current = null
    }
  }, [])

  const GROUP_1: MainMenuLinkProps[] = [
    { icon: <PiHouseLineDuotone />, text: t("components.mainMenu.homeTitle"), desc: t("components.mainMenu.homeDesc"), to: "/" },
    { icon: <PiFolderOpenDuotone />, text: t("components.mainMenu.installationsTitle"), desc: t("components.mainMenu.installationsDesc"), to: "/installations" },
    { icon: <PiGitForkDuotone />, text: t("components.mainMenu.versionsTitle"), desc: t("components.mainMenu.versionsDesc"), to: "/versions" },
    { icon: <PiWrenchDuotone />, text: t("components.mainMenu.modsTitle"), desc: t("components.mainMenu.modsDesc"), to: "/mods" },
    { icon: <PiGearDuotone />, text: t("components.mainMenu.configTitle"), desc: t("components.mainMenu.configDesc"), to: "/config" },
    { icon: <PiInfoDuotone />, text: t("components.mainMenu.infoAndHelpTitle"), desc: t("components.mainMenu.infoAndHelpDesc"), to: "/info-and-help" }
  ]

  async function PlayHandler(): Promise<void> {
    const id = crypto.randomUUID()
    preventAppClose("add", id, "Started playing Vintage Story.")

    // Only set once _playing has actually been flipped to true below, so the
    // finally block never clears a flag this call did not set itself (the
    // early "already playing" guard reads someone else's _playing, and must
    // not stomp on it if this call unwinds before ever taking it over).
    let playingInstallationId: string | undefined
    let playingGameVersion: string | undefined

    try {
      if (!selectedInstallation) return addNotification(t("features.installations.noInstallationSelected"), "error")
      if (selectedInstallation._playing) return addNotification(t("features.installations.gameAlreadyRunning"), "error")

      const gameVersionToRun = gameVersions.find((gv) => gv.version === selectedInstallation.version)
      if (!gameVersionToRun) {
        // An Installation with no version at all reaches here too (configManager normalizes a
        // missing version to ""), and interpolating that into versionNotInstalled reads as
        // "VS Version  not installed!" with a blank name (#118).
        const message = selectedInstallation.version ? t("features.versions.versionNotInstalled", { version: selectedInstallation.version }) : t("features.versions.noVersionSet")
        return addNotification(message, "error")
      }
      if (gameVersionToRun._installing) return addNotification(t("features.versions.versionInstalling", { version: selectedInstallation.version }), "error")
      if (gameVersionToRun._deleting) return addNotification(t("features.versions.versionDeleting", { version: selectedInstallation.version }), "error")
      if (gameVersionToRun._playing) return addNotification(t("features.versions.versionPlaying", { version: selectedInstallation.version }), "error")

      playingInstallationId = selectedInstallation.id
      playingGameVersion = gameVersionToRun.version

      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: selectedInstallation.id, updates: { _playing: true } } })
      configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: gameVersionToRun.version, updates: { _playing: true } } })

      if (selectedInstallation.backupsAuto) {
        const backupOutcome = await makeInstallationBackup(selectedInstallation.id)

        // A backup that broke is the player's call now (#338): the archive is
        // gone but the game is still there to play. A missing installation is
        // not a call anyone can make, so it stops here without a question.
        if (!backupOutcome.ok) {
          if (backupOutcome.reason === BACKUP_NO_INSTALLATION) return
          const launchAnyway = await askToLaunchWithoutBackup()
          if (!launchAnyway) return
        }
      }

      const startedPlaying = Date.now()
      const result = await runGame(gameVersionToRun, selectedInstallation)

      // Playtime is only recorded once the game actually ran: a launch that
      // never started played for 0 seconds, and crediting it with the sliver
      // of time between the two Date.now() calls would misreport "just
      // played" for a session that never happened.
      if (result.ok) {
        const finishedPlaying = Date.now()
        const ttp = finishedPlaying - startedPlaying + selectedInstallation.totalTimePlayed
        configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: selectedInstallation.id, updates: { lastTimePlayed: finishedPlaying, totalTimePlayed: ttp } } })
      }

      const outcomeNotification = pickPlayOutcomeNotification(result)
      if (outcomeNotification) addNotification(t(outcomeNotification.key), "error")
    } catch (err) {
      logLaunch("error", "[front] [layout] [components/layout/MainMenu.tsx] [MainMenu > PlayHandler] Error executing the game.")
      logLaunch("debug", `[front] [layout] [components/layout/MainMenu.tsx] [MainMenu > PlayHandler] Error executing the game: ${err}`)
      addNotification(t("notifications.body.errorExecutingGame"), "error")
    } finally {
      // Runs on every outcome, the two early-return backup and error paths
      // included, so a failed launch never leaves the installation and game
      // version stuck at _playing: true until the app restarts (issue #40).
      if (playingInstallationId) configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: playingInstallationId, updates: { _playing: false } } })
      if (playingGameVersion) configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: playingGameVersion, updates: { _playing: false } } })
      preventAppClose("remove", id, "Finished playing vintage Story.")
    }
  }

  return (
    <header className="z-99 w-72 shrink-0 flex flex-col gap-4 p-2 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 backdrop-blur-sm border-r border-zinc-400/5">
      <div className="flex items-center shrink-0 gap-2">
        <SessionButton />
        <ActivityCenter />
      </div>

      <div className="h-full flex flex-col gap-2">
        {GROUP_1.map((link) => (
          <Link key={link.to} to={link.to} className="flex items-start">
            <LinkContent icon={link.icon} text={link.text} desc={link.desc} link={link.to} />
          </Link>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <InstallationsDropdownMenu />

        <div className="w-full flex gap-2 items-center">
          <NormalButton title={t("generic.play")} disabled={!selectedInstallation} onClick={PlayHandler} variant="primary" size="lg" className="h-14 w-full text-2xl">
            <p>{t("generic.play")}</p>
          </NormalButton>

          {selectedInstallation && (
            <div className="shrink-0 w-14 h-full grid grid-cols-2 grid-rows-2 gap-1 text-sm">
              <FormButton
                className="p-1"
                title={t("features.installations.backupInstallation")}
                variant="ghost"
                onClick={async () => {
                  if (!(await checkInstallationPathExists(selectedInstallation.path))) return addNotification(t("features.backups.folderDoesntExists"), "error")
                  makeInstallationBackup(selectedInstallation.id)
                }}
              >
                <PiBoxArrowDownDuotone />
              </FormButton>
              <FormLinkButton to={`/installations/mods/${selectedInstallation.id}`} title={t("features.mods.manageMods")} variant="ghost">
                <PiWrenchDuotone />
              </FormLinkButton>
              <FormLinkButton title={t("features.installations.editInstallation")} to={`/installations/edit/${selectedInstallation.id}`} variant="ghost">
                <PiPencilDuotone />
              </FormLinkButton>
              <FormLinkButton title={t("features.installations.addNewInstallation")} to="/installations/add" variant="ghost">
                <PiPlusCircleDuotone />
              </FormLinkButton>
            </div>
          )}
        </div>
      </div>

      {/* Cancel comes first in the DOM because HeadlessUI's focus trap focuses
          the first focusable child, so Enter on a freshly opened prompt keeps
          the launch stopped. The restore and delete confirms order themselves
          the same way for the same reason. */}
      <PopupDialogPanel title={t("features.backups.backupFailedTitle")} isOpen={skipBackupPromptOpen} close={() => answerSkipBackupPrompt(false)}>
        <>
          <p>{t("features.backups.backupFailedSkipLaunch")}</p>
          <div className="flex gap-4 items-center justify-center text-lg">
            <FormButton title={t("generic.cancel")} className="p-2" onClick={() => answerSkipBackupPrompt(false)} type="success">
              <PiXCircleDuotone />
            </FormButton>
            <FormButton title={t("features.backups.launchAnyway")} className="p-2" onClick={() => answerSkipBackupPrompt(true)} type="error">
              <PiPlayCircleDuotone />
            </FormButton>
          </div>
        </>
      </PopupDialogPanel>
    </header>
  )
}

interface LinkContentProps {
  icon: ReactNode
  text: string
  desc: string
  link: string
}

function LinkContent({ icon, text, desc, link }: Readonly<LinkContentProps>): JSX.Element {
  const location = useLocation()

  function currentLocation(): boolean {
    // If we are on the main page return true.
    if (link === "/") return location.pathname === "/"
    // If we are on any other page return true if the current page URL starts with the menu option URL.
    return location.pathname.startsWith(link)
  }

  return (
    <div className={clsx("w-full flex items-center gap-2 px-2 py-1 rounded-sm duration-100 hover:pl-3 border-l-4", currentLocation() ? "border-vs bg-vs/15" : "border-transparent")}>
      <span className="text-2xl text-zinc-400">{icon}</span>
      <div className="flex flex-col overflow-hidden whitespace-nowrap">
        <p className="font-bold text-sm overflow-hidden text-ellipsis">{text}</p>
        <p className="text-zinc-400 text-xs overflow-hidden text-ellipsis">{desc}</p>
      </div>
    </div>
  )
}

export default MainMenu
