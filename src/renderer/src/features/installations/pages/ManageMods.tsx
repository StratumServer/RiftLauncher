import { useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"
import { PiFunnelDuotone } from "react-icons/pi"

import { useInstallations, useSuspendedModUpdates } from "@renderer/features/config/contexts/ConfigContext"

import { useManageInstalledMods } from "@renderer/features/mods/hooks/useManageInstalledMods"
import { useBulkUpdateMods } from "@renderer/features/mods/hooks/useBulkUpdateMods"
import { useModpackImportPicker } from "@renderer/features/mods/hooks/useModpackImportPicker"
import { useInstalledModActions } from "@renderer/features/mods/hooks/useInstalledModActions"
import { useModBatchActions } from "@renderer/features/mods/hooks/useModBatchActions"
import { useModProfiles } from "@renderer/features/mods/hooks/useModProfiles"
import { clearModIconMemoryCache } from "@renderer/features/moddb/adapters/modsManager"

import { modByArchivePath } from "@domain/mods/scanInstalled"
import { modsFolderInUse } from "@domain/mods/install"
import {
  countActiveInstalledModFilters,
  filterInstalledMods,
  hasActiveInstalledModFilters,
  installedModAuthors,
  installedModGameVersions,
  installedModTags,
  matchesModSearch,
  NO_INSTALLED_MOD_FILTERS,
  sameModid
} from "@domain/mods/installedFilters"
import type { InstalledModFilters } from "@domain/mods/installedFilters"

import { ListGroup, ListWrapper } from "@renderer/components/ui/List"
import ModChangeSummaryPopup from "@renderer/features/mods/components/ModChangeSummaryPopup"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import ImportModpackPopup from "@renderer/features/mods/components/ImportModpackPopup"
import DeleteModDialog from "@renderer/features/mods/components/DeleteModDialog"
import InstalledModItem from "@renderer/features/mods/components/InstalledModItem"
import InstalledModDetails from "@renderer/features/mods/components/InstalledModDetails"
import ErrorInstalledModItem from "@renderer/features/mods/components/ErrorInstalledModItem"
import InstalledModsSectionHeader from "@renderer/features/mods/components/InstalledModsSectionHeader"
import ManageModsActionBar from "@renderer/features/mods/components/ManageModsActionBar"
import ManageModsSelectionBar from "@renderer/features/mods/components/ManageModsSelectionBar"
import ModProfilesPopup from "@renderer/features/mods/components/ModProfilesPopup"
import InstalledModsFilterBar from "@renderer/features/mods/components/InstalledModsFilterBar"
import ModHealthPanel from "@renderer/features/mods/components/ModHealthPanel"
import NoInstalledModsNotice from "@renderer/features/mods/components/NoInstalledModsNotice"
import ServerModsSection from "@renderer/features/mods/components/ServerModsSection"
import { FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton, ReloadButton } from "@renderer/components/ui/StickyMenu"

function byName(a: InstalledModType, b: InstalledModType): number {
  return a.name.localeCompare(b.name)
}

function ListMods(): JSX.Element {
  const { t } = useTranslation()
  const installations = useInstallations()
  const suspendedModUpdates = useSuspendedModUpdates()

  const { id } = useParams()

  const installation = installations.find((i) => i.id === id)

  const { installedMods, modsWithErrors, gettingMods, refresh } = useManageInstalledMods(installation)

  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<InstalledModFilters>(NO_INSTALLED_MOD_FILTERS)
  // Collapsed on every fresh visit: the three dropdowns are what pushed the Mod list off the first
  // screen (#431). Search stays out of this, so narrowing by name never needs the extra click.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeFilterCount = countActiveInstalledModFilters(filters)

  // Rebuilt only when the scan changes, not on every keystroke in the search field: each is a fresh
  // array identity, and the dropdowns below sit next to rows this page already memoizes.
  const allAuthors = useMemo(() => installedModAuthors(installedMods), [installedMods])
  const allTags = useMemo(() => installedModTags(installedMods), [installedMods])
  const allGameVersions = useMemo(() => installedModGameVersions(installedMods), [installedMods])

  // One list feeds everything below: the three sections, and the buttons that act on the folder at
  // once. What a player sees is what those buttons touch, filtered or not (#228).
  const query = search.trim().toLowerCase()
  const textFiltered = query ? installedMods.filter((iMod) => matchesModSearch(iMod, query)) : installedMods
  const visibleMods = filterInstalledMods(textFiltered, filters)
  // Unreadable archives carry no author, tag or game version, so the three dropdowns have nothing to
  // judge them by and leave them alone. Only the text query narrows them, by file name.
  const visibleModsWithErrors = query ? modsWithErrors.filter((iModE) => iModE.zipname.toLowerCase().includes(query)) : modsWithErrors
  const hasActiveFilters = hasActiveInstalledModFilters(filters)
  const nothingMatches = (query.length > 0 || hasActiveFilters) && visibleMods.length < 1 && visibleModsWithErrors.length < 1

  const { updateAllMods, summaryEntries, showSummary, closeSummary } = useBulkUpdateMods(installation)
  const { manifest: importManifest, pickModpack, clearModpack } = useModpackImportPicker()

  const actions = useInstalledModActions(installation, refresh)
  const batch = useModBatchActions(installation, installedMods, visibleMods, refresh)
  // Handed the Installation only, never the filtered list: a profile records and applies the whole folder.
  const profiles = useModProfiles(installation)
  // One predicate for every surface that writes the whole Mods folder. Each of those write paths
  // already refuses on modsFolderInUse, so a control that would be refused has to read as off:
  // Import Modpack used to stay live through Update all and only refuse after the player had been
  // through the native file dialog.
  const folderInUse = installation ? modsFolderInUse(installation) : false
  const [profilesOpen, setProfilesOpen] = useState(false)
  // A mod id and a name, not a Mod: the install popup already takes a mod id and finds the installed
  // copy itself, so the health panel can point it at a dependency nobody has installed yet.
  const [modToUpdate, setModToUpdate] = useState<{ modid: string; name?: string } | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // The details panel remembers a path, not a Mod: every scan hands back fresh objects.
  const [detailsPath, setDetailsPath] = useState<string | null>(null)
  const [detailsFocusRequest, setDetailsFocusRequest] = useState(0)
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailsButtons = useRef(new Map<string, HTMLDivElement>())

  // Derived against what the player can see, so the panel always describes a row on screen and
  // closing it always has a row to hand focus back to. Update all swaps every row for its spinner, so
  // the panel goes with them. The path outlives a filter that hides the row, so the panel comes back
  // with it. Following the path's other suffix form keeps the panel on a Mod through an enable or
  // disable, whoever renamed the archive.
  const detailsMod = detailsPath === null || installation?._updatingMods ? undefined : modByArchivePath(visibleMods, detailsPath)

  // A Mod that has left the folder is gone for good: a file of the same name coming back later is not
  // the player asking to see it again. Only the whole scan decides this, never what a filter hides.
  useEffect(() => {
    if (detailsPath !== null && !modByArchivePath(installedMods, detailsPath)) setDetailsPath(null)
  }, [installedMods, detailsPath])

  // Keyed on a counter, never on the path or the panel mounting: a rename after an enable or disable,
  // or the panel coming back when a filter clears, must not pull focus away from where the player has it.
  useEffect(() => {
    if (detailsFocusRequest > 0) detailsHeadingRef.current?.focus()
  }, [detailsFocusRequest])

  useEffect(() => {
    return (): void => clearModIconMemoryCache()
  }, [])

  function closeDetails(): void {
    if (detailsMod) detailsButtons.current.get(detailsMod.path)?.focus()
    setDetailsPath(null)
  }

  function toggleDetails(iMod: InstalledModType): void {
    if (detailsMod?.path === iMod.path) return closeDetails()
    setDetailsPath(iMod.path)
    setDetailsFocusRequest((request) => request + 1)
  }

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
        busy={actions.isBusy(iMod.path) || (batch.running && batch.isChecked(iMod.path))}
        checked={batch.isChecked(iMod.path)}
        distinctName={batch.labelOf(iMod)}
        onCheckedChange={(checked) => batch.setChecked(iMod.path, checked)}
        onToggleEnabledClick={() => actions.toggleEnabled(iMod)}
        onToggleSuspendClick={() => actions.toggleSuspended(iMod.modid)}
        onDeleteClick={() => actions.requestDelete(iMod)}
        onUpdateClick={() => setModToUpdate(iMod)}
        detailsOpen={iMod.path === detailsMod?.path}
        onToggleDetails={() => toggleDetails(iMod)}
        detailsButtonRef={(element) => {
          if (element) detailsButtons.current.set(iMod.path, element)
          else detailsButtons.current.delete(iMod.path)
        }}
      />
    )
  }

  const list = (
    <ScrollableContainer ref={scrollRef} className="flex-1 min-w-0">
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
              <ManageModsActionBar
                installation={installation}
                installedMods={visibleMods}
                onUpdateAll={() => updateAllMods(visibleMods)}
                onImportModpack={pickModpack}
                activeProfileName={profiles.activeProfile?.name}
                onOpenProfiles={() => setProfilesOpen(true)}
                busy={folderInUse || batch.running || profiles.switchingTo !== null}
              />

              {installedMods.length + modsWithErrors.length > 0 && (
                <StickyMenuGroupWrapper type="centered">
                  <StickyMenuGroup>
                    <FormInputText placeholder={t("features.mods.searchInstalledMods")} value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 h-8" />

                    {/* One mod is nothing to narrow, so the toggle stays off until there are two. */}
                    {installedMods.length > 1 && (
                      <FormButton
                        title={t("features.mods.filtersToggle")}
                        variant="secondary"
                        className="p-1 w-fit h-8"
                        onClick={() => setFiltersOpen((current) => !current)}
                        ariaExpanded={filtersOpen}
                      >
                        <PiFunnelDuotone className="text-xl" />
                        <p>{t("features.mods.filtersToggleButton", { count: activeFilterCount })}</p>
                      </FormButton>
                    )}
                  </StickyMenuGroup>

                  {installedMods.length > 1 && filtersOpen && (
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

              {/*
               * Still gated on _updatingMods alone, not on folderInUse: this bar is hidden because
               * Update all swaps every row for a spinner, so there is nothing left to select. A
               * backup or a restore leaves the rows there, and Suspend, which writes config rather
               * than the folder, has to stay reachable through one (manageMods.test.tsx:1946).
               */}
              {installedMods.length > 0 && !installation._updatingMods && <ManageModsSelectionBar batch={batch} shownCount={visibleMods.length} locked={actions.busyPaths.length > 0} />}
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
              {/* Mounted outside the busy branch: a switch sets _updatingMods, and the dialog that started it stays open. */}
              <ModProfilesPopup isOpen={profilesOpen} close={() => setProfilesOpen(false)} profiles={profiles} locked={batch.running || actions.busyPaths.length > 0} />

              {profiles.status === "ready" && profiles.profiles.length > 0 && !profiles.activeProfile && (
                <p role="status" className="w-full text-center">
                  {t("features.mods.noProfileActive")}
                </p>
              )}

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

                  {/*
                   * Judged against the whole folder rather than the filtered list: a dependency a
                   * search hides is still missing, and this says what the Installation is, not what
                   * is on screen. Its Update all is handed that same whole folder, so the button
                   * under a heading cannot do less than the lines above it just listed. It is above
                   * "Mods with errors" because it is the one thing here that says the game may not
                   * start.
                   */}
                  <ModHealthPanel
                    installedMods={installedMods}
                    unreadableCount={modsWithErrors.length}
                    gameVersion={installation.version}
                    suspended={suspendedModUpdates}
                    labelOf={batch.labelOf}
                    actions={actions}
                    onUpdate={setModToUpdate}
                    onUpdateAll={() => updateAllMods(installedMods)}
                  />

                  {visibleModsWithErrors.length > 0 && (
                    <ListWrapper className="w-full">
                      <ListGroup>
                        <InstalledModsSectionHeader
                          titleKey="features.mods.listWithErrorsTitle"
                          descriptionKey="features.mods.modsWithErrorsDescription"
                          reportKey="features.mods.modsWithErrorsDescriptionReport"
                        />
                        {visibleModsWithErrors.map((iModE) => (
                          <ErrorInstalledModItem key={iModE.zipname + iModE.zipname} iModE={iModE} onDeleteClick={() => actions.requestDelete(iModE)} />
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

                  {/* Last, and only when the game has actually downloaded something: these are not
                      the Mods the player came here to manage, they are the ones they did not know
                      they had. Nothing above reads them. */}
                  <ServerModsSection installation={installation} search={query} />

                  <InstallModPopup
                    modToInstall={modToUpdate?.modid || null}
                    setModToInstall={() => setModToUpdate(null)}
                    modName={modToUpdate?.name}
                    installation={{
                      installation: installation,
                      // Case-folded, because this no longer only ever receives a mod id read off an
                      // installed copy: the Installation check points the popup at a dependency id
                      // as the declaring author typed it, and the check itself matches those without
                      // regard for case. An exact compare missed the copy being replaced, so the
                      // fix for an outdated dependency left the old archive next to the new one and
                      // the next scan reported the pair as a duplicate mod id.
                      oldMod: modToUpdate ? installedMods.find((iMod) => sameModid(iMod.modid, modToUpdate.modid)) : undefined
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

                  <DeleteModDialog
                    isOpen={actions.modToDelete !== null}
                    close={actions.cancelDelete}
                    onConfirm={() => {
                      // Closed here, not left to the rescan: the path would follow a disabled twin of
                      // the deleted archive (#292) and move the panel onto a file the player never opened.
                      if (actions.modToDelete?.path === detailsMod?.path) setDetailsPath(null)
                      return actions.confirmDelete()
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ScrollableContainer>
  )

  // The row is there with or without the panel, with the list always first in it: mounting the row
  // only for the panel would remount the list and lose its scroll position on every open and close.
  return (
    <div className="w-full h-full flex">
      {list}
      {installation && detailsMod && <InstalledModDetails iMod={detailsMod} gameVersion={installation.version} headingRef={detailsHeadingRef} onClose={closeDetails} />}
    </div>
  )
}

export default ListMods
