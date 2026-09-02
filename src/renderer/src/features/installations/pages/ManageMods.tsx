import { useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"

import { CONFIG_ACTIONS, useConfigDispatch, useInstallations, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { useManageInstalledMods } from "@renderer/features/mods/hooks/useManageInstalledMods"
import { useBulkUpdateMods } from "@renderer/features/mods/hooks/useBulkUpdateMods"
import { useModpackImportPicker } from "@renderer/features/mods/hooks/useModpackImportPicker"
import { clearModIconMemoryCache, setModEnabled } from "@renderer/features/moddb/adapters/modsManager"

import { createFileSystemPort } from "@renderer/adapters/fileSystem"

import { filterInstalledMods, hasActiveInstalledModFilters, installedModAuthors, installedModGameVersions, installedModTags, NO_INSTALLED_MOD_FILTERS } from "@domain/mods/installedFilters"
import type { InstalledModFilters } from "@domain/mods/installedFilters"

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
import InstalledModsFilterBar from "@renderer/features/mods/components/InstalledModsFilterBar"
import NoInstalledModsNotice from "@renderer/features/mods/components/NoInstalledModsNotice"
import { ButtonsWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton, ReloadButton } from "@renderer/components/ui/StickyMenu"

const LOG_TAG = "[front] [mods] [features/installations/pages/ManageMods.tsx]"

function byName(a: InstalledModType, b: InstalledModType): number {
  return a.name.localeCompare(b.name)
}

/** What the player types matched against what they can see of a Mod: its name, id, or author. */
function matchesSearch(iMod: InstalledModType, search: string): boolean {
  return iMod.name.toLowerCase().includes(search) || iMod.modid.toLowerCase().includes(search) || (iMod.authors?.some((author) => author.toLowerCase().includes(search)) ?? false)
}

function ListMods(): JSX.Element {
  const { t } = useTranslation()
  const installations = useInstallations()
  const suspendedModUpdates = useSuspendedModUpdates()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const { id } = useParams()

  const installation = installations.find((i) => i.id === id)

  const { installedMods, modsWithErrors, gettingMods, refresh } = useManageInstalledMods(installation)

  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<InstalledModFilters>(NO_INSTALLED_MOD_FILTERS)

  // Rebuilt only when the scan changes, not on every keystroke in the search field: each is a fresh
  // array identity, and the dropdowns below sit next to rows this page already memoizes.
  const allAuthors = useMemo(() => installedModAuthors(installedMods), [installedMods])
  const allTags = useMemo(() => installedModTags(installedMods), [installedMods])
  const allGameVersions = useMemo(() => installedModGameVersions(installedMods), [installedMods])

  // One list feeds everything below: the three sections, and the buttons that act on the folder at
  // once. What a player sees is what those buttons touch, filtered or not (#228).
  const query = search.trim().toLowerCase()
  const textFiltered = query ? installedMods.filter((iMod) => matchesSearch(iMod, query)) : installedMods
  const visibleMods = filterInstalledMods(textFiltered, filters)
  // Unreadable archives carry no author, tag or game version, so the three dropdowns have nothing to
  // judge them by and leave them alone. Only the text query narrows them, by file name.
  const visibleModsWithErrors = query ? modsWithErrors.filter((iModE) => iModE.zipname.toLowerCase().includes(query)) : modsWithErrors
  const hasActiveFilters = hasActiveInstalledModFilters(filters)
  const nothingMatches = (query.length > 0 || hasActiveFilters) && visibleMods.length < 1 && visibleModsWithErrors.length < 1

  const { updateAllMods, summaryEntries, showSummary, closeSummary } = useBulkUpdateMods(installation, visibleMods)
  const { manifest: importManifest, pickModpack, clearModpack } = useModpackImportPicker()

  const [modToDelete, setModToDelete] = useState<InstalledModType | ErrorInstalledModType | null>(null)
  const [modToUpdate, setModToUpdate] = useState<InstalledModType | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // The ref is the guard and the state is only what paints it. A second click lands before React has
  // rendered anything, so the thing it has to be tested against is written synchronously.
  const togglingPathsRef = useRef(new Set<string>())
  const [togglingPaths, setTogglingPaths] = useState<string[]>([])

  useEffect(() => {
    return (): void => clearModIconMemoryCache()
  }, [])

  // Deliberately blind to suspension: a held-back Mod still belongs under "Mods with updates",
  // because watching for the new version is exactly why the player suspended it (#194).
  const updatableMods = visibleMods.filter((iMod) => iMod._updatableTo).sort(byName)
  const incompatibleMods = visibleMods.filter((iMod) => !iMod._updatableTo && iMod._lastVersion).sort(byName)
  const upToDateMods = visibleMods.filter((iMod) => !iMod._updatableTo && !iMod._lastVersion).sort(byName)

  /** Every list below renders its rows the same way, suspension state and all. */
  function modRow(iMod: InstalledModType): JSX.Element {
    const suspended = suspendedModUpdates.includes(iMod.modid)
    return (
      <InstalledModItem
        key={iMod.modid + iMod.path}
        iMod={iMod}
        suspended={suspended}
        busy={togglingPaths.includes(iMod.path)}
        onToggleEnabledClick={() => ToggleModEnabledHandler(iMod)}
        onToggleSuspendClick={() => configDispatch({ type: suspended ? CONFIG_ACTIONS.REMOVE_SUSPENDED_MOD_UPDATE : CONFIG_ACTIONS.ADD_SUSPENDED_MOD_UPDATE, payload: { modid: iMod.modid } })}
        onDeleteClick={() => setModToDelete(iMod)}
        onUpdateClick={() => setModToUpdate(iMod)}
      />
    )
  }

  /**
   * Turns one Mod on or off, then rescans.
   *
   * The rescan is not optional and it is not a nicety: the archive's name is its path, so a Mod that
   * just changed state is a different file from the one this row is holding, and every button on
   * that row would still be pointing at a name that no longer exists.
   *
   * Which is also why the second of two quick clicks has to be dropped rather than sent: it would
   * carry the name the first one just renamed away, and the player would be told the same action
   * both succeeded and failed. The row's own buttons stay disabled until the rescan is in.
   */
  async function ToggleModEnabledHandler(iMod: InstalledModType): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")

    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantToggleWhileinUse"), "error")

    if (togglingPathsRef.current.has(iMod.path)) return
    togglingPathsRef.current.add(iMod.path)
    setTogglingPaths([...togglingPathsRef.current])

    try {
      const result = await setModEnabled(iMod.path, !iMod.enabled)

      if (result.ok) {
        addNotification(t(iMod.enabled ? "features.mods.modDisabled" : "features.mods.modEnabled", { mod: iMod.name }), "success")
      } else {
        window.api.utils.logMessage("error", `${LOG_TAG} [ToggleModEnabledHandler] Could not turn the ${iMod.name} Mod ${iMod.enabled ? "off" : "on"}.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} [ToggleModEnabledHandler] Renaming ${iMod.path} was refused: ${result.reason}.`)
        addNotification(t(result.reason === "name-taken" ? "features.mods.modNameTaken" : "features.mods.errorTogglingMod", { mod: iMod.name }), "error")
      }

      await refresh()
    } finally {
      togglingPathsRef.current.delete(iMod.path)
      setTogglingPaths([...togglingPathsRef.current])
    }
  }

  async function DeleteModHandler(): Promise<void> {
    if (!modToDelete) return addNotification(t("features.mods.noModSelected"), "error")

    if (!installation) return addNotification(t("features.installations.noInstallationFound"), "error")

    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantDeleteWhileinUse"), "error")

    try {
      const deleted = await createFileSystemPort().remove(modToDelete.path)
      if (!deleted) throw new Error(`The host refused to delete ${modToDelete.path}.`)

      refresh()

      addNotification(t("features.mods.modSuccessfullyDeleted"), "success")
    } catch (err) {
      window.api.utils.logMessage("error", `${LOG_TAG} [DeleteModHandler] Error deleting a mod.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} [DeleteModHandler] Error deleting the mod file ${modToDelete.path}: ${err}.`)
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

          {installation && (
            <>
              <ManageModsActionBar installation={installation} installedMods={visibleMods} onUpdateAll={updateAllMods} onImportModpack={pickModpack} />

              {installedMods.length + modsWithErrors.length > 0 && (
                <StickyMenuGroupWrapper type="centered">
                  <StickyMenuGroup>
                    <FormInputText placeholder={t("features.mods.searchInstalledMods")} value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 h-8" />
                  </StickyMenuGroup>

                  {/* One mod is nothing to narrow, so the bar stays off until there are two. */}
                  {installedMods.length > 1 && (
                    <InstalledModsFilterBar
                      filters={filters}
                      setFilters={setFilters}
                      authors={allAuthors}
                      tags={allTags}
                      gameVersions={allGameVersions}
                      onClearFilters={() => setFilters(NO_INSTALLED_MOD_FILTERS)}
                    />
                  )}
                </StickyMenuGroupWrapper>
              )}
            </>
          )}
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

                  {nothingMatches && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
                          <p className="text-2xl">{t("features.mods.noMatchingFilters")}</p>
                        </div>
                      </ListGroup>
                    </ListWrapper>
                  )}

                  {visibleModsWithErrors.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <InstalledModsSectionHeader
                          titleKey="features.mods.listWithErrorsTitle"
                          descriptionKey="features.mods.modsWithErrorsDescription"
                          reportKey="features.mods.modsWithErrorsDescriptionReport"
                        />
                        {visibleModsWithErrors.map((iModE) => (
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
                      <ButtonsWrapper className="text-lg" bgDark={false} equalWidth>
                        <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setModToDelete(null)} variant="secondary" size="md">
                          <PiXCircleDuotone />
                        </FormButton>
                        <FormButton title={t("generic.delete")} className="p-2" onClick={DeleteModHandler} variant="destructive" size="md">
                          <PiTrashDuotone />
                        </FormButton>
                      </ButtonsWrapper>
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
