import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import { PiCopyDuotone, PiPencilDuotone, PiPlayCircleDuotone, PiPlusCircleDuotone, PiTrashDuotone, PiXCircleDuotone } from "react-icons/pi"

import { DEFAULT_GAME_SERVER_PORT, MAX_SERVER_BOOKMARKS, NEVER_LAUNCHED, orderServerBookmarks } from "@domain/servers/bookmarks"

import { useInstallations, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useLaunchGame } from "@renderer/features/launch/hooks/useLaunchGame"

import LaunchBackupPrompt from "@renderer/features/launch/components/LaunchBackupPrompt"
import ServerBookmarkDialog from "@renderer/features/servers/components/ServerBookmarkDialog"
import { ListGroup, ListItem, ListWrapper } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"
import { ThinSeparator } from "@renderer/components/ui/ListSeparators"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

/**
 * One Installation's saved servers.
 *
 * Every write here goes through EDIT_INSTALLATION with a whole new `servers` array, so the config
 * context stays the single writer and no new IPC channel exists to get a server list wrong through.
 *
 * The row runs the Installation's own VS Version and says so by not saying anything: the launcher
 * cannot poll a server for the version it runs, and a version a player typed in is a second source
 * of truth that goes stale without telling anyone. A player who needs the note puts it in the name.
 */
function ManageInstallationServers(): JSX.Element {
  const { id } = useParams()

  const { t } = useTranslation()
  const installations = useInstallations()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const { launchGame, skipBackupPromptOpen, answerSkipBackupPrompt } = useLaunchGame()

  const [serverToEdit, setServerToEdit] = useState<ServerBookmarkType | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [serverToRemove, setServerToRemove] = useState<ServerBookmarkType | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  const installation = installations.find((candidate) => candidate.id === id)
  const servers = installation?.servers ?? []

  function writeServers(next: ServerBookmarkType[]): void {
    if (!installation) return
    configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { servers: next } } })
  }

  function saveServer(bookmark: ServerBookmarkType): void {
    const known = servers.some((server) => server.id === bookmark.id)
    writeServers(known ? servers.map((server) => (server.id === bookmark.id ? bookmark : server)) : [...servers, bookmark])
  }

  function removeServer(): void {
    if (serverToRemove) writeServers(servers.filter((server) => server.id !== serverToRemove.id))
    setServerToRemove(null)
  }

  async function copyAddress(server: ServerBookmarkType): Promise<void> {
    try {
      await navigator.clipboard.writeText(server.port === DEFAULT_GAME_SERVER_PORT ? server.host : `${server.host}:${server.port}`)
      addNotification(t("features.servers.addressCopied"), "success")
    } catch {
      addNotification(t("features.servers.addressCopyFailed"), "error")
    }
  }

  function openAddDialog(): void {
    if (servers.length >= MAX_SERVER_BOOKMARKS) return addNotification(t("features.servers.serverLimitReached", { max: MAX_SERVER_BOOKMARKS }), "error")
    setServerToEdit(null)
    setDialogOpen(true)
  }

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/installations" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.installations"), to: "/installations" },
                { name: t("breadcrumbs.manageServers"), to: `/installations/servers/${id}` }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <ListWrapper className="max-w-[50rem] w-full my-auto">
          <ListGroup>
            <ListItem key="add" className="group">
              <NormalButton
                title={t("features.servers.addServer")}
                icon={<PiPlusCircleDuotone className="duration-200 group-hover:scale-95" />}
                variant="primary"
                size="lg"
                className="w-full h-12"
                onClick={openAddDialog}
              />
            </ListItem>

            {servers.length === 0 && (
              <ListItem key="empty">
                <div className="w-full flex flex-col items-center justify-center gap-1 p-4 text-center">
                  <p>{t("features.servers.noServersSaved")}</p>
                  <p className="text-sm text-zinc-300">{t("features.servers.manageServersDesc")}</p>
                </div>
              </ListItem>
            )}

            {orderServerBookmarks(servers).map((server) => (
              <ListItem key={server.id}>
                <div className="h-16 flex gap-2 p-1 justify-between items-center whitespace-nowrap">
                  <div className="w-full flex flex-col items-start justify-center gap-1 overflow-hidden px-2">
                    <p className="font-bold overflow-hidden text-ellipsis w-full text-left">{server.name}</p>
                    <p className="text-sm text-zinc-300 overflow-hidden text-ellipsis w-full text-left">{server.port === DEFAULT_GAME_SERVER_PORT ? server.host : `${server.host}:${server.port}`}</p>
                  </div>

                  <ThinSeparator />

                  <p className="shrink-0 w-44 text-sm text-zinc-300 text-center">
                    {server.lastLaunched === NEVER_LAUNCHED ? t("features.servers.neverLaunched") : t("features.servers.lastLaunched", { when: new Date(server.lastLaunched).toLocaleString("es") })}
                  </p>

                  <ThinSeparator />

                  <div className="shrink-0 w-fit h-full flex gap-1 items-center text-lg">
                    <NormalButton title={t("features.servers.join")} variant="primary" className="h-full px-3" icon={<PiPlayCircleDuotone />} onClick={() => launchGame(installation, server.id)} />
                    <div className="flex flex-col gap-1">
                      <NormalButton title={t("features.servers.copyAddress")} variant="ghost" className="p-1" onClick={() => copyAddress(server)}>
                        <PiCopyDuotone />
                      </NormalButton>
                      <NormalButton
                        title={t("features.servers.editServer")}
                        variant="ghost"
                        className="p-1"
                        onClick={() => {
                          setServerToEdit(server)
                          setDialogOpen(true)
                        }}
                      >
                        <PiPencilDuotone />
                      </NormalButton>
                    </div>
                    <NormalButton title={t("features.servers.removeServer")} variant="ghost" className="p-1" onClick={() => setServerToRemove(server)}>
                      <PiTrashDuotone />
                    </NormalButton>
                  </div>
                </div>
              </ListItem>
            ))}
          </ListGroup>
        </ListWrapper>

        <ServerBookmarkDialog isOpen={dialogOpen} close={() => setDialogOpen(false)} onSave={saveServer} server={serverToEdit} existing={servers} />

        <PopupDialogPanel title={t("features.servers.removeServer")} isOpen={serverToRemove !== null} close={() => setServerToRemove(null)}>
          <>
            <p>{t("features.servers.removeServerConfirm")}</p>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={() => setServerToRemove(null)} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton title={t("generic.delete")} onClick={removeServer} variant="destructive" size="md" icon={<PiTrashDuotone />} />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>

        <LaunchBackupPrompt isOpen={skipBackupPromptOpen} answer={answerSkipBackupPrompt} />
      </div>
    </ScrollableContainer>
  )
}

export default ManageInstallationServers
