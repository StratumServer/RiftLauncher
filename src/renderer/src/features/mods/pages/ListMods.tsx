import { useState, useEffect, useRef } from "react"
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

  const [installation, setInstallation] = useState<InstallationType | undefined>(undefined)

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

  const handleScroll = (): void => {
    if (!scrollRef.current) return
    const { scrollTop, clientHeight, scrollHeight } = scrollRef.current
    if (scrollTop + clientHeight >= scrollHeight - (clientHeight / 2 + 100)) setVisibleMods((prev) => prev + 10)
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.addEventListener("scroll", handleScroll)

    return (): void => {
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
  }, [textFilter, authorFilter, versionsFilter, tagsFilter, sideFilter, installedFilter, onlyFav, orderBy, orderByOrder])

  useEffect(() => {
    setInstallation(installations.find((i) => i.id === lastUsedInstallation))
  }, [lastUsedInstallation])

  useEffect(() => {
    if (!installation) return setInstallationInstalledMods([])
    triggerGetInstalledMods()
  }, [installation])

  useEffect(() => {
    if (installedFilter !== "all") triggerQueryMods(false)
  }, [installationInstalledMods])

  async function triggerQueryMods(resetScroll: boolean = true): Promise<void> {
    // If the installed mods are not loaded yet, skip, it'll be run again when the mods are loaded
    if (!installationInstalledMods) {
      logMods("info", "[front] [mods] [features/mods/pages/ListMods.tsx] [triggerQueryMods] Installed mods not loaded yet, skipping query")
      return
    }

    logMods("info", "[front] [mods] [features/mods/pages/ListMods.tsx] [triggerQueryMods] Installed mods loaded, querying mods")

    setSearching(true)

    let mods = await queryMods({
      textFilter,
      authorFilter,
      versionsFilter,
      tagsFilter,
      orderBy,
      orderByOrder,
      onFinish: () => {
        if (resetScroll) {
          scrollRef.current?.scrollTo({ top: 0 })
          setVisibleMods(DEFAULT_LOADED_MODS)
        }
      }
    })

    if (sideFilter !== "any") mods = mods.filter((mod) => mod.side === sideFilter)

    if (installedFilter === "installed")
      mods = mods.filter((mod) => installationInstalledMods.some((iMod) => mod.modidstrs.some((modidstr) => modidstr === iMod.modid.toLocaleLowerCase() || modidstr === iMod.modid)))
    if (installedFilter === "not-installed")
      mods = mods.filter((mod) => !installationInstalledMods.some((iMod) => mod.modidstrs.some((modidstr) => modidstr === iMod.modid.toLocaleLowerCase() || modidstr === iMod.modid)))

    if (onlyFav) mods = mods.filter((mod) => favMods.some((fm) => fm === mod.modid))

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
          isModFav={(mod) => favMods.some((modid) => modid === mod.modid)}
          onSelectMod={(mod) => {
            if (!installation) return addNotification(t("features.installations.noInstallationSelected"), "error")
            setModToInstall(mod)
          }}
          onToggleFavMod={(mod) => {
            if (favMods.some((modid) => modid === mod.modid)) {
              configDispatch({ type: CONFIG_ACTIONS.REMOVE_FAV_MOD, payload: { modid: mod.modid } })
            } else {
              configDispatch({ type: CONFIG_ACTIONS.ADD_FAV_MOD, payload: { modid: mod.modid } })
            }
          }}
          onOpenModDb={(mod) => openModOnModDb(mod.assetid)}
        />

        <InstallModPopup
          modToInstall={modToInstall?.modid || null}
          setModToInstall={() => setModToInstall(null)}
          installation={
            installation && {
              installation: installation,
              oldMod: installationInstalledMods?.find((iMod) => modToInstall?.modidstrs.some((modidstr) => modidstr === iMod.modid))
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
