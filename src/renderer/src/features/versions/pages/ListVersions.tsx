import { useRef, useState } from "react"
import { PiFolderOpenDuotone, PiPlusCircleDuotone, PiTrashDuotone, PiMagnifyingGlassDuotone, PiXCircleDuotone } from "react-icons/pi"
import { useTranslation } from "react-i18next"
import semver from "semver"

import { uninstallGameVersion } from "@domain/versions/uninstall"
import { useGameVersions, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createUninstallPorts, describeUninstallFailure, toGameVersionSnapshot } from "@renderer/features/versions/adapters/uninstall"

import { ListGroup, ListWrapper, ListItem } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { LinkButton, NormalButton } from "@renderer/components/ui/Buttons"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

const LOG_TAG = "[front] [versions] [features/versions/pages/ListVersions.tsx]"

function ListVersions(): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const configDispatch = useConfigDispatch()

  const [versionToDelete, setVersionToDelete] = useState<GameVersionType | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function DeleteVersionHandler(): Promise<void> {
    if (versionToDelete === null) return addNotification(t("features.versions.noVersionSelected"), "error")

    const version = versionToDelete

    try {
      const result = await uninstallGameVersion(
        createUninstallPorts(),
        { version: toGameVersionSnapshot(version) },
        {
          onStarted: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: true } } }),
          onFinished: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { version: version.version, updates: { _deleting: false } } })
        }
      )

      if (result.ok) {
        configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { version: version.version } })
        return addNotification(t("features.versions.versionUninstalledSuccesfully", { version: version.version }), "success")
      }

      const { messageKey, logged } = describeUninstallFailure(result.reason)

      if (logged) {
        window.api.utils.logMessage("error", `${LOG_TAG} [DeleteVersionHandler] Error uninstalling a VS Version.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} [DeleteVersionHandler] Error uninstalling VS Version ${version.version}: ${result.reason}.`)
      }

      addNotification(t(messageKey, { version: version.version }), "error")
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
                      <NormalButton
                        onClick={async () => {
                          if (!(await window.api.pathsManager.checkPathExists(gv.path))) return addNotification(t("notifications.body.folderDoesntExists"), "error")
                          window.api.pathsManager.openPathOnFileExplorer(gv.path)
                        }}
                        title={`${t("generic.openOnFileExplorer")} · ${gv.path}`}
                        className="p-1"
                      >
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
