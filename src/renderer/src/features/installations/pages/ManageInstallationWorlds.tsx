import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import { PiArchiveDuotone, PiArrowCounterClockwiseDuotone, PiCopyDuotone, PiFolderOpenDuotone, PiTrashDuotone, PiTruckDuotone, PiXCircleDuotone } from "react-icons/pi"

import { worldVersionWarning } from "@domain/worlds/worlds"
import { useInstallations, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useDateFormat } from "@renderer/hooks/useDateFormat"
import { ListGroup, ListItem, ListWrapper } from "@renderer/components/ui/List"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import ConfirmDialog from "@renderer/components/ui/ConfirmDialog"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { ButtonsWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import type { ButtonVariant } from "@renderer/components/ui/buttonStyles"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** A world or Installation name is the player's own text and React already escapes what it renders, so i18next's HTML escaping would only show "Bob's World" as "Bob&#39;s World". */
const RAW_NAME = { interpolation: { escapeValue: false } }

interface PendingConfirmation {
  title?: string
  question: string
  consequence?: string
  confirmLabel: string
  confirmIcon: React.ReactNode
  confirmVariant?: ButtonVariant
  run: () => Promise<void>
}

function ManageInstallationWorlds(): JSX.Element {
  const { id } = useParams()
  const { t } = useTranslation()
  const { formatDateTime } = useDateFormat()
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
  const [worldPendingBackupOffer, setWorldPendingBackupOffer] = useState<WorldType | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null)
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

  async function backup(world: WorldType): Promise<boolean> {
    if (!installation || isPlaying) return false
    const result = await window.api.worldsManager.backup(installation.id, world.name)
    if (!result.ok) {
      addNotification(t(`features.worlds.error.${result.reason}`), "error")
      return false
    }
    const deletedSet = new Set(result.deletedBackupIds ?? [])
    const nextWorldBackups = [result.backup, ...(installation.worldBackups ?? []).filter((candidate) => !deletedSet.has(candidate.id))].slice(0, 100)
    configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { worldBackups: nextWorldBackups } } })
    addNotification(t("features.worlds.backupDone"), "success")
    await refresh()
    return true
  }

  function requestBackup(world: WorldType): void {
    if (!installation || isPlaying) return
    setPendingConfirmation({
      question: t("features.worlds.confirmBackup", { name: world.name, ...RAW_NAME }),
      confirmLabel: t("features.worlds.backup"),
      confirmIcon: <PiArchiveDuotone />,
      confirmVariant: "primary",
      run: async () => {
        await backup(world)
      }
    })
  }

  function closeDeleteDialog(): void {
    setWorldToDelete(null)
    setDeleteName("")
  }

  async function deleteWorld(world: WorldType): Promise<void> {
    if (!installation || isPlaying) return
    const result = await window.api.worldsManager.delete(installation.id, world.name)
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    addNotification(t("features.worlds.deleteDone"), "success")
    await refresh()
  }

  function deleteWorldHandler(): void {
    if (!installation || isPlaying || !worldToDelete || deleteName !== worldToDelete.name) return
    const world = worldToDelete
    const backups = (installation.worldBackups ?? []).filter((backup) => backup.worldName === world.name)
    closeDeleteDialog()
    if (backups.length === 0) {
      // Queued rather than opened right here: this PopupDialogPanel is about to start closing, and
      // opening the offer in the same update would mount it while the first one is still playing its
      // exit animation. onExitComplete below only fires once that animation (and the dialog with it)
      // is actually gone, so the two are never on screen, and trapping focus, at the same time.
      setWorldPendingBackupOffer(world)
      return
    }
    void deleteWorld(world)
  }

  function offerBackupBeforeDelete(): void {
    if (!worldPendingBackupOffer) return
    const world = worldPendingBackupOffer
    setWorldPendingBackupOffer(null)
    setPendingConfirmation({
      question: t("features.worlds.backupBeforeDelete", { name: world.name, ...RAW_NAME }),
      confirmLabel: t("features.worlds.backup"),
      confirmIcon: <PiArchiveDuotone />,
      confirmVariant: "primary",
      run: async () => {
        if (await backup(world)) await deleteWorld(world)
      }
    })
  }

  async function performRestore(backup: WorldBackupType): Promise<void> {
    if (!installation || isPlaying) return
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

  function restore(backup: WorldBackupType): void {
    if (!installation || isPlaying) return
    setPendingConfirmation({
      question: t("features.worlds.confirmRestore", { name: backup.worldName, ...RAW_NAME }),
      confirmLabel: t("generic.restore"),
      confirmIcon: <PiArrowCounterClockwiseDuotone />,
      run: () => performRestore(backup)
    })
  }

  async function performDeleteWorldBackup(backup: WorldBackupType): Promise<void> {
    if (!installation || isPlaying) return
    let result: WorldOperationResult
    try {
      result = await window.api.worldsManager.deleteBackup(installation.id, backup.id)
    } catch {
      return addNotification(t("features.worlds.error.operation-failed"), "error")
    }
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    configDispatch({
      type: CONFIG_ACTIONS.EDIT_INSTALLATION,
      payload: {
        id: installation.id,
        updates: {
          worldBackups: (installation.worldBackups ?? []).filter((candidate) => candidate.id !== backup.id)
        }
      }
    })
    addNotification(t("features.backups.backupDeletedSuccesfully"), "success")
    await refresh()
  }

  function requestDeleteWorldBackup(backup: WorldBackupType): void {
    if (!installation || isPlaying) return
    setPendingConfirmation({
      title: t("features.backups.deleteBackup"),
      question: t("features.backups.areYouSureDelete"),
      consequence: t("features.backups.deletingNotReversible"),
      confirmLabel: t("generic.delete"),
      confirmIcon: <PiTrashDuotone />,
      confirmVariant: "destructive",
      run: () => performDeleteWorldBackup(backup)
    })
  }

  async function performTransfer(world: WorldType, targetInstallation: InstallationType, mode: "copy" | "move"): Promise<void> {
    if (!installation || isPlaying || targetInstallation._playing) return
    const result = await window.api.worldsManager.transfer(installation.id, world.name, targetInstallation.id, mode)
    if (!result.ok) return addNotification(t(`features.worlds.error.${result.reason}`), "error")
    addNotification(
      result.warning ? t("features.worlds.versionWarning", { name: result.targetWorldName, ...RAW_NAME }) : t("features.worlds.transferDone", { name: result.targetWorldName, ...RAW_NAME }),
      result.warning ? "warning" : "success"
    )
    await refresh()
  }

  function transfer(world: WorldType, mode: "copy" | "move"): void {
    if (!installation || isPlaying || isTargetPlaying || !targetId || targetId === installation.id) return addNotification(t("features.worlds.chooseTarget"), "error")
    if (!target) return
    setPendingConfirmation({
      question: t("features.worlds.confirmTransfer", { name: world.name, target: target.name, ...RAW_NAME }),
      ...(mode === "move" ? { consequence: t("features.worlds.confirmMove", { name: world.name, target: target.name, ...RAW_NAME }) } : {}),
      confirmLabel: t(mode === "move" ? "features.worlds.move" : "features.worlds.copy"),
      confirmIcon: mode === "move" ? <PiTruckDuotone /> : <PiCopyDuotone />,
      // Move removes the source after copying, so it keeps the destructive default; copy only adds one.
      confirmVariant: mode === "move" ? "destructive" : "primary",
      run: () => performTransfer(world, target, mode)
    })
  }

  if (!installation) return <div className="p-8">{t("features.installations.noInstallationFound")}</div>

  const backupOnly = new Map<string, WorldType>()
  for (const backup of installation.worldBackups ?? []) {
    const key = backup.worldName
    if (worlds.some((world) => world.name === key) || backupOnly.has(key)) continue
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
          <div className="relative z-10 flex items-center justify-between p-3">
            <div>
              <h1 className="text-2xl font-bold">{t("features.worlds.title")}</h1>
              <p className="text-zinc-400">{installation.name}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <select className="bg-zinc-800 rounded p-2" value={targetId} onChange={(event) => setTargetId(event.target.value)} aria-label={t("features.worlds.transferTarget")}>
                <option value="">{t("features.worlds.transferTarget")}</option>
                {installations
                  .filter((candidate) => candidate.id !== installation.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {worldVersionWarning(installation.version, candidate.version) ? ` (${t("features.worlds.differentVersion")})` : ""}
                    </option>
                  ))}
              </select>
              {target && worldVersionWarning(installation.version, target.version) && (
                <p role="status" className="max-w-xs text-right text-xs text-amber-300">
                  {t("features.worlds.versionCompatibilityWarning")}
                </p>
              )}
            </div>
          </div>
          {loading && <p className="relative p-4 text-center text-zinc-400">{t("generic.reloading")}</p>}
          {!loading && displayWorlds.length === 0 && <p className="relative p-4 text-center">{t("features.worlds.empty")}</p>}
          <ListGroup>
            {displayWorlds.map((world) => {
              const liveWorld = worlds.some((candidate) => candidate.name === world.name)
              const backups = (installation.worldBackups ?? []).filter((backup) => backup.worldName === world.name)
              return (
                <ListItem key={world.name}>
                  <div className="flex flex-wrap items-center gap-3 p-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold truncate">
                        {world.name}
                        {world.isDefault ? ` · ${t("generic.default")}` : ""}
                      </p>
                      <p className="text-sm text-zinc-400">
                        {liveWorld ? formatBytes(world.size) : t("features.worlds.backupOnly")} · {formatDateTime(world.lastModified)} · {t("features.worlds.backupCount", { count: backups.length })}
                      </p>
                    </div>
                    {liveWorld && (
                      <NormalButton title={t("features.worlds.backup")} variant="ghost" className="p-1" disabled={isPlaying} onClick={() => requestBackup(world)}>
                        <PiArchiveDuotone />
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
                      <span>{formatDateTime(backup.date)}</span>
                      <NormalButton title={t("generic.restore")} variant="ghost" className="p-1" disabled={isPlaying} onClick={() => void restore(backup)}>
                        <PiArrowCounterClockwiseDuotone />
                      </NormalButton>
                      <NormalButton title={t("features.backups.deleteBackup")} variant="ghost" className="p-1" disabled={isPlaying} onClick={() => requestDeleteWorldBackup(backup)}>
                        <PiTrashDuotone />
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
        <ConfirmDialog
          title={pendingConfirmation?.title ?? t("breadcrumbs.manageWorlds")}
          isOpen={pendingConfirmation !== null}
          close={() => setPendingConfirmation(null)}
          question={pendingConfirmation?.question}
          consequence={pendingConfirmation?.consequence}
          confirmLabel={pendingConfirmation?.confirmLabel ?? t("generic.cancel")}
          confirmIcon={pendingConfirmation?.confirmIcon ?? <PiCopyDuotone />}
          confirmVariant={pendingConfirmation?.confirmVariant ?? "destructive"}
          onConfirm={() => {
            const confirmation = pendingConfirmation
            setPendingConfirmation(null)
            if (confirmation) void confirmation.run()
          }}
        />
        <PopupDialogPanel title={t("generic.delete")} isOpen={worldToDelete !== null} close={closeDeleteDialog} onExitComplete={offerBackupBeforeDelete}>
          <>
            <div className="flex flex-col gap-1 text-left">
              <label htmlFor={deleteNameId}>{t("features.worlds.confirmDelete", { name: worldToDelete?.name ?? "", ...RAW_NAME })}</label>
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
