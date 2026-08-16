import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"

/** Opens a game version's folder in the OS file explorer, warning first when the folder is gone. */
export function useOpenVersionFolder(): (path: string) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  return async function openVersionFolder(path) {
    if (!(await createFileSystemPort().exists(path))) return addNotification(t("notifications.body.folderDoesntExists"), "error")
    window.api.pathsManager.openPathOnFileExplorer(path)
  }
}
