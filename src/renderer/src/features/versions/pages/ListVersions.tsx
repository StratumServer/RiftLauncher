import { useRef, useState } from "react"
import { PiFolderOpenDuotone, PiPlusCircleDuotone, PiTrashDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"
import semver from "semver"

import { useGameVersions } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useUninstallGameVersion } from "@renderer/features/versions/hooks/useUninstallGameVersion"
import { useOpenVersionFolder } from "@renderer/features/versions/hooks/useOpenVersionFolder"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { LinkButton, NormalButton } from "@renderer/components/ui/Buttons"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

function ListVersions(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const uninstallVersion = useUninstallGameVersion()
  const openVersionFolder = useOpenVersionFolder()

  const [versionToDelete, setVersionToDelete] = useState<GameVersionType | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function DeleteVersionHandler(): Promise<void> {
    if (versionToDelete === null) return addNotification(t("features.versions.noVersionSelected"), "error")

    try {
      await uninstallVersion(versionToDelete)
    } finally {
      setVersionToDelete(null)
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
                <LinkButton to="/versions/add" title={t("features.versions.installNewVersion")} className="w-full h-8">
                  <PiPlusCircleDuotone className="text-xl text-zinc-400/25 group-hover:scale-95 duration-200" />
                </LinkButton>
              </ListItem>
              <ListItem className="group">
                <LinkButton to="/versions/look-for-a-version" title={t("features.versions.searchForAGameVersion")} className="w-full h-8">
                  <PiMagnifyingGlassDuotone className="text-xl text-zinc-400/25 group-hover:scale-95 duration-200" />
                </LinkButton>
              </ListItem>
            </div>
            {gameVersions
              .slice()
              .sort((a, b) => semver.rcompare(a.version, b.version))
              .map((gv) => (
                <ListItem key={gv.version}>
                  <div className="w-full h-8 flex gap-2 p-1 justify-between items-center">
                    <div className="w-full flex items-center justify-center text-start font-bold pl-1">
                      <p className="w-full">{gv.version}</p>
                    </div>

                    <ThinSeparator />

                    <div className="shrink-0 w-fit flex gap-1 text-lg">
                      <NormalButton onClick={() => openVersionFolder(gv.path)} title={`${t("generic.openOnFileExplorer")} · ${gv.path}`} className="p-1">
                        <PiFolderOpenDuotone />
                      </NormalButton>
                      <NormalButton
                        className="p-1"
                        title={t("features.versions.deleteVersion")}
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

        <PopupDialogPanel title={t("features.versions.uninstallVersion")} isOpen={versionToDelete !== null} close={() => setVersionToDelete(null)}>
          <>
            <p>{t("features.versions.areYouSureUninstall")}</p>
            <p className="text-zinc-400">{t("features.versions.uninstallingNotReversible")}</p>
            <div className="flex gap-4 items-center justify-center text-lg">
              <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setVersionToDelete(null)} type="success">
                <PiXCircleDuotone />
              </FormButton>
              <FormButton title={t("generic.uninstall")} className="p-2" onClick={DeleteVersionHandler} type="error">
                <PiTrashDuotone />
              </FormButton>
            </div>
          </>
        </PopupDialogPanel>
      </div>
    </ScrollableContainer>
  )
}

export default ListVersions
