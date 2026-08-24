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
      setManifest(result.manifest)
    } else if (result.error) {
      addNotification(t("features.mods.importModpackInvalidFile"), "error")
    }
  }

  return { manifest, pickModpack, clearModpack: () => setManifest(null) }
}
