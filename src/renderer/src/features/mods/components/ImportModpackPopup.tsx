import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { PiCheckCircleDuotone, PiProhibitInsetDuotone, PiDownloadDuotone, PiMinusCircleDuotone, PiWarningDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"
import clsx from "clsx"

import { executeModpackImport, modpackDowngrades, modpackEntriesToResolve, planModpackImport } from "@domain/mods/importModpack"
import type { ModpackEntryStatus, ModpackModDetail } from "@domain/mods/importModpack"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { toInstalledModSnapshot, toModChangeSummaryEntry, toModpackModDetail } from "@renderer/features/mods/adapters/importModpack"
import { useInstallMod } from "../hooks/useInstallMod"
import { useQueryMod } from "../hooks/useQueryMod"

import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { FormButton } from "@renderer/components/ui/FormComponents"
import ModChangeSummaryPopup from "./ModChangeSummaryPopup"

/** What one row of the table shows: the two states of an entry in flight, then whatever it settled on. */
type ModStatus = "pending" | "downloading" | ModpackEntryStatus

function ImportModpackPopup({
  isOpen,
  manifest,
  close,
  installation,
  installedMods,
  onFinish
}: Readonly<{
  isOpen: boolean
  manifest: ModpackManifestType | null
  close: () => void
  installation: InstallationType
  installedMods: InstalledModType[]
  onFinish: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { addNotification } = useNotificationsContext()
  const installMod = useInstallMod()
  const queryMod = useQueryMod()

  const [modStatuses, setModStatuses] = useState<Record<string, ModStatus>>({})
  const [importing, setImporting] = useState(false)
  const [summaryEntries, setSummaryEntries] = useState<ModChangeSummaryEntry[]>([])
  const [showSummary, setShowSummary] = useState(false)

  const downgradedMods = useMemo(() => {
    if (!manifest) return []
    return modpackDowngrades(manifest.mods, installedMods.map(toInstalledModSnapshot))
  }, [manifest, installedMods])

  const completedCount = useMemo(() => {
    return Object.values(modStatuses).filter((s) => s !== "pending" && s !== "downloading").length
  }, [modStatuses])

  const totalCount = manifest?.mods.length ?? 0
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  function updateStatus(modid: string, status: ModStatus): void {
    setModStatuses((prev) => ({ ...prev, [modid]: status }))
  }

  function getInitialStatuses(mods: ModpackModEntryType[]): Record<string, ModStatus> {
    const statuses: Record<string, ModStatus> = {}
    for (const mod of mods) {
      statuses[mod.modid] = "pending"
    }
    return statuses
  }

  async function handleImport(): Promise<void> {
    if (!manifest) return

    // The same precondition every sibling flow has. Importing a pack writes to the Mods folder just
    // as an update does, and it was the one write that ran straight through a backup.
    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")

    setImporting(true)

    const installed = installedMods.map(toInstalledModSnapshot)

    // Only the entries the folder does not already satisfy cost a lookup, which is what the old
    // interleaved loop achieved by checking the folder before it queried.
    const toResolve = modpackEntriesToResolve(manifest.mods, installed)
    const fetched = await Promise.all(toResolve.map(async (entry) => [entry.modid, await queryMod({ modid: entry.modid })] as const))

    const details = new Map<string, ModpackModDetail>()
    for (const [modid, mod] of fetched) {
      if (mod) details.set(modid, toModpackModDetail(mod))
    }

    const plan = planModpackImport({ entries: manifest.mods, installed, gameVersion: installation.version, details })

    const collected: ModChangeSummaryEntry[] = []

    await executeModpackImport(
      {
        installer: {
          install: (item) =>
            installMod({
              installationPath: installation.path,
              outName: installation.name,
              modName: item.name,
              release: item.release,
              existing: item.existing
            })
        }
      },
      { plan },
      {
        onEntryStarted: (modid) => updateStatus(modid, "downloading"),
        onEntrySettled: (report) => {
          updateStatus(report.modid, report.status)
          collected.push(toModChangeSummaryEntry(report))
        }
      }
    )

    setImporting(false)
    setSummaryEntries(collected)
    setShowSummary(true)
  }

  function handleClose(): void {
    if (importing) return
    setModStatuses({})
    setImporting(false)
    setSummaryEntries([])
    setShowSummary(false)
    close()
  }

  useEffect(() => {
    if (manifest) {
      setModStatuses(getInitialStatuses(manifest.mods))
      setSummaryEntries([])
      setShowSummary(false)
    }
  }, [manifest])

  if (showSummary) {
    return (
      <ModChangeSummaryPopup
        isOpen={isOpen}
        close={() => {
          handleClose()
          onFinish()
        }}
        title={t("features.mods.importSummaryTitle")}
        entries={summaryEntries}
      />
    )
  }

  return (
    <PopupDialogPanel title={t("features.mods.importModpackTitle")} isOpen={isOpen} close={handleClose} fixedWidth={false}>
      <>
        {manifest && (
          <>
            <p>{t("features.mods.importModpackDesc", { name: manifest.name })}</p>

            {manifest.gameVersion !== installation.version && (
              <p className="text-yellow-400 text-sm">{t("features.mods.importModpackVersionWarning", { packVersion: manifest.gameVersion, installVersion: installation.version })}</p>
            )}

            {downgradedMods.length > 0 && (
              <div className="flex items-center justify-between gap-4 rounded-sm bg-orange-500/10 border border-orange-500/30 px-3 py-2 text-sm text-orange-300">
                <span className="flex items-center gap-2">
                  <PiWarningDuotone className="text-lg shrink-0" />
                  {t("features.mods.importModpackDowngradeWarning", { count: downgradedMods.length })}
                </span>
                <button
                  className="shrink-0 underline hover:text-orange-200 duration-150"
                  onClick={() => {
                    handleClose()
                    navigate(`/installations/backups/${installation.id}`)
                  }}
                >
                  {t("features.mods.importModpackDowngradeBackupLink")}
                </button>
              </div>
            )}

            <TableWrapper className="w-[40rem]">
              <TableHead>
                <TableHeadRow>
                  <TableCell className="w-5/12">{t("generic.name")}</TableCell>
                  <TableCell className="w-3/12">{t("generic.version")}</TableCell>
                  <TableCell className="w-4/12">{t("generic.status")}</TableCell>
                </TableHeadRow>
              </TableHead>

              <TableBody className="max-h-[18rem]">
                {[...manifest.mods]
                  .sort((a, b) => a.modid.localeCompare(b.modid))
                  .map((mod) => {
                    const status = modStatuses[mod.modid] || "pending"
                    return (
                      <TableBodyRow key={mod.modid}>
                        <TableCell className="w-5/12 overflow-hidden whitespace-nowrap text-ellipsis">{mod.modid}</TableCell>
                        <TableCell className="w-3/12">{mod.version}</TableCell>
                        <TableCell className="w-4/12">
                          <span className={clsx("flex items-center justify-center gap-1 text-sm", statusColor(status))}>
                            <StatusIcon status={status} />
                            {statusLabel(status, t)}
                          </span>
                        </TableCell>
                      </TableBodyRow>
                    )
                  })}
              </TableBody>
            </TableWrapper>

            {importing && (
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>{t("features.mods.importModpackProgress", { completed: completedCount, total: totalCount })}</span>
                  <span>{Math.round(progressPct)}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-zinc-700/50">
                  <div className="h-full rounded-full bg-vs transition-all duration-300" style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            )}

            <div className="flex gap-2 justify-center">
              {!importing ? (
                <FormButton title={t("features.mods.importModpackButton")} className="p-1 px-4 h-8" onClick={handleImport} type="success" disabled={manifest.mods.length === 0}>
                  <PiDownloadDuotone className="text-xl" />
                  <p>{t("features.mods.importModpackButton")}</p>
                </FormButton>
              ) : (
                <FormButton title={t("features.mods.importModpackImporting")} className="p-1 px-4 h-8" type="normal" disabled onClick={() => {}}>
                  <FiLoader className="animate-spin text-xl" />
                  <p>{t("features.mods.importModpackImporting")}</p>
                </FormButton>
              )}
            </div>
          </>
        )}
      </>
    </PopupDialogPanel>
  )
}

function StatusIcon({ status }: Readonly<{ status: ModStatus }>): JSX.Element {
  switch (status) {
    case "installed":
      return <PiCheckCircleDuotone />
    case "already-present":
      return <PiMinusCircleDuotone />
    case "downloading":
      return <FiLoader className="animate-spin" />
    case "pending":
      return <PiDownloadDuotone />
    default:
      return <PiProhibitInsetDuotone />
  }
}

function statusColor(status: ModStatus): string {
  switch (status) {
    case "installed":
      return "text-green-400"
    case "already-present":
      return "text-zinc-400"
    case "downloading":
      return "text-blue-400"
    case "pending":
      return "text-zinc-500"
    default:
      return "text-red-400"
  }
}

function statusLabel(status: ModStatus, t: (key: string) => string): string {
  switch (status) {
    case "installed":
      return t("features.mods.importModpackStatusDone")
    case "already-present":
      return t("features.mods.importModpackAlreadyPresent")
    case "downloading":
      return t("features.mods.importModpackStatusDownloading")
    case "not-on-moddb":
      return t("features.mods.importModpackNotFound")
    case "no-release":
      return t("features.mods.importModpackNoRelease")
    case "old-version-delete-failed":
      return t("features.mods.importModpackOldVersionStuck")
    case "pending":
      return t("features.mods.importModpackStatusPending")
    default:
      return t("features.mods.importModpackStatusFailed")
  }
}

export default ImportModpackPopup
