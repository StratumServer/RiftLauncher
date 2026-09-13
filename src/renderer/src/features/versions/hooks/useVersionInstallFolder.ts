import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createPathBuilderPort } from "@renderer/adapters/paths"

export interface UseVersionInstallFolderResult {
  /** The folder the version installs into, either suggested or user picked. */
  folder: string
  /** Opens the OS folder picker and, once one is picked, warns when it is not empty. */
  browseFolder: () => Promise<void>
}

/**
 * Owns AddVersion's target folder: a suggestion built from the settings'
 * default versions folder and the selected catalog version, kept in sync
 * until the user picks their own folder through the browse button.
 *
 * Only `browseFolder` flips the suggestion off for good. The input used to be
 * editable too, and a typed folder outside the managed roots was refused by
 * assertManagedPath with a message about the download failing rather than
 * about the folder (#411). The picker is what grants the path, so it is the
 * only way to change this field now.
 */
export function useVersionInstallFolder(version: DownloadableGameVersionTypeType | undefined, defaultVersionsFolder: string): UseVersionInstallFolderResult {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const [folder, setFolder] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)

  useEffect(() => {
    ;(async (): Promise<void> => {
      if (version && !folderByUser) setFolder(await createPathBuilderPort().join([defaultVersionsFolder, version.version]))
    })()
    // Matches the original effect: only re-suggests when the selected version changes.
  }, [version])

  async function browseFolder(): Promise<void> {
    const path = await window.api.utils.selectFolderDialog()
    const selectedPath = path[0]
    if (!selectedPath || selectedPath.length === 0) return

    if (!(await window.api.pathsManager.checkPathEmpty(selectedPath))) addNotification(t("notifications.body.folderNotEmpty"), "warning")

    setFolder(selectedPath)
    setFolderByUser(true)
  }

  return { folder, browseFolder }
}
