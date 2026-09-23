import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import { PiArrowCounterClockwiseDuotone, PiCopyDuotone, PiFolderOpenDuotone, PiTrashDuotone, PiTruckDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useInstallations, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { ListGroup, ListItem, ListWrapper } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ButtonsWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function ManageInstallationWorlds(): JSX.Element {
  const { id } = useParams()
  const { t } = useTranslation()
  const installations = useInstallations()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const installation = installations.find((candidate) => candidate.id === id)
  const isPlaying = Boolean(installation?._playing)
  const [worlds, setWorlds] = useState<WorldType[]>([])
  const [loading, setLoading] = useState(true)
  const [targetId, setTargetId] = useState("")
  const target = installations.find((candidate) => candidate.id === targetId)
  const isTargetPlaying = Boolean(target?._playing)
  const [worldToDelete, setWorldToDelete] = useState<WorldType | null>(null)
  const [deleteName, setDeleteName] = useState("")
  const deleteNameId = useId()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!installation) return
    setLoading(true)
    const result = await window.api.worldsManager.list(installation.id)
    setLoading(false)
    if (result.ok) setWorlds(result.worlds)
    else addNotification(t(`features.worlds.error.${result.reason}`), "error")
  }, [addNotification, installation, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function backup(world: WorldType, askConfirmation = true): Promise<boolean> {
    if (!installation || isPlaying || (askConfirmation && !window.confirm(t("features.worlds.confirmBackup", { name: world.name })))) return false
    const result = await window.api.worldsManager.backup(installation.id, world.name)
    if (!result.ok) {
      addNotification(t(`features.worlds.error.${result.reason}`), "error")
      return false
    }
    configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { worldBackups: [result.backup, ...(installation.worldBackups ?? [])] } } })
    addNotification(t("features.worlds.backupDone"), "success")
    await refresh()
    return true
  }

  function closeDeleteDialog(): void {
    setWorldToDelete(null)
    setDeleteName("")
  }

  async function deleteWorldHandler(): Promise<void> {
    if (!installation || isPlaying || !worldToDelete || deleteName !== worldToDelete.name) return
    const world = worldToDelete
    closeDeleteDialog()
    const backups = (installation.worldBackups ?? []).filter((backup) => backup.worldName.toLocaleLowerCase("en-US") === world.name.toLocaleLowerCase("en-US"))
    if (backups.length === 0 && window.confirm(t("features.worlds.backupBeforeDelete", { name: world.name }))) {
      if (!(await backup(world, false))) return
    }
    const result = await window.api.worldsManager.delete(installation.id, world.name)
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    addNotification(t("features.worlds.deleteDone"), "success")
    await refresh()
  }

  async function restore(backup: WorldBackupType): Promise<void> {
    if (!installation || isPlaying || !window.confirm(t("features.worlds.confirmRestore", { name: backup.worldName }))) return
    let result: WorldOperationResult
    try {
      result = await window.api.worldsManager.restore(installation.id, backup.id)
    } catch {
      return addNotification(t("features.worlds.error.operation-failed"), "error")
    }
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    addNotification(t("features.worlds.restoreDone"), "success")
    await refresh()
  }

  async function transfer(world: WorldType, mode: "copy" | "move"): Promise<void> {
    if (!installation || isPlaying || isTargetPlaying || !targetId || targetId === installation.id) return addNotification(t("features.worlds.chooseTarget"), "error")
    if (!target || !window.confirm(t("features.worlds.confirmTransfer", { name: world.name, target: target.name }))) return
    if (mode === "move" && !window.confirm(t("features.worlds.confirmMove", { name: world.name, target: target.name }))) return
    const result = await window.api.worldsManager.transfer(installation.id, world.name, target.id, mode)
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    addNotification(result.warning ? t("features.worlds.versionWarning") : t("features.worlds.transferDone", { name: result.targetWorldName }), result.warning ? "warning" : "success")
    await refresh()
  }

  if (!installation) return <div className="p-8">{t("features.installations.noInstallationFound")}</div>

  const backupOnly = new Map<string, WorldType>()
  for (const backup of installation.worldBackups ?? []) {
    const key = backup.worldName.toLocaleLowerCase("en-US")
    if (worlds.some((world) => world.name.toLocaleLowerCase("en-US") === key) || backupOnly.has(key)) continue
    backupOnly.set(key, { name: backup.worldName, size: 0, lastModified: backup.date, isDefault: false, backupCount: 1 })
  }
  const displayWorlds: WorldType[] = [...worlds, ...backupOnly.values()]

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2 p-4">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/installations" />
            </StickyMenuGroup>
            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.installations"), to: "/installations" },
                { name: t("breadcrumbs.manageWorlds"), to: `/installations/worlds/${installation.id}` }
              ]}
            />
            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>
        <ListWrapper className="max-w-[58rem] w-full my-auto">
          <div className="flex items-center justify-between p-3">
            <div>
              <h1 className="text-2xl font-bold">{t("features.worlds.title")}</h1>
              <p className="text-zinc-400">{installation.name}</p>
            </div>
            <select className="bg-zinc-800 rounded p-2" value={targetId} onChange={(event) => setTargetId(event.target.value)} aria-label={t("features.worlds.transferTarget")}>
              <option value="">{t("features.worlds.transferTarget")}</option>
              {installations
                .filter((candidate) => candidate.id !== installation.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </select>
          </div>
          {loading && <p className="p-4 text-center text-zinc-400">{t("generic.reloading")}</p>}
          {!loading && displayWorlds.length === 0 && <p className="p-4 text-center">{t("features.worlds.empty")}</p>}
          <ListGroup>
            {displayWorlds.map((world) => {
              const liveWorld = worlds.some((candidate) => candidate.name.toLocaleLowerCase("en-US") === world.name.toLocaleLowerCase("en-US"))
              const backups = (installation.worldBackups ?? []).filter((backup) => backup.worldName.toLocaleLowerCase("en-US") === world.name.toLocaleLowerCase("en-US"))
              return (
                <ListItem key={world.name}>
                  <div className="flex flex-wrap items-center gap-3 p-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold truncate">
                        {world.name}
                        {world.isDefault ? ` · ${t("generic.default")}` : ""}
                      </p>
                      <p className="text-sm text-zinc-400">
                        {liveWorld ? formatBytes(world.size) : t("features.worlds.backupOnly")} · {new Date(world.lastModified).toLocaleString()} ·{" "}
                        {t("features.worlds.backupCount", { count: backups.length })}
                      </p>
                    </div>
                    {liveWorld && (
                      <NormalButton title={t("features.worlds.backup")} variant="ghost" className="p-1" disabled={isPlaying} onClick={() => void backup(world)}>
                        <PiCopyDuotone />
                      </NormalButton>
                    )}
                    {liveWorld && (
                      <NormalButton title={t("features.worlds.copy")} variant="ghost" className="p-1" disabled={isPlaying || isTargetPlaying} onClick={() => void transfer(world, "copy")}>
                        <PiCopyDuotone />
                      </NormalButton>
                    )}
                    {liveWorld && (
                      <NormalButton title={t("features.worlds.move")} variant="ghost" className="p-1" disabled={isPlaying || isTargetPlaying} onClick={() => void transfer(world, "move")}>
                        <PiTruckDuotone />
                      </NormalButton>
                    )}
                    {liveWorld && (
                      <NormalButton
                        title={t("generic.delete")}
                        variant="ghost"
                        className="p-1"
                        disabled={isPlaying}
                        onClick={() => {
                          setWorldToDelete(world)
                          setDeleteName("")
                        }}
                      >
                        <PiTrashDuotone />
                      </NormalButton>
                    )}
                  </div>
                  {backups.map((backup) => (
                    <div key={backup.id} className="flex items-center justify-end gap-2 px-3 pb-2 text-sm text-zinc-400">
                      <span>{new Date(backup.date).toLocaleString()}</span>
                      <NormalButton title={t("generic.restore")} variant="ghost" className="p-1" disabled={isPlaying} onClick={() => void restore(backup)}>
                        <PiArrowCounterClockwiseDuotone />
                      </NormalButton>
                      <NormalButton title={t("generic.openOnFileExplorer")} variant="ghost" className="p-1" onClick={() => void window.api.pathsManager.openPathOnFileExplorer(backup.path)}>
                        <PiFolderOpenDuotone />
                      </NormalButton>
                    </div>
                  ))}
                </ListItem>
              )
            })}
          </ListGroup>
        </ListWrapper>
        <PopupDialogPanel title={t("generic.delete")} isOpen={worldToDelete !== null} close={closeDeleteDialog}>
          <>
            <div className="flex flex-col gap-1 text-left">
              <label htmlFor={deleteNameId}>{t("features.worlds.confirmDelete", { name: worldToDelete?.name ?? "" })}</label>
              <FormInputText id={deleteNameId} value={deleteName} onChange={(event) => setDeleteName(event.target.value)} autoFocus className="w-full" />
            </div>
            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton title={t("generic.cancel")} onClick={closeDeleteDialog} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
              <FormButton
                title={t("generic.delete")}
                onClick={deleteWorldHandler}
                variant="destructive"
                size="md"
                icon={<PiTrashDuotone />}
                disabled={!worldToDelete || deleteName !== worldToDelete.name}
              />
            </ButtonsWrapper>
          </>
        </PopupDialogPanel>
      </div>
    </ScrollableContainer>
  )
}

export default ManageInstallationWorlds
