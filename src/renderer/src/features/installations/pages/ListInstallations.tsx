import { useState, useRef } from "react"
import { Input } from "@headlessui/react"
import {
  PiFolderOpenDuotone,
  PiPlusCircleDuotone,
  PiPencilDuotone,
  PiBoxArrowDownDuotone,
  PiArrowCounterClockwiseDuotone,
  PiWrenchDuotone,
  PiXCircleDuotone,
  PiTrashDuotone,
  PiWarningDuotone,
  PiArrowUpDuotone,
  PiArrowDownDuotone
} from "react-icons/pi"
import { useTranslation } from "react-i18next"
import clsx from "clsx"

import { deleteInstallation } from "@domain/installations/delete"
import { installationIconSrc } from "@renderer/utils/installationIcons"

import { useInstallations, useGameVersions, useCustomIcons, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"
import { createDeleteInstallationPorts, describeDeleteInstallationFailure, toInstallationDeleteSnapshot } from "@renderer/features/installations/adapters/delete"
import { useCheckPathExists, useOpenPathInExplorer } from "@renderer/features/installations/hooks/usePathActions"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"
import { LinkButton, NormalButton } from "@renderer/components/ui/Buttons"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

const LOG_TAG = "[front] [installations] [features/installations/pages/ListInstallations.tsx] [ListInslallations > DeleteInstallationHandler]"

function ListInslallations(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installations = useInstallations()
  const gameVersions = useGameVersions()
  const customIcons = useCustomIcons()
  const configDispatch = useConfigDispatch()

  const makeInstallationBackup = useMakeInstallationBackup()
  const checkPathExists = useCheckPathExists()
  const openPathInExplorer = useOpenPathInExplorer()

  const [installationToDelete, setInstallationToDelete] = useState<InstallationType | null>(null)
  const [deleteData, setDeleteData] = useState<boolean>(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function DeleteInstallationHandler(): Promise<void> {
    if (!installationToDelete) return addNotification(t("features.installations.noInstallationSelected"), "error")

    const installation = installationToDelete

    try {
      const result = await deleteInstallation(createDeleteInstallationPorts(), { installation: toInstallationDeleteSnapshot(installation), deleteData })

      if (!result.ok) {
        const { messageKey, logged } = describeDeleteInstallationFailure(result.reason)

        if (logged) {
          window.api.utils.logMessage("error", `${LOG_TAG} Error deleting an Installation.`)
          window.api.utils.logMessage("debug", `${LOG_TAG} Error deleting Installation ${installation.id}: ${result.reason}.`)
        }

        return addNotification(t(messageKey), "error")
      }

      configDispatch({ type: CONFIG_ACTIONS.DELETE_INSTALLATION, payload: { id: installation.id } })

      if (result.failedBackupPaths.length > 0) {
        window.api.utils.logMessage("error", `${LOG_TAG} Installation deleted but some backups survived.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} Backups left over for Installation ${installation.id}: ${result.failedBackupPaths.join(", ")}.`)
        return addNotification(t("features.installations.installationDeletedBackupsLeftOver", { count: result.failedBackupPaths.length }), "warning")
      }

      addNotification(t("features.installations.installationSuccessfullyDeleted"), "success")
    } finally {
      setInstallationToDelete(null)
      setDeleteData(false)
    }
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.installations"), to: "/installations" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <ListWrapper className="max-w-[50rem] w-full my-auto">
          <ListGroup>
            <ListItem className="group">
              <LinkButton to="/installations/add" title={t("features.installations.addNewInstallation")} variant="primary" size="lg" className="w-full h-12">
                <PiPlusCircleDuotone className="text-3xl text-zinc-400/70 group-hover:scale-95 duration-200" />
              </LinkButton>
            </ListItem>

            {installations.map((installation, index) => {
              const isVersionMissing = !gameVersions.some((gv) => gv.version === installation.version)

              return (
                <ListItem key={installation.id}>
                  <div className="h-16 flex gap-2 p-1 justify-between items-center whitespace-nowrap">
                    <img src={installationIconSrc(installation.icon, customIcons)} alt={t("generic.icon")} className="h-full aspect-square object-cover rounded-sm" />

                    <ThinSeparator />

                    <div className="w-full flex flex-col items-start justify-center gap-1 overflow-hidden">
                      <div className="w-full flex gap-1 items-center justify-start">
                        <p className="font-bold">{installation.name}</p>
                      </div>

                      <div className="w-full flex gap-1 items-center justify-start text-sm text-zinc-400">
                        <p>{installation.lastTimePlayed === -1 ? t("generic.notPlayedYet") : new Date(installation.lastTimePlayed).toLocaleString("es")}</p>

                        <span>·</span>

                        <p>{t("generic.totalTime", { total: installation.totalTimePlayed > 1000 ? formatMilliseconds(installation.totalTimePlayed) : "0s" })}</p>
                      </div>
                    </div>

                    <ThinSeparator />

                    <div className="shrink-0 w-22 flex flex-col items-center justify-center gap-1">
                      <p
                        className={clsx("font-bold flex items-center gap-1", isVersionMissing && "text-orange-300")}
                        title={isVersionMissing ? t("features.versions.versionNotInstalled", { version: installation.version }) : undefined}
                      >
                        {isVersionMissing && <PiWarningDuotone className="shrink-0" />}
                        {installation.version}
                      </p>
                      <p className="text-sm">{t("features.mods.modsCount", { count: installation._modsCount as number })}</p>
                    </div>

                    <ThinSeparator />

                    <div className="shrink-0 w-fit h-full flex gap-1 items-center text-lg">
                      <div className="flex flex-col gap-1">
                        <NormalButton
                          className="p-1"
                          title={t("features.installations.moveInstallationUp")}
                          variant="ghost"
                          disabled={index === 0}
                          onClick={() => configDispatch({ type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: installation.id, direction: "up" } })}
                        >
                          <PiArrowUpDuotone />
                        </NormalButton>
                        <NormalButton
                          className="p-1"
                          title={t("features.installations.moveInstallationDown")}
                          variant="ghost"
                          disabled={index === installations.length - 1}
                          onClick={() => configDispatch({ type: CONFIG_ACTIONS.MOVE_INSTALLATION, payload: { id: installation.id, direction: "down" } })}
                        >
                          <PiArrowDownDuotone />
                        </NormalButton>
                      </div>
                      <div className="flex flex-col gap-1">
                        <NormalButton
                          className="p-1"
                          title={t("features.installations.backupInstallation")}
                          variant="ghost"
                          onClick={async () => {
                            if (!(await checkPathExists(installation.path))) return addNotification(t("features.backups.folderDoesntExists"), "error")
                            makeInstallationBackup(installation.id)
                          }}
                        >
                          <PiBoxArrowDownDuotone />
                        </NormalButton>
                        <LinkButton to={`/installations/backups/${installation.id}`} className="p-1" title={t("features.backups.manageBackups")} variant="ghost">
                          <PiArrowCounterClockwiseDuotone />
                        </LinkButton>
                      </div>
                      <div className="flex flex-col gap-1">
                        <LinkButton to={`/installations/mods/${installation.id}`} title={t("features.mods.manageMods")} className="p-1" variant="ghost">
                          <PiWrenchDuotone />
                        </LinkButton>
                        <NormalButton onClick={() => openPathInExplorer(installation.path)} title={`${t("generic.openOnFileExplorer")} · ${installation.path}`} className="p-1" variant="ghost">
                          <PiFolderOpenDuotone />
                        </NormalButton>
                      </div>
                      <div className="flex flex-col gap-1">
                        <LinkButton to={`/installations/edit/${installation.id}`} title={t("features.installations.editInstallation")} className="p-1" variant="ghost">
                          <PiPencilDuotone />
                        </LinkButton>
                        <NormalButton
                          className="p-1"
                          title={t("features.installations.deleteInstallation")}
                          variant="ghost"
                          onClick={async () => {
                            setInstallationToDelete(installation)
                          }}
                        >
                          <PiTrashDuotone />
                        </NormalButton>
                      </div>
                    </div>
                  </div>
                </ListItem>
              )
            })}
          </ListGroup>
        </ListWrapper>

        <PopupDialogPanel title={t("features.installations.deleteInstallation")} isOpen={installationToDelete !== null} close={() => setInstallationToDelete(null)}>
          <>
            <p>{t("features.installations.areYouSureDelete")}</p>
            <p className="text-zinc-400">{t("features.installations.deletingNotReversible")}</p>
            <div className="flex gap-2 items-center justify-center">
              <Input id="delete-data" type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
              <label htmlFor="delete-data">{t("features.installations.deleteData")}</label>
            </div>
            <ButtonsWrapper className="text-lg" bgDark={false} equalWidth>
              <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setInstallationToDelete(null)} variant="secondary" size="md">
                <PiXCircleDuotone />
              </FormButton>
              <FormButton title={t("generic.delete")} className="p-2" onClick={DeleteInstallationHandler} variant="destructive" size="md">
                <PiTrashDuotone />
              </FormButton>
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>
      </div>
    </ScrollableContainer>
  )
}

function formatMilliseconds(milliseconds: number): string {
  let seconds = Math.floor(milliseconds / 1000)

  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60

  let result = ""
  if (hours > 0) result += hours + "h "
  if (minutes > 0) result += minutes + "m "
  if (seconds > 0) result += seconds + "s"

  return result.trim()
}

export default ListInslallations
