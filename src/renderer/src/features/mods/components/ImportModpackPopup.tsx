import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { PiCheckCircleDuotone, PiProhibitInsetDuotone, PiDownloadDuotone, PiMinusCircleDuotone, PiWarningDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"
import clsx from "clsx"

import { executeModpackImport, modpackDowngrades, modpackEntriesToResolve, modpackRowLabel, modpackRowStatus, planModpackImport } from "@domain/mods/importModpack"
import type { ModpackEntryStatus, ModpackModDetail, ModpackPlanItem, ModpackRowStatus, ModpackRowStatusKind } from "@domain/mods/importModpack"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { toInstalledModSnapshot, toModChangeSummaryEntry, toModpackModDetail } from "@renderer/features/mods/adapters/importModpack"
import { useInstallMod } from "../hooks/useInstallMod"
import { useQueryMod } from "../hooks/useQueryMod"

import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { FormButton } from "@renderer/components/ui/FormComponents"
import ModChangeSummaryPopup from "./ModChangeSummaryPopup"

/**
 * What one row of the table shows: what the plan intends, the two states of an entry in flight, then
 * whatever it settled on.
 */
type ModStatus = "pending" | "downloading" | ModpackEntryStatus | ModpackRowStatusKind

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
  const [details, setDetails] = useState<ReadonlyMap<string, ModpackModDetail> | null>(null)
  const [failedModids, setFailedModids] = useState<ReadonlySet<string>>(new Set())
  // Bumped by the retry action to re-run the resolution effect below on the same manifest, the
  // same way a dependency change would.
  const [retryCount, setRetryCount] = useState(0)

  const installed = useMemo(() => installedMods.map(toInstalledModSnapshot), [installedMods])

  const downgradedMods = useMemo(() => {
    if (!manifest) return []
    return modpackDowngrades(manifest.mods, installed)
  }, [manifest, installed])

  /**
   * The lookups run when the manifest opens rather than when Import is clicked.
   *
   * They cost the same either way, the import needs them regardless, and running them first is what
   * lets the table name a mod and say what will happen to it before the player commits to anything.
   * Only the entries the folder does not already satisfy are asked about, as before.
   */
  useEffect(() => {
    if (!manifest) return

    let cancelled = false
    setDetails(null)
    setFailedModids(new Set())

    void (async (): Promise<void> => {
      const toResolve = modpackEntriesToResolve(manifest.mods, installed)
      const fetched = await Promise.all(toResolve.map(async (entry) => [entry.modid, await queryMod({ modid: entry.modid })] as const))
      if (cancelled) return

      const resolved = new Map<string, ModpackModDetail>()
      const failed = new Set<string>()
      for (const [modid, outcome] of fetched) {
        if (outcome.status === "found") resolved.set(modid, toModpackModDetail(outcome.mod))
        else if (outcome.status === "failed") failed.add(modid)
      }
      setDetails(resolved)
      setFailedModids(failed)
    })()

    return (): void => {
      cancelled = true
    }
  }, [manifest, installed, queryMod, retryCount])

  const retryLookups = (): void => setRetryCount((n) => n + 1)

  const plan = useMemo(() => {
    if (!manifest || !details) return null
    return planModpackImport({ entries: manifest.mods, installed, gameVersion: installation.version, details, failedModids })
  }, [manifest, details, installed, installation.version, failedModids])

  const planByModid = useMemo(() => new Map((plan?.items ?? []).map((item): [string, ModpackPlanItem] => [item.modid, item])), [plan])

  const notOnModDbCount = useMemo(() => (plan?.items ?? []).filter((item) => item.decision === "skip" && item.reason === "not-on-moddb").length, [plan])

  const lookupFailedCount = useMemo(() => (plan?.items ?? []).filter((item) => item.decision === "skip" && item.reason === "lookup-failed").length, [plan])

  // True once the lookups have come back and every single one of them failed: nothing here was
  // ever a clean 404, so the table would be one long, wrong "not on the mod database" list. The
  // manifest is shown instead as unreachable rather than as a plan nobody can trust.
  const allLookupsFailed = useMemo(() => {
    if (!manifest || !details) return false
    const toResolve = modpackEntriesToResolve(manifest.mods, installed)
    return toResolve.length > 0 && toResolve.every((entry) => failedModids.has(entry.modid))
  }, [manifest, installed, details, failedModids])

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
    if (!manifest || !plan) return

    // The same precondition every sibling flow has. Importing a pack writes to the Mods folder just
    // as an update does, and it was the one write that ran straight through a backup.
    if (installation._backuping || installation._restoringBackup) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")

    setImporting(true)

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
                <NormalButton
                  variant="link"
                  title={t("features.mods.importModpackDowngradeBackupLink")}
                  className="shrink-0 text-orange-300 hover:text-orange-200"
                  onClick={() => {
                    handleClose()
                    navigate(`/installations/backups/${installation.id}`)
                  }}
                >
                  {t("features.mods.importModpackDowngradeBackupLink")}
                </NormalButton>
              </div>
            )}

            {allLookupsFailed ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-zinc-400">
                <PiWarningDuotone className="text-3xl text-red-400" />
                <p>{t("features.mods.importModpackLookupUnreachable")}</p>
                <NormalButton variant="primary" title={t("features.mods.importModpackRetry")} onClick={retryLookups}>
                  {t("features.mods.importModpackRetry")}
                </NormalButton>
              </div>
            ) : (
              <>
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
                        const live = modStatuses[mod.modid] || "pending"
                        const item = planByModid.get(mod.modid)
                        const label = modpackRowLabel(mod, item?.name)
                        // The plan owns the row until the import starts moving it: once an entry is
                        // downloading or settled, what happened outranks what was going to happen.
                        const planned = live === "pending" && item ? modpackRowStatus(item) : undefined
                        const status: ModStatus = planned?.kind ?? live
                        return (
                          <TableBodyRow key={mod.modid}>
                            <TableCell className="w-5/12 overflow-hidden">
                              <p className="overflow-hidden whitespace-nowrap text-ellipsis">{label}</p>
                              {label !== mod.modid && <p className="overflow-hidden whitespace-nowrap text-ellipsis text-xs text-zinc-400">{mod.modid}</p>}
                            </TableCell>
                            <TableCell className="w-3/12">{mod.version}</TableCell>
                            <TableCell className="w-4/12">
                              <span className={clsx("flex items-center gap-1 text-sm", statusColor(status))}>
                                <StatusIcon status={status} className="shrink-0" />
                                {statusLabel(status, t, planned)}
                              </span>
                            </TableCell>
                          </TableBodyRow>
                        )
                      })}
                  </TableBody>
                </TableWrapper>

                {notOnModDbCount > 0 && <p className="text-sm text-zinc-400">{t("features.mods.importModpackNotOnModDbNote", { count: notOnModDbCount })}</p>}

                {lookupFailedCount > 0 && (
                  <div className="flex items-center justify-between gap-4 text-sm text-orange-300">
                    <span>{t("features.mods.importModpackLookupFailedNote", { count: lookupFailedCount })}</span>
                    <NormalButton variant="link" title={t("features.mods.importModpackRetry")} className="shrink-0 text-orange-300 hover:text-orange-200" onClick={retryLookups}>
                      {t("features.mods.importModpackRetry")}
                    </NormalButton>
                  </div>
                )}

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
                    <FormButton
                      title={plan ? t("features.mods.importModpackButton") : t("features.mods.importModpackChecking")}
                      className="p-1 px-4 h-8"
                      onClick={handleImport}
                      variant="primary"
                      disabled={manifest.mods.length === 0 || !plan}
                    >
                      {plan ? <PiDownloadDuotone className="text-xl" /> : <FiLoader className="animate-spin text-xl" />}
                      <p>{plan ? t("features.mods.importModpackButton") : t("features.mods.importModpackChecking")}</p>
                    </FormButton>
                  ) : (
                    <FormButton title={t("features.mods.importModpackImporting")} className="p-1 px-4 h-8" variant="primary" disabled onClick={() => {}}>
                      <FiLoader className="animate-spin text-xl" />
                      <p>{t("features.mods.importModpackImporting")}</p>
                    </FormButton>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </>
    </PopupDialogPanel>
  )
}

function StatusIcon({ status, className }: Readonly<{ status: ModStatus; className?: string }>): JSX.Element {
  switch (status) {
    case "installed":
      return <PiCheckCircleDuotone className={className} />
    case "already-present":
      return <PiMinusCircleDuotone className={className} />
    case "downloading":
      return <FiLoader className={clsx("animate-spin", className)} />
    case "downgrade":
    case "replace":
      return <PiWarningDuotone className={className} />
    case "new":
    case "update":
    case "pending":
      return <PiDownloadDuotone className={className} />
    default:
      return <PiProhibitInsetDuotone className={className} />
  }
}

function statusColor(status: ModStatus): string {
  switch (status) {
    case "installed":
      return "text-green-400"
    case "already-present":
      return "text-zinc-400"
    case "downloading":
    case "update":
      return "text-blue-400"
    case "downgrade":
    case "replace":
      return "text-orange-300"
    // Kept last in its group and on its own line: tests/text-contrast.test.ts reads the colour of a
    // pending row straight out of this switch.
    case "new":
    case "pending":
      return "text-zinc-400"
    default:
      return "text-red-400"
  }
}

function statusLabel(status: ModStatus, t: (key: string, options?: Record<string, unknown>) => string, planned?: ModpackRowStatus): string {
  const versions = { from: planned?.fromVersion ?? "", to: planned?.toVersion ?? "" }

  switch (status) {
    case "new":
      return t("features.mods.importModpackStatusNew")
    case "update":
      return t("features.mods.importModpackStatusUpdate", versions)
    case "downgrade":
      return t("features.mods.importModpackStatusDowngrade", versions)
    case "replace":
      return t("features.mods.importModpackStatusReplace", versions)
    case "installed":
      return t("features.mods.importModpackStatusDone")
    case "already-present":
      return t("features.mods.importModpackAlreadyPresent")
    case "downloading":
      return t("features.mods.importModpackStatusDownloading")
    case "not-on-moddb":
      return t("features.mods.importModpackNotFound")
    case "lookup-failed":
      return t("features.mods.importModpackLookupFailed")
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
