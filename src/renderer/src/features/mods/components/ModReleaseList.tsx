import { useTranslation } from "react-i18next"
import { PiDownloadDuotone, PiArrowClockwiseDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"
import clsx from "clsx"

import { evaluateModCompatibility } from "@domain/mods/compatibility"
import type { ModCompatibilityVerdict } from "@domain/mods/compatibility"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { toInstalledModCopy, toModReleaseToInstall } from "@renderer/features/mods/adapters/install"

import { useInstallMod } from "../hooks/useInstallMod"

import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { ReloadButton } from "@renderer/components/ui/StickyMenu"

/** Button styling for what the author declared about a release. Undeclared keeps its long-standing red. */
const COMPATIBILITY_STYLE: Record<ModCompatibilityVerdict, { className: string; titleKey: string }> = {
  declared: { className: "text-lime-600", titleKey: "features.mods.worksOnTheVersion" },
  "same-minor": { className: "text-yellow-400", titleKey: "features.mods.shouldWorkOnTheVersion" },
  undeclared: { className: "text-red-700", titleKey: "features.mods.probablyDontWorkOnTheVersion" }
}

export interface IInstallationToInstallModIn {
  installation: InstallationType
  oldMod?: InstalledModType
}

/**
 * A mod's installable releases with the compatibility colouring, shared by the browse flow (a page
 * of its own) and the update flow inside an installation (still a popup). Keeping one copy means a
 * compatibility rule or an install side effect cannot end up differing between the two.
 */
function ModReleaseList({
  mod: downloadableModToInstall,
  loading,
  failed,
  retry,
  modToInstall,
  modName,
  installation,
  onInstallStarted,
  onFinishInstallation,
  className
}: Readonly<{
  // The catalog is passed in rather than fetched here: both callers need the mod's name for their
  // own heading, and a second useModReleaseCatalog in this component queried the ModDB twice.
  mod: DownloadableModType | null
  loading: boolean
  failed: boolean
  retry: () => void
  modToInstall: number | string | null
  modName?: string
  installation?: IInstallationToInstallModIn
  /** Runs the moment a download is queued: the popup closes on it, the page navigates back. */
  onInstallStarted?: () => void
  onFinishInstallation?: () => void
  className?: string
}>): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const installMod = useInstallMod()

  return (
    <TableWrapper className={clsx("w-full max-w-[50rem]", className)}>
      <TableHead>
        <TableHeadRow>
          <TableCell className="w-2/12">{t("generic.version")}</TableCell>
          <TableCell className="w-3/12">{t("generic.releaseDate")}</TableCell>
          <TableCell className="w-5/12">{t("features.versions.labelGameVersions")}</TableCell>
          <TableCell className="w-2/12">{t("generic.actions")}</TableCell>
        </TableHeadRow>
      </TableHead>

      {failed ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10">
          <p className="text-sm text-zinc-400">{t("features.mods.versionsLoadFailed")}</p>
          <ReloadButton onClick={retry} reloading={loading} />
        </div>
      ) : !downloadableModToInstall ? (
        <div className="flex items-center justify-center py-10">
          <FiLoader className="animate-spin text-3xl text-zinc-400" />
        </div>
      ) : (
        <TableBody className="max-h-[18rem]">
          {downloadableModToInstall.releases.map((release) => {
            const compatibility = installation ? COMPATIBILITY_STYLE[evaluateModCompatibility(release.tags, installation.installation.version)] : undefined

            return (
              <TableBodyRow key={release.releaseid}>
                <TableCell className="w-2/12">{release.modversion}</TableCell>
                <TableCell className="w-3/12">{new Date(release.created).toLocaleDateString("es")}</TableCell>
                <TableCell className="w-5/12 overflow-hidden whitespace-nowrap text-ellipsis">
                  <input type="text" value={release.tags.join(", ")} readOnly className="w-full bg-transparent outline-hidden text-center" />
                </TableCell>
                <TableCell className="w-2/12 flex gap-2 items-center justify-center text-lg">
                  {installation && compatibility && (
                    <FormButton
                      disabled={installation.oldMod?.version === release.modversion}
                      onClick={() => {
                        if (installation.installation._backuping || installation.installation._restoringBackup) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")

                        const oldMod = installation.oldMod

                        onInstallStarted?.()

                        // Deliberately not awaited: the caller leaves on the click and the download
                        // runs on in the task list, which is what this flow has always done.
                        void installMod({
                          installationPath: installation.installation.path,
                          outName: installation.installation.name,
                          modName: downloadableModToInstall.name || modName || String(modToInstall ?? ""),
                          release: toModReleaseToInstall(release),
                          existing: oldMod && toInstalledModCopy(oldMod),
                          // Updating a Mod is not a request to turn it back on, so a disabled
                          // one is replaced by a disabled copy and stays out of the load order.
                          disabled: oldMod !== undefined && !oldMod.enabled
                        }).then((result) => {
                          if (result.ok && onFinishInstallation) onFinishInstallation()
                        })
                        return undefined
                      }}
                      variant="ghost"
                      className={clsx("w-7 h-7", compatibility.className)}
                      title={t(compatibility.titleKey)}
                    >
                      <div className={clsx("w-full h-full rounded-sm flex items-center justify-center", installation.oldMod?._updatableTo === release.modversion && "bg-lime-600/15")}>
                        {installation.oldMod ? <PiArrowClockwiseDuotone /> : <PiDownloadDuotone />}
                      </div>
                    </FormButton>
                  )}
                </TableCell>
              </TableBodyRow>
            )
          })}
        </TableBody>
      )}
    </TableWrapper>
  )
}

export default ModReleaseList
