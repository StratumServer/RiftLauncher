import { useTranslation } from "react-i18next"
import { PiArrowClockwiseDuotone, PiFolderOpenDuotone, PiBoxArrowUpDuotone, PiBoxArrowDownDuotone, PiDesktopTowerDuotone } from "react-icons/pi"

import { useExportModpack } from "@renderer/features/mods/hooks/useExportModpack"
import { resolveModsFolder } from "@renderer/features/mods/adapters/folder"
import { useOpenPathInExplorer } from "@renderer/features/installations/hooks/usePathActions"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroupWrapper, StickyMenuGroup } from "@renderer/components/ui/StickyMenu"

/** A Mod the game loads on a server: everything that does not declare itself client-only. */
function isServerMod(side: string | undefined): boolean {
  if (!side) return true
  return !side.toLowerCase().startsWith("client")
}

/** Everything the Mods page does to the whole folder at once: update, export, import, open it. */
function ManageModsActionBar({
  installation,
  installedMods,
  onUpdateAll,
  onImportModpack
}: Readonly<{
  installation: InstallationType
  installedMods: InstalledModType[]
  onUpdateAll: () => void
  onImportModpack: () => void
}>): JSX.Element {
  const { t } = useTranslation()

  const exportModpack = useExportModpack()
  const openPathInExplorer = useOpenPathInExplorer()

  // A modpack is the set someone else is meant to be able to play, so a Mod the player turned off
  // is not in it. Both exports read this list, and both are greyed out by it: a folder whose Mods
  // are all disabled has nothing to export, and saying so beats writing an empty manifest.
  const enabledMods = installedMods.filter((iMod) => iMod.enabled)

  // The server export ships this list and is greyed out by this list. Deriving it twice is how a
  // search that leaves only client Mods once produced a live button and a `{ mods: [] }` manifest.
  const serverMods = enabledMods.filter((iMod) => isServerMod(iMod.side))

  return (
    <StickyMenuGroupWrapper type="centered">
      <StickyMenuGroup>
        <FormButton title={t("features.mods.updateAll")} className="p-1 w-fit h-8" onClick={onUpdateAll}>
          <PiArrowClockwiseDuotone className="text-xl" />
          <p>{t("features.mods.updateAllButton")}</p>
        </FormButton>

        <FormButton title={t("features.mods.exportModpack")} className="p-1 w-fit h-8" onClick={() => exportModpack({ installedMods: enabledMods, installation })} disabled={enabledMods.length === 0}>
          <PiBoxArrowUpDuotone className="text-xl" />
          <p>{t("features.mods.exportModpackButton")}</p>
        </FormButton>

        <FormButton
          title={t("features.mods.exportServerModpack")}
          className="p-1 w-fit h-8"
          onClick={() => exportModpack({ installedMods: serverMods, installation: { ...installation, name: `${installation.name} (Server)` } })}
          disabled={serverMods.length === 0}
        >
          <PiDesktopTowerDuotone className="text-xl" />
          <p>{t("features.mods.exportServerModpackButton")}</p>
        </FormButton>

        <FormButton title={t("features.mods.importModpack")} className="p-1 w-fit h-8" onClick={onImportModpack}>
          <PiBoxArrowDownDuotone className="text-xl" />
          <p>{t("features.mods.importModpackButton")}</p>
        </FormButton>

        <FormButton
          title={t("features.mods.openModsFolder")}
          className="w-8 h-8"
          onClick={async () => {
            const path = await resolveModsFolder(installation.path)
            openPathInExplorer(path, { ensure: true })
          }}
        >
          <PiFolderOpenDuotone className="text-xl" />
        </FormButton>
      </StickyMenuGroup>
    </StickyMenuGroupWrapper>
  )
}

export default ManageModsActionBar
