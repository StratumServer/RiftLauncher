import { ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation } from "react-router-dom"
import { PiBoxArrowDownDuotone, PiFolderOpenDuotone, PiGearDuotone, PiWrenchDuotone, PiGitForkDuotone, PiHouseLineDuotone, PiPencilDuotone, PiPlusCircleDuotone, PiInfoDuotone } from "react-icons/pi"
import clsx from "clsx"

import { useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"
import { checkInstallationPathExists } from "@renderer/features/launch/adapters/launch"
import { useLaunchGame } from "@renderer/features/launch/hooks/useLaunchGame"

import InstallationsDropdownMenu from "@renderer/features/installations/components/InstallationsDropdownMenu"
import LaunchBackupPrompt from "@renderer/features/launch/components/LaunchBackupPrompt"
import ActivityCenter from "@renderer/components/ui/ActivityCenter"
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
  const { lastUsedInstallation } = useSettingsConfig()
  const { addNotification } = useNotificationsContext()

  const makeInstallationBackup = useMakeInstallationBackup()
  const { launchGame, skipBackupPromptOpen, answerSkipBackupPrompt } = useLaunchGame()

  const [selectedInstallation, setSelectedInstallation] = useState<InstallationType | undefined>(undefined)

  useEffect(() => {
    const si = installations.find((i) => i.id === lastUsedInstallation)
    setSelectedInstallation(si)
  }, [lastUsedInstallation, installations])

  const GROUP_1: MainMenuLinkProps[] = [
    { icon: <PiHouseLineDuotone />, text: t("components.mainMenu.homeTitle"), desc: t("components.mainMenu.homeDesc"), to: "/" },
    { icon: <PiFolderOpenDuotone />, text: t("components.mainMenu.installationsTitle"), desc: t("components.mainMenu.installationsDesc"), to: "/installations" },
    { icon: <PiGitForkDuotone />, text: t("components.mainMenu.versionsTitle"), desc: t("components.mainMenu.versionsDesc"), to: "/versions" },
    { icon: <PiWrenchDuotone />, text: t("components.mainMenu.modsTitle"), desc: t("components.mainMenu.modsDesc"), to: "/mods" },
    { icon: <PiGearDuotone />, text: t("components.mainMenu.configTitle"), desc: t("components.mainMenu.configDesc"), to: "/config" },
    { icon: <PiInfoDuotone />, text: t("components.mainMenu.infoAndHelpTitle"), desc: t("components.mainMenu.infoAndHelpDesc"), to: "/info-and-help" }
  ]

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
          <NormalButton title={t("generic.play")} disabled={!selectedInstallation} onClick={() => launchGame(selectedInstallation)} variant="primary" size="lg" className="h-14 w-full text-2xl">
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

      <LaunchBackupPrompt isOpen={skipBackupPromptOpen} answer={answerSkipBackupPrompt} />
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
