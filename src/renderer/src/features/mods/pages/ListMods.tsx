import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, type Dispatch, type SetStateAction } from "react"
import { Trans, useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { useInstallations, useFavMods, useSettingsConfig, useConfigDispatch, useSuspendedModUpdates, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"

import { useQueryMods } from "@renderer/features/mods/hooks/useQueryMods"
import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"
import { installedModLookups } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"
import { useInstalledModActions } from "@renderer/features/mods/hooks/useInstalledModActions"
import { useQueryMod } from "@renderer/features/mods/hooks/useQueryMod"
import { useSyncModsCount } from "@renderer/features/mods/hooks/useSyncModsCount"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { useExternalLinks } from "@renderer/features/mods/hooks/useExternalLinks"

import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { LinkButton } from "@renderer/components/ui/Buttons"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, ReloadButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"
import ModsFilterBar from "@renderer/features/mods/components/ModsFilterBar"
import ModsGrid from "@renderer/features/mods/components/ModsGrid"
import DeleteModDialog from "@renderer/features/mods/components/DeleteModDialog"
import type { ModCardAction } from "@renderer/features/mods/components/ModListCard"
import { DEFAULT_LOADED_MODS, getModsBrowseState, updateModsBrowseState, type ModsBrowseState } from "@renderer/features/mods/modsBrowseState"
import { installedCopiesOf } from "@domain/mods/installedFilters"
import { findModUpdate } from "@domain/mods/compatibility"

function ListMods(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const installations = useInstallations()
  const favMods = useFavMods()
  const suspendedModUpdates = useSuspendedModUpdates()
  const { lastUsedInstallation } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const queryMods = useQueryMods()
  const getInstalledMods = useGetInstalledMods()
  const queryMod = useQueryMod()
  const syncModsCount = useSyncModsCount()
  const { openModOnModDb } = useExternalLinks()
  const { tasks } = useTaskContext()

  const browseStateRef = useRef<ModsBrowseState | null>(null)
  if (!browseStateRef.current) browseStateRef.current = getModsBrowseState()
  const browseState = browseStateRef.current
  const restoreBrowseRef = useRef(browseState.scrollTop > 0 || browseState.visibleMods > DEFAULT_LOADED_MODS)

  const [modsList, setModsList] = useState<DownloadableModOnListType[]>([])
  const [visibleMods, setVisibleModsState] = useState<number>(browseState.visibleMods)

  // Derived (not copied into state) so an EDIT_INSTALLATION on the current
  // installation (e.g. its mods count) shows up immediately, without needing
  // lastUsedInstallation itself to change.
  const installation = useMemo(() => installations.find((i) => i.id === lastUsedInstallation), [installations, lastUsedInstallation])

  const [installationInstalledMods, setInstallationInstalledMods] = useState<InstalledModType[] | undefined>(undefined)
  const installationModsLoadedRef = useRef(false)

  // The fast scan is this page's refresh: a folder read, with none of the ModDB lookups the
  // Manage Mods scan makes for every installed Mod.
  const actions = useInstalledModActions(installation, triggerGetInstalledMods)

  const [modDetails, setModDetails] = useState<ReadonlyMap<number, DownloadableModType>>(() => new Map())
  const requestedModDetails = useRef(new Set<number>())

  const [onlyFav, setOnlyFavState] = useState<boolean>(browseState.onlyFav)
  const [textFilter, setTextFilterState] = useState<string>(browseState.textFilter)
  const [authorFilter, setAuthorFilterState] = useState<DownloadableModAuthorType>(browseState.authorFilter)
  const [versionsFilter, setVersionsFilterState] = useState<DownloadableModGameVersionType[]>(browseState.versionsFilter)
  const [tagsFilter, setTagsFilterState] = useState<DownloadableModTagType[]>(browseState.tagsFilter)
  const [sideFilter, setSideFilterState] = useState<string>(browseState.sideFilter)
  const [installedFilter, setInstalledFilterState] = useState<string>(browseState.installedFilter)
  const [orderBy, setOrderByState] = useState<string>(browseState.orderBy)
  const [orderByOrder, setOrderByOrderState] = useState<string>(browseState.orderByOrder)

  const [searching, setSearching] = useState<boolean>(true)

  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const queryTokenRef = useRef<number>(0)

  function resetBrowsePosition(): void {
    restoreBrowseRef.current = false
    scrollRef.current?.scrollTo({ top: 0 })
    updateModsBrowseState({ visibleMods: DEFAULT_LOADED_MODS, scrollTop: 0 })
    setVisibleModsState(DEFAULT_LOADED_MODS)
  }

  /**
   * Sets one filter, and resets the browse position when it actually changes.
   *
   * The next value is resolved against the rendered one here, in the event, rather than inside a
   * state updater: an updater runs during render (twice under StrictMode) and is no place for a
   * scroll or a store write. Every caller sets a given filter at most once per event, so the
   * rendered value is the one the change applies to.
   */
  function updateFilter<T>(current: T, setter: Dispatch<SetStateAction<T>>, value: SetStateAction<T>, update: (next: T) => Partial<ModsBrowseState>): void {
    const next = typeof value === "function" ? (value as (previous: T) => T)(current) : value
    if (next === current) return
    resetBrowsePosition()
    updateModsBrowseState(update(next))
    setter(next)
  }

  const setTextFilter: Dispatch<SetStateAction<string>> = (value) => updateFilter(textFilter, setTextFilterState, value, (next) => ({ textFilter: next }))
  const setAuthorFilter: Dispatch<SetStateAction<DownloadableModAuthorType>> = (value) => updateFilter(authorFilter, setAuthorFilterState, value, (next) => ({ authorFilter: next }))
  const setVersionsFilter: Dispatch<SetStateAction<DownloadableModGameVersionType[]>> = (value) => updateFilter(versionsFilter, setVersionsFilterState, value, (next) => ({ versionsFilter: next }))
  const setTagsFilter: Dispatch<SetStateAction<DownloadableModTagType[]>> = (value) => updateFilter(tagsFilter, setTagsFilterState, value, (next) => ({ tagsFilter: next }))
  const setSideFilter: Dispatch<SetStateAction<string>> = (value) => updateFilter(sideFilter, setSideFilterState, value, (next) => ({ sideFilter: next }))
  const setInstalledFilter: Dispatch<SetStateAction<string>> = (value) => updateFilter(installedFilter, setInstalledFilterState, value, (next) => ({ installedFilter: next }))
  const setOnlyFav: Dispatch<SetStateAction<boolean>> = (value) => updateFilter(onlyFav, setOnlyFavState, value, (next) => ({ onlyFav: next }))
  const setOrderBy: Dispatch<SetStateAction<string>> = (value) => updateFilter(orderBy, setOrderByState, value, (next) => ({ orderBy: next }))
  const setOrderByOrder: Dispatch<SetStateAction<string>> = (value) => updateFilter(orderByOrder, setOrderByOrderState, value, (next) => ({ orderByOrder: next }))

  const handleScroll = (): void => {
    if (!scrollRef.current) return
    const { scrollTop, clientHeight, scrollHeight } = scrollRef.current
    updateModsBrowseState({ scrollTop })
    if (scrollTop + clientHeight >= scrollHeight - (clientHeight / 2 + 100))
      setVisibleModsState((prev) => {
        const next = prev + 10
        updateModsBrowseState({ visibleMods: next })
        return next
      })
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.addEventListener("scroll", handleScroll)

    return (): void => {
      // scrollRef is the ScrollableContainer's own ref, stable for ListMods' whole mounted
      // life; the element this attaches to and the element this detaches from are always
      // the same node, so a value read at cleanup time can never differ from the one the
      // listener was actually added to.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (scrollRef.current) scrollRef.current.removeEventListener("scroll", handleScroll)
    }
  }, [])

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)

    timeoutRef.current = setTimeout(async () => {
      await triggerQueryMods()
      timeoutRef.current = null
    }, 400)

    return (): void => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
    // triggerQueryMods is a plain function redeclared every render, not a useCallback: it
    // always closes over this render's own filter values, so calling it from here already
    // reads the current textFilter/authorFilter/etc. Listing it as a dependency would only
    // make this effect refire on ListMods' own re-renders, not on anything it doesn't
    // already refire on through the filters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textFilter, authorFilter, versionsFilter, tagsFilter, sideFilter, installedFilter, onlyFav, orderBy, orderByOrder])

  // Keyed on id/path, not on `installation` itself: triggerGetInstalledMods calls
  // syncModsCount, which writes _modsCount back onto this same installation and
  // hands useMemo a new object every time, matching value or not. Depending on the
  // whole object would refire this effect on that write, syncModsCount would write
  // again, and so on forever. id/path are the only fields the fetch below cares
  // about, and they settle once the installation and its Mods folder stop changing.
  useEffect(() => {
    if (!installation) return setInstallationInstalledMods([])
    triggerGetInstalledMods()
    // triggerGetInstalledMods is excluded for the same reason as the effects above: a plain
    // function redeclared every render, already closing over the current `installation`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installation?.id, installation?.path])

  /*
   * A mod install queues a download and leaves this page mounted: the install page navigates back
   * here the moment the transfer starts, so the scan above ran before the archive existed and the
   * grid's installed markers stay wrong until the player reloads by hand. The download task
   * reaching "completed" is what says the archive is on disk (the task is completed by the
   * resolved download, not by a progress tick), so the markers are re-read on that.
   *
   * The effect observes task IDs rather than a count. The task list is rebuilt on every progress
   * tick, but a folder scan happens only when a new ID enters the completed set. IDs also avoid
   * losing a completion when a finished task is removed in the same render that another finishes.
   * The ref is seeded from the first render, so finished downloads already present in the list do
   * not cause a second scan on top of the mount scan above.
   *
   * This cannot feed itself the way the effect above could: triggerGetInstalledMods writes
   * _modsCount back through syncModsCount, which hands useMemo a new installation object, but
   * nothing it writes reaches the task list, so the value this effect keys on does not move.
   */
  const completedDownloadIds = tasks.filter((task) => task.type === "download" && task.status === "completed").map((task) => task.id)
  const seenCompletedDownloadIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    const completedIds = new Set(completedDownloadIds)
    const previousCompletedIds = seenCompletedDownloadIds.current
    seenCompletedDownloadIds.current = completedIds
    const finishedSinceLastScan = previousCompletedIds !== null && [...completedIds].some((id) => !previousCompletedIds.has(id))
    // The guard is not decoration: triggerGetInstalledMods raises an error toast when there is no
    // installation, and a download finishing is no reason to tell the player that.
    if (!finishedSinceLastScan || !installation) return
    triggerGetInstalledMods()
    // triggerGetInstalledMods and `installation` are excluded for the same reason as the effects
    // above: a plain function redeclared every render, already closing over the current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, installation?.id, installation?.path])

  useEffect(() => {
    if (installationInstalledMods === undefined) return

    if (!installationModsLoadedRef.current || installedFilter !== "all") triggerQueryMods()
    installationModsLoadedRef.current = true
    // installedFilter changing on its own is already covered by the debounced-query effect
    // above (it lists installedFilter in its own deps); this effect exists only to redo an
    // "installed"/"not-installed" filter once a fresh installationInstalledMods scan comes
    // in, so listing installedFilter here too would just fire triggerQueryMods twice for
    // the same change. triggerQueryMods is excluded for the same reason as the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installationInstalledMods])

  /*
   * A card offers Update only when a newer release is tagged for the build, and the fast scan
   * knows nothing of releases. So the ModDB details are looked up, but only for the installed Mods
   * a card is showing, once per id while the page is mounted, and through the limiter the Manage
   * Mods scan uses so that together they stay inside their share of the ModDB slots (#386). The
   * details do not depend on the local copy: after a toggle, a delete or an update, the same
   * details still give the right answer. A failed lookup only leaves Update hidden.
   */
  useEffect(() => {
    if (!installationInstalledMods) return

    for (const mod of modsList.slice(0, visibleMods)) {
      if (requestedModDetails.current.has(mod.modid) || installedCopiesOf(mod.modidstrs, installationInstalledMods).length !== 1) continue
      requestedModDetails.current.add(mod.modid)

      void installedModLookups
        .run(() => queryMod({ modid: mod.modid }))
        .then((lookup) => {
          if (lookup.status === "found") setModDetails((previous) => new Map(previous).set(mod.modid, lookup.mod))
        })
    }
  }, [modsList, visibleMods, installationInstalledMods, queryMod])

  useLayoutEffect(() => {
    if (!restoreBrowseRef.current || modsList.length === 0) return

    restoreBrowseRef.current = false
    scrollRef.current?.scrollTo({ top: browseState.scrollTop })
  }, [modsList, browseState.scrollTop])

  async function triggerQueryMods(): Promise<void> {
    // If the installed mods are not loaded yet, skip, it'll be run again when the mods are loaded
    if (!installationInstalledMods) {
      logMods("info", "[front] [mods] [features/mods/pages/ListMods.tsx] [triggerQueryMods] Installed mods not loaded yet, skipping query")
      return
    }

    logMods("info", "[front] [mods] [features/mods/pages/ListMods.tsx] [triggerQueryMods] Installed mods loaded, querying mods")

    setSearching(true)

    // Nothing stops a second triggerQueryMods (a filter changed again before the first
    // request came back) from landing after this one. Without this token, whichever
    // resolves last wins regardless of which was asked for last, so a slow, already-stale
    // query could overwrite a filter the user has since moved past.
    const queryToken = ++queryTokenRef.current

    let mods = await queryMods({
      textFilter,
      authorFilter,
      versionsFilter,
      tagsFilter,
      orderBy,
      orderByOrder
    })

    if (queryToken !== queryTokenRef.current) return

    if (sideFilter !== "any") mods = mods.filter((mod) => mod.side === sideFilter)

    if (installedFilter === "installed") mods = mods.filter((mod) => installedCopiesOf(mod.modidstrs, installationInstalledMods).length > 0)
    if (installedFilter === "not-installed") mods = mods.filter((mod) => installedCopiesOf(mod.modidstrs, installationInstalledMods).length < 1)

    if (onlyFav) mods = mods.filter((mod) => favMods.includes(mod.modid))

    setModsList(mods)
    setSearching(false)
  }

  async function triggerGetInstalledMods(): Promise<void> {
    if (!installation) return addNotification(t("features.installations.noInstallationSelected"), "error")

    const mods = await getInstalledMods({
      path: installation.path
    })

    // Set the installed mods count for the selected Installation. We had to get the mods anyway so... 2x1
    syncModsCount(installation.id, mods)

    setInstallationInstalledMods(mods.mods)
  }

  // Stable references so ModsGrid can hand every ModListCard the same callback and let
  // its React.memo actually skip cards untouched by whatever caused ListMods to re-render.
  // Depends on hasInstallation (a primitive), not `installation` itself: that object is
  // rebuilt by useMemo above on every edit to *any* installation, unrelated fields
  // included, which would otherwise re-identify this callback on every such edit too.
  const hasInstallation = Boolean(installation)
  const onSelectMod = useCallback(
    (mod: DownloadableModOnListType): void => {
      if (!hasInstallation) {
        addNotification(t("features.installations.noInstallationSelected"), "error")
        return
      }
      // The card already knows the mod's name; handing it over means the page has something to
      // show its heading before the ModDB answers, instead of a bare numeric id.
      navigate(`/mods/install/${mod.modid}`, { state: { modName: mod.name } })
    },
    [hasInstallation, addNotification, navigate, t]
  )

  const onToggleFavMod = useCallback(
    (mod: DownloadableModOnListType): void => {
      if (favMods.includes(mod.modid)) {
        configDispatch({ type: CONFIG_ACTIONS.REMOVE_FAV_MOD, payload: { modid: mod.modid } })
      } else {
        configDispatch({ type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: mod.modid } })
      }
    },
    [favMods, configDispatch]
  )

  const onOpenModDb = useCallback((mod: DownloadableModOnListType): void => openModOnModDb(mod.assetid), [openModOnModDb])

  // Read through a ref so onModAction keeps one identity across rescans and lookups: every card
  // holds it, and a new one would re-render them all.
  const actionTargets = useRef({ installedMods: [] as readonly InstalledModType[], details: modDetails, gameVersion: "" })
  useLayoutEffect(() => {
    actionTargets.current = { installedMods: installationInstalledMods ?? [], details: modDetails, gameVersion: installation?.version ?? "" }
  })

  const { installNewest, updateMod, toggleEnabled, toggleSuspended, requestDelete } = actions
  const onModAction = useCallback(
    (mod: DownloadableModOnListType, action: ModCardAction): void | Promise<void> => {
      // Resolved against the last scan, never against what the card showed: a card can be painted
      // from an older render (GridGroup's AnimatePresence replays one once an exit ends), and an
      // install next to a copy already there leaves two archives declaring one modid.
      const { installedMods, details, gameVersion } = actionTargets.current
      const copies = installedCopiesOf(mod.modidstrs, installedMods)

      if (action === "install") {
        if (copies.length > 0) return
        return installNewest(mod).then((outcome) => {
          // Nothing is tagged for this build. The release list labels every release Tagged, Likely
          // or Untagged, so that is where the player can pick one knowing what it is.
          if (outcome === "no-tagged-release") navigate(`/mods/install/${mod.modid}`, { state: { modName: mod.name } })
        })
      }

      const copy = copies.length === 1 ? copies[0] : undefined
      if (!copy) return

      if (action === "toggle-enabled") return toggleEnabled(copy)
      if (action === "toggle-suspended") return toggleSuspended(copy.modid)
      if (action === "delete") return requestDelete(copy)

      const releases = details.get(mod.modid)?.releases ?? []
      const target = findModUpdate(copy.version, releases, gameVersion).updatableTo
      const newRelease = releases.find((release) => release.modversion === target)
      if (newRelease) return updateMod(copy, newRelease)
    },
    [installNewest, updateMod, toggleEnabled, toggleSuspended, requestDelete, navigate]
  )

  function clearFilters(): void {
    setTextFilter("")
    setAuthorFilter({ userid: "", name: "" })
    setVersionsFilter([])
    setTagsFilter([])
    setSideFilter("any")
    setInstalledFilter("all")
    setOnlyFav(false)
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="w-full min-h-[101%] flex flex-col justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />

              <ReloadButton
                onClick={() => {
                  if (!searching) {
                    resetBrowsePosition()
                    void triggerQueryMods()
                  }
                }}
                reloading={searching}
              />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.mods"), to: "/mods" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>

          <ModsFilterBar
            textFilter={textFilter}
            setTextFilter={setTextFilter}
            authorFilter={authorFilter}
            setAuthorFilter={setAuthorFilter}
            versionsFilter={versionsFilter}
            setVersionsFilter={setVersionsFilter}
            tagsFilter={tagsFilter}
            setTagsFilter={setTagsFilter}
            sideFilter={sideFilter}
            setSideFilter={setSideFilter}
            installedFilter={installedFilter}
            setInstalledFilter={setInstalledFilter}
            onlyFav={onlyFav}
            setOnlyFav={setOnlyFav}
            orderBy={orderBy}
            setOrderBy={setOrderBy}
            orderByOrder={orderByOrder}
            setOrderByOrder={setOrderByOrder}
            onClearFilters={clearFilters}
          />
        </StickyMenuWrapper>

        {/*
         * Said once for the whole grid, rather than as a row of dead buttons on every card. The config
         * selects the first Installation whenever there is one, so having none is what this means.
         */}
        {!installation && (
          <p className="text-sm text-center text-zinc-400">
            {t("features.installations.noInstallationsFound")}{" "}
            <Trans
              i18nKey="features.installations.noInstallationsFoundDesc"
              components={{
                link: (
                  <LinkButton title={t("components.mainMenu.installationsTitle")} to="/installations" variant="link">
                    {t("components.mainMenu.installationsTitle")}
                  </LinkButton>
                )
              }}
            />
          </p>
        )}

        <ModsGrid
          mods={modsList}
          visibleCount={visibleMods}
          searching={searching}
          installedMods={installationInstalledMods ?? []}
          installationId={installation?.id}
          gameVersion={installation?.version ?? ""}
          details={modDetails}
          suspendedModUpdates={suspendedModUpdates}
          isBusy={actions.isBusy}
          isModFav={(mod) => favMods.includes(mod.modid)}
          onSelectMod={onSelectMod}
          onToggleFavMod={onToggleFavMod}
          onOpenModDb={onOpenModDb}
          onModAction={onModAction}
        />

        <DeleteModDialog isOpen={actions.modToDelete !== null} close={actions.cancelDelete} onConfirm={actions.confirmDelete} />
      </div>
    </ScrollableContainer>
  )
}

export default ListMods
