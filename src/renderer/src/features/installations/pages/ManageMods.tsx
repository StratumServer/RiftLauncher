import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"

import { CONFIG_ACTIONS, useConfigDispatch, useInstallations, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { useManageInstalledMods } from "@renderer/features/mods/hooks/useManageInstalledMods"
import { useBulkUpdateMods } from "@renderer/features/mods/hooks/useBulkUpdateMods"
import { useModpackImportPicker } from "@renderer/features/mods/hooks/useModpackImportPicker"
import { clearModIconMemoryCache } from "@renderer/features/moddb/adapters/modsManager"

import { useDeleteInstalledModFile } from "@renderer/features/installations/hooks/useDeleteInstalledModFile"
import { useLogMessage } from "@renderer/features/installations/hooks/useLogMessage"

import { ListGroup, ListWrapper } from "@renderer/components/ui/List"
import ModChangeSummaryPopup from "@renderer/features/mods/components/ModChangeSummaryPopup"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import ImportModpackPopup from "@renderer/features/mods/components/ImportModpackPopup"
import InstalledModItem from "@renderer/features/mods/components/InstalledModItem"
import ErrorInstalledModItem from "@renderer/features/mods/components/ErrorInstalledModItem"
import InstalledModsSectionHeader from "@renderer/features/mods/components/InstalledModsSectionHeader"
import ManageModsActionBar from "@renderer/features/mods/components/ManageModsActionBar"
import NoInstalledModsNotice from "@renderer/features/mods/components/NoInstalledModsNotice"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton, ReloadButton } from "@renderer/components/ui/StickyMenu"

const LOG_TAG = "[front] [mods] [features/installations/pages/ManageMods.tsx]"

function byName(a: InstalledModType, b: InstalledModType): number {
  return a.name.localeCompare(b.name)
}

function ListMods(): JSX.Element {
  const { t } = useTranslation()
  const installations = useInstallations()
  const suspendedModUpdates = useSuspendedModUpdates()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const deleteInstalledModFile = useDeleteInstalledModFile()
  const logMessage = useLogMessage()

  const { id } = useParams()

  const installation = installations.find((i) => i.id === id)

  const { installedMods, modsWithErrors, gettingMods, refresh } = useManageInstalledMods(installation)
  const { updateAllMods, summaryEntries, showSummary, closeSummary } = useBulkUpdateMods(installation, installedMods)
  const { manifest: importManifest, pickModpack, clearModpack } = useModpackImportPicker()

  const [modToDelete, setModToDelete] = useState<InstalledModType | ErrorInstalledModType | null>(null)
  const [modToUpdate, setModToUpdate] = useState<InstalledModType | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return (): void => clearModIconMemoryCache()
  }, [])

  // Deliberately blind to suspension: a held-back Mod still belongs under "Mods with updates",
  // because watching for the new version is exactly why the player suspended it (#194).
  const updatableMods = installedMods.filter((iMod) => iMod._updatableTo).sort(byName)
  const incompatibleMods = installedMods.filter((iMod) => !iMod._updatableTo && iMod._lastVersion).sort(byName)
  const upToDateMods = installedMods.filter((iMod) => !iMod._updatableTo && !iMod._lastVersion).sort(byName)

  /** Every list below renders its rows the same way, suspension state and all. */
  function modRow(iMod: InstalledModType): JSX.Element {
    const suspended = suspendedModUpdates.includes(iMod.modid)
    return (
      <InstalledModItem
        key={iMod.modid + iMod.path}
        iMod={iMod}
        suspended={suspended}
        onToggleSuspendClick={() => configDispatch({ type: suspended ? CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE : CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE, payload: { modid: iMod.modid } })}
        onDeleteClick={() => setModToDelete(iMod)}
        onUpdateClick={() => setModToUpdate(iMod)}
      />
    )
  }

  async function DeleteModHandler(): Promise<void> {
    if (!modToDelete) return addNotification(t("features.mods.noModSelected"), "error")

    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")

    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantDeleteWhileinUse"), "error")

    try {
      const deleted = await deleteInstalledModFile(modToDelete.path)
      if (!deleted) throw new Error(`The host refused to delete ${modToDelete.path}.`)

      refresh()

      addNotification(t("features.mods.modSuccessfullyDeleted"), "success")
    } catch (err) {
      logMessage("error", `${LOG_TAG} [DeleteModHandler] Error deleting a mod.`)
      logMessage("debug", `${LOG_TAG} [DeleteModHandler] Error deleting the mod file ${modToDelete.path}: ${err}.`)
      addNotification(t("features.mods.errorDeletingMod"), "error")
    } finally {
      setModToDelete(null)
    }
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/installations" />
              <ReloadButton reloading={gettingMods} onClick={() => refresh()} />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.installations"), to: "/installations" },
                { name: t("breadcrumbs.manageMods"), to: installation ? `/installations/mods/${installation.id}` : "/installations" }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>

          {installation && <ManageModsActionBar installation={installation} installedMods={installedMods} onUpdateAll={updateAllMods} onImportModpack={pickModpack} />}
        </StickyMenuWrapper>

        <div className="max-w-[50rem] w-full flex flex-col items-center justify-center gap-2 m-auto">
          {!installation ? (
            <ListWrapper className="w-full">
              <ListGroup>
                <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
                  <p className="text-2xl">{t("features.installations.noInstallationFound")}</p>
                  <p className="w-full flex gap-1 items-center justify-center">{t("features.installations.noInstallationFoundDesc")}</p>
                </div>
              </ListGroup>
            </ListWrapper>
          ) : (
            <>
              {installation._updatingMods ? (
                <ListWrapper className="w-full">
                  <ListGroup>
                    <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
                      <p className="text-2xl">{t("features.mods.updatingInstalledMods")}</p>
                      <FiLoader className="animate-spin text-4xl text-zinc-400" />
                    </div>
                  </ListGroup>
                </ListWrapper>
              ) : (
                <>
                  {installedMods.length < 1 && modsWithErrors.length < 1 && <NoInstalledModsNotice gettingMods={gettingMods} />}

                  {modsWithErrors.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <InstalledModsSectionHeader
                          titleKey="features.mods.listWithErrorsTitle"
                          descriptionKey="features.mods.modsWithErrorsDescription"
                          reportKey="features.mods.modsWithErrorsDescriptionReport"
                        />
                        {modsWithErrors.map((iModE) => (
                          <ErrorInstalledModItem key={iModE.zipname + iModE.zipname} iModE={iModE} onDeleteClick={() => setModToDelete(iModE)} />
                        ))}
                      </ListGroup>
                    </ListWrapper>
                  )}

                  {updatableMods.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <InstalledModsSectionHeader
                          titleKey="features.mods.listWithUpdatesTitle"
                          descriptionKey="features.mods.modsWithUpdatesDescription"
                          reportKey="features.mods.modsWithUpdatesDescriptionReport"
                        />
                        {updatableMods.map(modRow)}
                      </ListGroup>
                    </ListWrapper>
                  )}

                  {incompatibleMods.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <InstalledModsSectionHeader
                          titleKey="features.mods.listWithIncompatibleUpdatesTitle"
                          descriptionKey="features.mods.modsWithIncompatibleUpdatesDescription"
                          reportKey="features.mods.modsWithUpdatesDescriptionReport"
                        />
                        {incompatibleMods.map(modRow)}
                      </ListGroup>
                    </ListWrapper>
                  )}

                  {upToDateMods.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>{upToDateMods.map(modRow)}</ListGroup>
                    </ListWrapper>
                  )}

                  <InstallModPopup
                    modToInstall={modToUpdate?.modid || null}
                    setModToInstall={() => setModToUpdate(null)}
                    modName={modToUpdate?.name}
                    installation={{
                      installation: installation,
                      oldMod: installedMods.find((iMod) => iMod.modid === modToUpdate?.modid)
                    }}
                    onFinishInstallation={() => {
                      refresh()
                    }}
                  />

                  <ImportModpackPopup
                    isOpen={importManifest !== null}
                    manifest={importManifest}
                    close={clearModpack}
                    installation={installation}
                    installedMods={installedMods}
                    onFinish={() => {
                      clearModpack()
                      refresh()
                    }}
                  />

                  <ModChangeSummaryPopup
                    isOpen={showSummary}
                    close={() => {
                      closeSummary()
                      refresh()
                    }}
                    title={t("features.mods.updateSummaryTitle")}
                    entries={summaryEntries}
                  />

                  <PopupDialogPanel title={t("features.mods.deleteMod")} isOpen={modToDelete !== null} close={() => setModToDelete(null)}>
                    <>
                      <p>{t("features.mods.areYouSureDelete")}</p>
                      <p className="text-zinc-400">{t("features.mods.deletingNotReversible")}</p>
                      <div className="flex gap-4 items-center justify-center text-lg">
                        <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setModToDelete(null)} type="success">
                          <PiXCircleDuotone />
                        </FormButton>
                        <FormButton title={t("generic.delete")} className="p-2" onClick={DeleteModHandler} type="error">
                          <PiTrashDuotone />
                        </FormButton>
                      </div>
                    </>
                  </PopupDialogPanel>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ScrollableContainer>
  )
}

export default ListMods
