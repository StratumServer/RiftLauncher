import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { exportModpackArchive } from "@renderer/features/moddb/adapters/modsManager"
import { toModpackManifest } from "@renderer/features/mods/adapters/importModpack"

export function useExportModpack(): ({
  installedMods,
  installation,
  includeServers,
  includeConfigs
}: {
  installedMods: InstalledModType[]
  installation: InstallationType
  includeServers?: boolean
  includeConfigs?: boolean
}) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  async function exportModpack({
    installedMods,
    installation,
    includeServers = false,
    includeConfigs = false
  }: {
    installedMods: InstalledModType[]
    installation: InstallationType
    includeServers?: boolean
    includeConfigs?: boolean
  }): Promise<void> {
    const result = await exportModpackArchive(toModpackManifest(installation, installedMods, includeServers), installation.path, includeConfigs)

    if (result.success) {
      addNotification(t("features.mods.exportModpackSuccess"), "success")
      return
    }
    // A refusal that names what went wrong beats the one message every other failure gets: the
    // player can act on "this file is not UTF-8" and cannot act on "something failed". One branch
    // per reason rather than a lookup, because a computed key is one the locale parity test cannot
    // see, which is exactly how a missing translation gets shipped.
    if (result.reason === "not-utf8") {
      addNotification(t("features.mods.exportModpackConfigNotUtf8", { name: result.name ?? "" }), "error")
      return
    }
    if (result.reason === "too-large") {
      addNotification(t("features.mods.exportModpackConfigTooLarge"), "error")
      return
    }
    if (result.reason === "too-many") {
      addNotification(t("features.mods.exportModpackConfigTooMany"), "error")
      return
    }
    if (result.reason) {
      addNotification(t("features.mods.exportModpackConfigUnreadable"), "error")
      return
    }
    addNotification(t("features.mods.exportModpackError"), "error")
  }

  return exportModpack
}
