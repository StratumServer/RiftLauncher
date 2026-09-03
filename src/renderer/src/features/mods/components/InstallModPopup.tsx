import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"

import { useModReleaseCatalog } from "../hooks/useModReleaseCatalog"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import ModReleaseList, { type IInstallationToInstallModIn } from "@renderer/features/mods/components/ModReleaseList"

/**
 * The update flow inside an installation: the player is already on the installation's mod list and
 * is picking a newer release of a mod they have, so this stays a popup and returns them to the list
 * they came from. Browsing the ModDB for a mod to install is a journey of its own and is a page.
 *
 * @param {Object} props
 * @param {number | string | null} [props.modToInstall] useState with the ModID of the mod to install. String from modinfo.json like mycoolmod, number or null if the popup is closed.
 * @param {() => void} [props.setModToInstall] Function called to close the popup. Set modToInstall to null when it's called.
 * @param {string} [props.modName] Name of the mod as the clicked row already knows it, shown until (or instead of) the ModDB answers.
 * @param {IInstallationToInstallModIn} [props.installation] Installation data to install a mod on it.
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
  const { mod, loading, failed, retry } = useModReleaseCatalog(modToInstall)

  // The ModDB name is the nicest one, but it only exists once the query lands. The row the user
  // clicked already carries a name, and failing that there is always the ModID they clicked, so
  // there is never a reason to tell them the mod was not found when they just picked it off a list.
  const displayedModName = mod?.name || modName || String(modToInstall ?? "")

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
        <ModReleaseList
          mod={mod}
          loading={loading}
          failed={failed}
          retry={retry}
          modToInstall={modToInstall}
          modName={modName}
          installation={installation}
          onInstallStarted={() => setModToInstall(null)}
          onFinishInstallation={onFinishInstallation}
        />
      </>
    </PopupDialogPanel>
  )
}

export default InstallModPopup
