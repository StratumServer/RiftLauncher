import { useRef, useState } from "react"
import { PiFolderOpenDuotone, PiPlusCircleDuotone, PiTrashDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone, PiWarningDuotone, PiLinkDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"

import { compareGameVersionsDesc } from "@renderer/utils/gameVersionOrder"
import { useGameVersions, useInstallations } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useUninstallGameVersion } from "@renderer/features/versions/hooks/useUninstallGameVersion"
import { useOpenVersionFolder } from "@renderer/features/versions/hooks/useOpenVersionFolder"
import { formatUsedByInstallations } from "@renderer/features/versions/adapters/uninstall"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { LinkButton, NormalButton } from "@renderer/components/ui/Buttons"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

/** A version pending the "still in use" warning: the deletion was refused, this is what it would affect. */
interface VersionInUseWarning {
  version: GameVersionType
  usedByInstallations: string[]
}

function ListVersions(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const installations = useInstallations()
  const uninstallVersion = useUninstallGameVersion()
  const openVersionFolder = useOpenVersionFolder()

  const [versionToDelete, setVersionToDelete] = useState<GameVersionType | null>(null)
  const [versionInUseWarning, setVersionInUseWarning] = useState<VersionInUseWarning | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  function installationsUsing(version: string): string[] {
    return installations.filter((installation) => installation.version === version).map((installation) => installation.name)
  }

  async function DeleteVersionHandler(): Promise<void> {
    if (versionToDelete === null) return addNotification(t("features.versions.noVersionSelected"), "error")

    const target = versionToDelete
    const usedByInstallations = installationsUsing(target.version)
    setVersionToDelete(null)

    const result = await uninstallVersion(target, { usedByInstallations })

    if (!result.ok && result.reason === "version-in-use") setVersionInUseWarning({ version: target, usedByInstallations })
  }

  async function DeleteVersionAnywayHandler(): Promise<void> {
    if (versionInUseWarning === null) return

    const { version, usedByInstallations } = versionInUseWarning
    setVersionInUseWarning(null)

    await uninstallVersion(version, { usedByInstallations, confirmedInUse: true })
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.versions"), to: "/versions" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <ListWrapper className="max-w-[50rem] w-full my-auto">
          <ListGroup>
            <div className="flex gap-2">
              <ListItem className="group">
                <LinkButton
                  to="/versions/add"
                  title={t("features.versions.installNewVersion")}
                  icon={<PiPlusCircleDuotone className="duration-200 group-hover:scale-95" />}
                  variant="primary"
                  className="w-full h-8"
                />
              </ListItem>
              <ListItem className="group">
                <LinkButton
                  to="/versions/look-for-a-version"
                  title={t("features.versions.searchForAGameVersion")}
                  icon={<PiMagnifyingGlassDuotone className="duration-200 group-hover:scale-95" />}
                  variant="secondary"
                  className="w-full h-8"
                />
              </ListItem>
            </div>
            {gameVersions
              .slice()
              .sort((a, b) => compareGameVersionsDesc(a.version, b.version))
              .map((gv) => (
                <ListItem key={gv.version}>
                  <div className="w-full h-8 flex gap-2 p-1 justify-between items-center">
                    <div className="w-full flex items-center justify-center text-start font-bold pl-1">
                      <p className="w-full">{gv.version}</p>
                    </div>

                    <ThinSeparator />

                    <div className="shrink-0 w-fit flex gap-1 items-center text-lg">
                      {gv.linked && <PiLinkDuotone className="p-1" title={t("features.versions.linkedVersion")} />}
                      <NormalButton onClick={() => openVersionFolder(gv.path)} title={`${t("generic.openOnFileExplorer")} · ${gv.path}`} variant="ghost" className="p-1">
                        <PiFolderOpenDuotone />
                      </NormalButton>
                      <NormalButton
                        className="p-1"
                        title={gv.linked ? t("features.versions.removeFromList") : t("features.versions.deleteVersion")}
                        variant="ghost"
                        onClick={async () => {
                          setVersionToDelete(gv)
                        }}
                      >
                        <PiTrashDuotone />
                      </NormalButton>
                    </div>
                  </div>
                </ListItem>
              ))}
          </ListGroup>
        </ListWrapper>

        <PopupDialogPanel
          title={t(versionToDelete?.linked ? "features.versions.removeFromList" : "features.versions.uninstallVersion")}
          isOpen={versionToDelete !== null}
          close={() => setVersionToDelete(null)}
        >
          <>
            <p>{t(versionToDelete?.linked ? "features.versions.areYouSureUnlink" : "features.versions.areYouSureUninstall")}</p>
            <p className="text-zinc-400">{t(versionToDelete?.linked ? "features.versions.unlinkingKeepsTheFolder" : "features.versions.uninstallingNotReversible")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionToDelete(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton
                title={t(versionToDelete?.linked ? "features.versions.removeFromList" : "generic.uninstall")}
                onClick={DeleteVersionHandler}
                variant="destructive"
                size="md"
                icon={<PiTrashDuotone />}
              />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>

        <PopupDialogPanel title={t("features.versions.versionInUse")} isOpen={versionInUseWarning !== null} close={() => setVersionInUseWarning(null)}>
          <>
            <div className="flex items-center justify-center gap-2 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
              <PiWarningDuotone className="text-lg shrink-0" />
              <span>{t("features.versions.versionInUseByInstallations", { installations: formatUsedByInstallations(versionInUseWarning?.usedByInstallations ?? []) })}</span>
            </div>
            <p className="text-zinc-400">{t(versionInUseWarning?.version.linked ? "features.versions.unlinkingKeepsTheFolder" : "features.versions.uninstallingNotReversible")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setVersionInUseWarning(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton title={t("features.versions.deleteAnyway")} onClick={DeleteVersionAnywayHandler} variant="destructive" size="md" icon={<PiTrashDuotone />} />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>
      </div>
    </ScrollableContainer>
  )
}

export default ListVersions
