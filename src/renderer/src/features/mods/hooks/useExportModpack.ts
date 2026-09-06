import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { exportModpackArchive } from "@renderer/features/moddb/adapters/modsManager"
import { toModpackManifest } from "@renderer/features/mods/adapters/importModpack"

export function useExportModpack(): ({ installedMods, installation }: { installedMods: InstalledModType[]; installation: InstallationType }) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  async function exportModpack({ installedMods, installation }: { installedMods: InstalledModType[]; installation: InstallationType }): Promise<void> {
    const result = await exportModpackArchive(toModpackManifest(installation, installedMods))

    if (result.success) {
      addNotification(t("features.mods.exportModpackSuccess"), "success")
    } else {
      addNotification(t("features.mods.exportModpackError"), "error")
    }
  }

  return exportModpack
}
