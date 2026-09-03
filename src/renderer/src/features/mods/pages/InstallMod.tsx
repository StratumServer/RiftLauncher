import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { useTranslation } from "react-i18next"

import { useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useGetInstalledMods } from "@renderer/features/mods/hooks/useGetInstalledMods"
import { useModReleaseCatalog } from "@renderer/features/mods/hooks/useModReleaseCatalog"
import ModReleaseList from "@renderer/features/mods/components/ModReleaseList"

import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

/**
 * Choosing a release to install is a step in browsing the ModDB, not an interruption of it: it has
 * its own address, leaves the launcher's menus reachable, and is left with the same Go back the
 * other pages use. It was a modal that covered the window, which is why there was nowhere to go
 * back to except dismissing it.
 */
function InstallMod(): JSX.Element {
  const { t } = useTranslation()
  const { modid } = useParams<{ modid: string }>()
  const navigate = useNavigate()
  const { state } = useLocation() as { state?: { modName?: string } }

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const installations = useInstallations()
  const { lastUsedInstallation } = useSettingsConfig()
  const installation = useMemo(() => installations.find((i) => i.id === lastUsedInstallation), [installations, lastUsedInstallation])

  const getInstalledMods = useGetInstalledMods()
  const [installedMods, setInstalledMods] = useState<InstalledModType[]>([])

  const { mod, loading, failed, retry } = useModReleaseCatalog(modid ?? null)

  useEffect(() => {
    if (!installation) return setInstalledMods([])

    let current = true
    void getInstalledMods({ path: installation.path }).then(({ mods }) => {
      if (current) setInstalledMods(mods)
    })

    return (): void => {
      current = false
    }
  }, [installation, getInstalledMods])

  // A release names the modid the file actually declares, which is what an installed copy is keyed
  // by, so the old copy is found through the releases rather than through the ModDB's numeric id.
  const oldMod = useMemo(() => {
    if (!mod) return undefined
    const declared = new Set(mod.releases.map((release) => release.modidstr))
    return installedMods.find((installed) => declared.has(installed.modid))
  }, [mod, installedMods])

  const displayedModName = mod?.name || state?.modName || String(modid ?? "")

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/mods" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.mods"), to: "/mods" },
                { name: t("features.mods.installMod"), to: `/mods/install/${modid}` }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <div className="w-full flex flex-col items-center gap-2 my-auto">
          <p className="text-center">{t("features.mods.installationPopupDesc", { modName: displayedModName })}</p>

          <ModReleaseList
            mod={mod}
            loading={loading}
            failed={failed}
            retry={retry}
            modToInstall={modid ?? null}
            modName={displayedModName}
            installation={installation && { installation, oldMod }}
            onInstallStarted={() => navigate("/mods")}
          />
        </div>
      </div>
    </ScrollableContainer>
  )
}

export default InstallMod
