import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"

import { useInstallations, useFavMods, useSettingsConfig, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { useQueryMods } from "@renderer/features/mods/hooks/useQueryMods"
import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"
import { useSyncModsCount } from "@renderer/features/mods/hooks/useSyncModsCount"
import { useLogMods } from "@renderer/features/mods/hooks/useLogMods"
import { useExternalLinks } from "@renderer/features/mods/hooks/useExternalLinks"

import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, ReloadButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"
import ModsFilterBar from "@renderer/features/mods/components/ModsFilterBar"
import ModsGrid from "@renderer/features/mods/components/ModsGrid"

function ListMods(): JSX.Element {
  const { t } = useTranslation()
  const installations = useInstallations()
  const favMods = useFavMods()
  const { lastUsedInstallation } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const DEFAULT_LOADED_MODS = 45

  const queryMods = useQueryMods()
  const getInstalledMods = useGetInstalledMods()
  const syncModsCount = useSyncModsCount()
  const logMods = useLogMods()
  const { openModOnModDb } = useExternalLinks()

  const [modsList, setModsList] = useState<DownloadableModOnListType[]>([])
  const [visibleMods, setVisibleMods] = useState<number>(DEFAULT_LOADED_MODS)

  // Derived (not copied into state) so an EDIT_INSTALLATION on the current
  // installation (e.g. its mods count) shows up immediately, without needing
  // lastUsedInstallation itself to change.
  const installation = useMemo(() => installations.find((i) => i.id === lastUsedInstallation), [installations, lastUsedInstallation])

  const [installationInstalledMods, setInstallationInstalledMods] = useState<InstalledModType[] | undefined>([])

  const [onlyFav, setOnlyFav] = useState<boolean>(false)
  const [textFilter, setTextFilter] = useState<string>("")
  const [authorFilter, setAuthorFilter] = useState<DownloadableModAuthorType>({ userid: "", name: "" })
  const [versionsFilter, setVersionsFilter] = useState<DownloadableModGameVersionType[]>([])
  const [tagsFilter, setTagsFilter] = useState<DownloadableModTagType[]>([])
  const [sideFilter, setSideFilter] = useState<string>("any")
  const [installedFilter, setInstalledFilter] = useState<string>("all")
  const [orderBy, setOrderBy] = useState<string>("follows")
  const [orderByOrder, setOrderByOrder] = useState<string>("desc")

  const [searching, setSearching] = useState<boolean>(true)

  const [modToInstall, setModToInstall] = useState<DownloadableModOnListType | null>(null)

  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const queryTokenRef = useRef<number>(0)

  const handleScroll = (): void => {
    if (!scrollRef.current) return
    const { scrollTop, clientHeight, scrollHeight } = scrollRef.current
    if (scrollTop + clientHeight >= scrollHeight - (clientHeight / 2 + 100)) setVisibleMods((prev) => prev + 10)
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

  useEffect(() => {
    if (installedFilter !== "all") triggerQueryMods(false)
    // installedFilter changing on its own is already covered by the debounced-query effect
    // above (it lists installedFilter in its own deps); this effect exists only to redo an
    // "installed"/"not-installed" filter once a fresh installationInstalledMods scan comes
    // in, so listing installedFilter here too would just fire triggerQueryMods twice for
    // the same change. triggerQueryMods is excluded for the same reason as the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installationInstalledMods])

  async function triggerQueryMods(resetScroll: boolean = true): Promise<void> {
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
      orderByOrder,
      onFinish: () => {
        if (queryToken !== queryTokenRef.current) return
        if (resetScroll) {
          scrollRef.current?.scrollTo({ top: 0 })
          setVisibleMods(DEFAULT_LOADED_MODS)
        }
      }
    })

    if (queryToken !== queryTokenRef.current) return

    if (sideFilter !== "any") mods = mods.filter((mod) => mod.side === sideFilter)

    if (installedFilter === "installed")
      mods = mods.filter((mod) => installationInstalledMods.some((iMod) => mod.modidstrs.some((modidstr) => modidstr === iMod.modid.toLocaleLowerCase() || modidstr === iMod.modid)))
    if (installedFilter === "not-installed")
      mods = mods.filter((mod) => !installationInstalledMods.some((iMod) => mod.modidstrs.some((modidstr) => modidstr === iMod.modid.toLocaleLowerCase() || modidstr === iMod.modid)))

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
      setModToInstall(mod)
    },
    [hasInstallation, addNotification, t]
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
                  if (!searching) triggerQueryMods()
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

        <ModsGrid
          mods={modsList}
          visibleCount={visibleMods}
          searching={searching}
          isModInstalled={(mod) => Boolean(installationInstalledMods?.some((iMod) => mod.modidstrs.some((modidstr) => modidstr === iMod.modid.toLocaleLowerCase() || modidstr === iMod.modid)))}
          isModFav={(mod) => favMods.includes(mod.modid)}
          onSelectMod={onSelectMod}
          onToggleFavMod={onToggleFavMod}
          onOpenModDb={onOpenModDb}
        />

        <InstallModPopup
          modToInstall={modToInstall?.modid || null}
          setModToInstall={() => setModToInstall(null)}
          modName={modToInstall?.name}
          installation={
            installation && {
              installation: installation,
              oldMod: installationInstalledMods?.find((iMod) => modToInstall?.modidstrs.includes(iMod.modid))
            }
          }
          onFinishInstallation={() => {
            triggerGetInstalledMods()
          }}
        />
      </div>
    </ScrollableContainer>
  )
}

export default ListMods
