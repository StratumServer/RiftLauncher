import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import { FiLoader } from "react-icons/fi"
import { PiClipboardTextDuotone, PiFolderOpenDuotone } from "react-icons/pi"

import { formatReportText, type ReportLine, type ReportModGroup } from "@domain/gameLogs/report"
import { copyReportText } from "@renderer/features/installations/adapters/logReport"
import { useSessionReport } from "@renderer/features/installations/hooks/useSessionReport"
import { useOpenPathInExplorer } from "@renderer/features/installations/hooks/usePathActions"
import { useInstallations } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import DropdownSection from "@renderer/components/ui/DropdownSection"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { TableWrapper } from "@renderer/components/ui/Table"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"

/**
 * The one place in this feature that paints a colour of its own: an error count and a warning
 * count, on the table fill inside a section. Both are pinned by tests/text-contrast.test.ts.
 */
const SEVERITY_COLORS = { error: "text-red-400", warning: "text-amber-400" } as const

const VERDICT_KEYS = {
  "crashed-in-mod": "features.sessionReport.verdictCrashedInMod",
  crashed: "features.sessionReport.verdictCrashed",
  errors: "features.sessionReport.verdictErrors",
  clean: "features.sessionReport.verdictClean"
} as const

const SIGNAL_KEYS = {
  "modid-prefix": "features.sessionReport.signalLogLine",
  assembly: "features.sessionReport.signalAssembly",
  "crash-file": "features.sessionReport.signalCrashFile"
} as const

const LANDMARK_KEYS = {
  mods: "features.sessionReport.landmarkMods",
  modSystems: "features.sessionReport.landmarkModSystems",
  blocks: "features.sessionReport.landmarkBlocks"
} as const

function LogLines({ lines }: Readonly<{ lines: readonly ReportLine[] }>): JSX.Element {
  return (
    <TableWrapper className="p-2 text-xs font-mono">
      {lines.map((line, index) => (
        <div key={`${line.clock ?? ""}-${index}`} className="py-0.5">
          <p className="break-words">
            <span className="text-zinc-400">{line.clock ? `${line.clock} ` : ""}</span>
            <span className={line.severity.toLowerCase() === "error" ? SEVERITY_COLORS.error : SEVERITY_COLORS.warning}>{`[${line.severity}] `}</span>
            {line.text}
          </p>
          {line.continuation.map((frame, frameIndex) => (
            <p key={frameIndex} className="pl-4 text-zinc-400 break-words">
              {frame}
            </p>
          ))}
        </div>
      ))}
    </TableWrapper>
  )
}

function ModSection({ mod }: Readonly<{ mod: ReportModGroup }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="w-full flex flex-col gap-1">
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="text-lg">{mod.name ?? mod.modid}</span>
        <span className={SEVERITY_COLORS.error}>{t("features.sessionReport.errorCount", { count: mod.errors })}</span>
        <span className={SEVERITY_COLORS.warning}>{t("features.sessionReport.warningCount", { count: mod.warnings })}</span>
        <span className="text-sm text-zinc-400">{t(SIGNAL_KEYS[mod.signal])}</span>
      </p>
      <LogLines lines={mod.lines} />
    </div>
  )
}

function SessionReport(): JSX.Element {
  const { id } = useParams()
  const { t, i18n } = useTranslation()
  const installations = useInstallations()
  const { addNotification } = useNotificationsContext()
  const openPathInExplorer = useOpenPathInExplorer()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [copying, setCopying] = useState(false)

  const installation = installations.find((candidate) => candidate.id === id)
  const { status, report } = useSessionReport(installation?.path)

  async function handleCopy(): Promise<void> {
    if (!report) return
    setCopying(true)
    const copied = await copyReportText(formatReportText(report))
    setCopying(false)
    addNotification(t(copied ? "features.sessionReport.copied" : "features.sessionReport.copyFailed"), copied ? "success" : "error")
  }

  async function handleOpenLogs(): Promise<void> {
    if (!installation) return
    await openPathInExplorer(await window.api.pathsManager.formatPath([installation.path, "Logs"]))
  }

  const lastWritten = report?.source.lastWrittenAtMs
  const provenance =
    report && report.source.fileName
      ? t("features.sessionReport.provenance", {
          file: report.source.fileName,
          when: lastWritten ? new Date(lastWritten).toLocaleString(i18n.language, { dateStyle: "long", timeStyle: "short" }) : t("features.sessionReport.unknownTime")
        })
      : null

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to={installation ? `/installations/edit/${installation.id}` : "/installations"} />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs
              breadcrumbs={[
                { name: t("breadcrumbs.installations"), to: "/installations" },
                { name: t("breadcrumbs.sessionReport"), to: installation ? `/installations/report/${installation.id}` : "/installations" }
              ]}
            />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <div className="max-w-[50rem] w-full flex flex-col justify-center gap-4 my-auto">
          {status === "loading" && (
            <p className="w-full flex items-center justify-center gap-2 py-8">
              <FiLoader className="animate-spin text-3xl text-zinc-400" /> {t("features.sessionReport.loading")}
            </p>
          )}

          {status === "no-logs" && <p className="text-center text-xl py-8">{t("features.sessionReport.noLogs")}</p>}
          {status === "failed" && <p className="text-center text-xl py-8">{t("features.sessionReport.unreadable")}</p>}

          {status === "ready" && report && (
            <>
              <h1 className="text-center text-3xl font-bold">
                {report.verdict.kind === "crashed-in-mod" ? t(VERDICT_KEYS["crashed-in-mod"], { mod: report.verdict.modLabel }) : t(VERDICT_KEYS[report.verdict.kind])}
              </h1>

              {provenance && <p className="text-center text-sm text-zinc-400">{provenance}</p>}
              {report.source.truncated && <p className="text-center text-sm text-zinc-400">{t("features.sessionReport.truncated")}</p>}

              {report.crash && (
                <DropdownSection title={t("features.sessionReport.crashTitle")}>
                  {report.crash.modLabel && <p>{t("features.sessionReport.crashBlames", { mod: report.crash.modLabel, version: report.crash.modVersion ?? "" })}</p>}
                  {report.crash.exceptionType && (
                    <p className="font-mono text-xs break-words">
                      {report.crash.exceptionType}
                      {report.crash.exceptionMessage ? `: ${report.crash.exceptionMessage}` : ""}
                    </p>
                  )}
                  {report.crash.otherPatchLabels.map((label) => (
                    <p key={label} className="text-sm text-zinc-400">
                      {t("features.sessionReport.crashPatchNote", { mod: label })}
                    </p>
                  ))}
                  {report.crash.frames.length > 0 && (
                    <TableWrapper className="p-2 text-xs font-mono">
                      {report.crash.frames.map((frame, index) => (
                        <p key={index} className="break-words text-zinc-400">
                          {frame}
                        </p>
                      ))}
                    </TableWrapper>
                  )}
                </DropdownSection>
              )}

              {report.mods.length > 0 && (
                <DropdownSection title={t("features.sessionReport.byModTitle")}>
                  {report.mods.map((mod) => (
                    <ModSection key={mod.modid} mod={mod} />
                  ))}
                </DropdownSection>
              )}

              {(report.startup.phases.length > 0 || report.startup.landmarks.length > 0) && (
                <DropdownSection title={t("features.sessionReport.startupTitle")} startOpen={false}>
                  {report.startup.landmarks.map((landmark) => (
                    <p key={landmark.kind}>{t(LANDMARK_KEYS[landmark.kind], { count: landmark.count })}</p>
                  ))}
                  <TableWrapper className="p-2 text-sm">
                    {report.startup.phases.map((phase) => (
                      <p key={phase.name}>{phase.seconds ? t("features.sessionReport.phaseElapsed", { name: phase.name, seconds: phase.seconds }) : phase.name}</p>
                    ))}
                  </TableWrapper>
                </DropdownSection>
              )}

              {report.unattributed.length > 0 && (
                <DropdownSection title={t("features.sessionReport.anythingElseTitle")} startOpen={false}>
                  <LogLines lines={report.unattributed} />
                </DropdownSection>
              )}

              <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
                <FormButton onClick={handleCopy} busy={copying} title={t("features.sessionReport.copyReport")} variant="primary" size="md" icon={<PiClipboardTextDuotone />} />
                <FormButton onClick={handleOpenLogs} title={t("features.sessionReport.openLogsFolder")} variant="secondary" size="md" icon={<PiFolderOpenDuotone />} />
              </ButtonsWrapper>
              <p className="text-center text-sm text-zinc-400">{t("features.sessionReport.copyReportDesc")}</p>
            </>
          )}
        </div>
      </div>
    </ScrollableContainer>
  )
}

export default SessionReport
