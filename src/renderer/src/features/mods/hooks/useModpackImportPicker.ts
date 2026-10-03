import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { importModpackArchive } from "@renderer/features/moddb/adapters/modsManager"

export interface ModpackImportPicker {
  /** The manifest the user picked, or null while no import is being reviewed. */
  manifest: ModpackManifestType | null
  /** Opens the file picker and takes the manifest, or says the file was no good. */
  pickModpack: () => Promise<void>
  clearModpack: () => void
}

/**
 * Picking a modpack file to import.
 *
 * Only the choosing lives here. Everything the import itself does (planning, downloading, its own
 * summary) belongs to ImportModpackPopup, which the manifest opens.
 */
export function useModpackImportPicker(): ModpackImportPicker {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const [manifest, setManifest] = useState<ModpackManifestType | null>(null)

  async function pickModpack(): Promise<void> {
    const result = await importModpackArchive()
    if (result.success && result.manifest) {
      // The host reports a settings block it had to drop, and the manifest it hands back is
      // already the manifest without it. Nobody is going to notice that on their own, so it is
      // said here, while the file being read is still the thing the player is looking at.
      if (result.settingsRefused) addNotification(t("features.mods.importModConfigsSettingsRefused"), "warning")
      setManifest(result.manifest)
    } else if (result.error) {
      addNotification(t("features.mods.importModpackInvalidFile"), "error")
    }
  }

  return { manifest, pickModpack, clearModpack: () => setManifest(null) }
}
