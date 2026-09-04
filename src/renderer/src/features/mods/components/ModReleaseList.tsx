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

/**
 * How each verdict reads on a release row: a short word, a hue, and the long sentence behind the
 * tooltip and the button's accessible name.
 *
 * `className` goes on the icon and on the label, never on the FormButton. The ghost variant carries
 * `text-zinc-200` and Tailwind emits it after all three of these, so a colour handed to the button
 * through `className` sits at the same specificity and loses the cascade: every icon rendered grey
 * from #350 until #366. A child's own `text-*` has nothing to lose to.
 *
 * `labelKey` is the part that does not depend on hue. Whether a release fits your installation is a
 * call players make on every row of this table, and a colour plus a hover tooltip left anyone who
 * cannot separate lime from red with nothing to read.
 */
const COMPATIBILITY_STYLE: Record<ModCompatibilityVerdict, { className: string; titleKey: string; labelKey: string }> = {
  declared: { className: "text-lime-600", titleKey: "features.mods.worksOnTheVersion", labelKey: "features.mods.compatibilityTagged" },
  "same-minor": { className: "text-yellow-400", titleKey: "features.mods.shouldWorkOnTheVersion", labelKey: "features.mods.compatibilityLikely" },
  // Red-700 was the long-standing undeclared colour, but it only ever shipped as a class nothing
  // painted. Rendered for real it reads 2.18:1 on the table row, under even the non-text floor, so
  // this moves up the ramp to a red that clears the text floor. See tests/text-contrast.test.ts.
  undeclared: { className: "text-red-400", titleKey: "features.mods.probablyDontWorkOnTheVersion", labelKey: "features.mods.compatibilityUntagged" }
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

      {/*
       * The browse page hands `installation` from the last used one, which a fresh profile has not
       * picked yet. Nothing is installable then and every Actions cell is empty, so say why once
       * rather than leaving a blank column the player has to guess at.
       */}
      {!installation && <p className="px-2 py-1 text-xs text-center text-zinc-400">{t("features.installations.noInstallationSelected")}</p>}

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
                {/*
                 * Plain wrapping text, not the read-only input this used to be: a release can carry
                 * eight game versions and the input clipped the list mid-item with no tooltip and no
                 * way to read the rest, which is the one thing this column exists for. Nobody edits
                 * it either, so as an input it was also a focus stop announcing itself as a textbox.
                 */}
                <TableCell className="w-5/12 text-center break-words">{release.tags.join(", ")}</TableCell>
                <TableCell className="w-2/12 flex flex-col gap-1 items-center justify-center">
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
                      className="w-7 h-7 text-lg"
                      title={t(compatibility.titleKey)}
                    >
                      <div
                        className={clsx(
                          "w-full h-full rounded-sm flex items-center justify-center",
                          compatibility.className,
                          installation.oldMod?._updatableTo === release.modversion && "bg-lime-600/15"
                        )}
                      >
                        {installation.oldMod ? <PiArrowClockwiseDuotone /> : <PiDownloadDuotone />}
                      </div>
                    </FormButton>
                  )}
                  {compatibility && <span className={clsx("text-xs leading-none", compatibility.className)}>{t(compatibility.labelKey)}</span>}
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
