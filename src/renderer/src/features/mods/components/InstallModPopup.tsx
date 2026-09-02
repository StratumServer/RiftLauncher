import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiDownloadDuotone, PiArrowClockwiseDuotone } from "react-icons/pi"
import { FiLoader } from "react-icons/fi"
import clsx from "clsx"

import { evaluateModCompatibility } from "@domain/mods/compatibility"
import type { ModCompatibilityVerdict } from "@domain/mods/compatibility"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { toInstalledModCopy, toModReleaseToInstall } from "@renderer/features/mods/adapters/install"

import { useInstallMod } from "../hooks/useInstallMod"
import { useModReleaseCatalog } from "../hooks/useModReleaseCatalog"

import { TableBody, TableBodyRow, TableCell, TableHead, TableHeadRow, TableWrapper } from "@renderer/components/ui/Table"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { ReloadButton } from "@renderer/components/ui/StickyMenu"

/** Button styling for what the author declared about a release. Undeclared keeps its long-standing red. */
const COMPATIBILITY_STYLE: Record<ModCompatibilityVerdict, { className: string; titleKey: string }> = {
  declared: { className: "text-lime-600", titleKey: "features.mods.worksOnTheVersion" },
  "same-minor": { className: "text-yellow-400", titleKey: "features.mods.shouldWorkOnTheVersion" },
  undeclared: { className: "text-red-700", titleKey: "features.mods.probablyDontWorkOnTheVersion" }
}

interface IInstallationToInstallModIn {
  installation: InstallationType
  oldMod?: InstalledModType
}

/**
 * Popup with a mod's installable versions with colors for compatible updates, automatic remove of the old installed version, etc.
 *
 * @param {Object} props
 * @param {number | string | null} [props.modToInstall] useState with the ModID of the mod to install. String from modinfo.json like mycoolmod, number or null if the popup is closed.
 * @param {() => void} [props.setModToInstall] Function called to close the popup. Set modToInstall to null when it's called.
 * @param {string} [props.modName] Name of the mod as the clicked row already knows it, shown until (or instead of) the ModDB answers.
 * @param {IInstallationToInstallModIn} [props.installation] Installation data to install a mod on it.
 * @param {string} [props.installation.pathToIsntall] Path to look for mods. /Mods will be added at the end.
 * @param {string} [props.installation.version] Installation/Server version to check if there are compatible updates WITHOUT "v"! Example: ~~v1.2.3~~ 1.2.3
 * @param {string} [props.installation.outName] Name of the Server or Installation where the mod will be installed.
 * @param {InstalledModType} [props.installation.oldMod] The old mod(if there's any) to check for updates and update if it's needed. It'll not get available updates, it'll only check it the _updateTo key is not undefined.
 * @param {() => void} [props.onFinishInstallation] Function called after the mod was installed.
 * @return {JSX.Element} The popup with mod versions.
 */
function InstallModPopup({
  modToInstall,
  setModToInstall,
  modName,
  installation,
  onFinishInstallation
}: Readonly<{
  modToInstall: number | string | null
  setModToInstall: Dispatch<SetStateAction<number | string | null>>
  modName?: string
  installation?: IInstallationToInstallModIn
  onFinishInstallation?: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const installMod = useInstallMod()
  const { mod: downloadableModToInstall, loading, failed, retry } = useModReleaseCatalog(modToInstall)

  // The ModDB name is the nicest one, but it only exists once the query lands. The row the user
  // clicked already carries a name, and failing that there is always the ModID they clicked, so
  // there is never a reason to tell them the mod was not found when they just picked it off a list.
  const displayedModName = downloadableModToInstall?.name || modName || String(modToInstall ?? "")

  return (
    <PopupDialogPanel
      title={t("features.mods.installMod")}
      isOpen={modToInstall !== null}
      close={() => {
        setModToInstall(null)
      }}
      fixedWidth={false}
    >
      <>
        <p>{t("features.mods.installationPopupDesc", { modName: displayedModName })}</p>
        <TableWrapper className="w-[50rem]">
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
                          onClick={async () => {
                            if (installation.installation._backuping || installation.installation._restoringBackup) return addNotification(t("features.mods.cantUpdateWhileinUse"), "error")

                            const oldMod = installation.oldMod

                            setModToInstall(null)

                            // Deliberately not awaited: the popup closes on the click and the download
                            // runs on in the task list, which is what this flow has always done.
                            void installMod({
                              installationPath: installation.installation.path,
                              outName: installation.installation.name,
                              modName: downloadableModToInstall.name,
                              release: toModReleaseToInstall(release),
                              existing: oldMod && toInstalledModCopy(oldMod),
                              // Updating a Mod is not a request to turn it back on, so a disabled
                              // one is replaced by a disabled copy and stays out of the load order.
                              disabled: oldMod !== undefined && !oldMod.enabled
                            }).then((result) => {
                              if (result.ok && onFinishInstallation) onFinishInstallation()
                            })
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
      </>
    </PopupDialogPanel>
  )
}

export default InstallModPopup
