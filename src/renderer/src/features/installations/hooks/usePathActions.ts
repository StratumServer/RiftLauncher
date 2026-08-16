import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useCleanFolderName } from "@renderer/hooks/useCleanFolderName"

/**
 * The auto-suggested install folder for a new Installation: the configured
 * base folder joined with the cleaned-up Installation name.
 */
export function useDefaultInstallationPath(): (baseFolder: string, name: string) => Promise<string> {
  const cleanFolderName = useCleanFolderName()

  async function defaultInstallationPath(baseFolder: string, name: string): Promise<string> {
    return window.api.pathsManager.formatPath([baseFolder, await cleanFolderName({ folderName: name })])
  }

  return defaultInstallationPath
}

/**
 * Opens the native folder picker and warns (without blocking the pick) when the
 * chosen folder isn't empty. Resolves null when the user cancels the dialog.
 */
export function usePickEmptyFolder(): () => Promise<string | null> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  async function pickEmptyFolder(): Promise<string | null> {
    const paths = await window.api.utils.selectFolderDialog()
    const selectedPath = paths[0]
    if (!selectedPath || selectedPath.length === 0) return null

    if (!(await window.api.pathsManager.checkPathEmpty(selectedPath))) addNotification(t("notifications.body.folderNotEmpty"), "warning")

    return selectedPath
  }

  return pickEmptyFolder
}

/** Whether `path` exists on disk, straight off the preload bridge. */
export function useCheckPathExists(): (path: string) => Promise<boolean> {
  return (path) => window.api.pathsManager.checkPathExists(path)
}

/** Makes sure `path` exists on disk, creating it when it's missing. Fire-and-forget by design: callers that need the outcome read the resolved boolean. */
export function useEnsurePathExists(): (path: string) => Promise<boolean> {
  return (path) => window.api.pathsManager.ensurePathExists(path)
}

export interface OpenPathInExplorerOptions {
  /** Resolve `path`'s containing folder first (removeFileFromPath) before checking/opening it. Use for a file path, e.g. a backup archive. */
  parentOfFile?: boolean
  /** Create the folder instead of refusing when it isn't there yet. */
  ensure?: boolean
}

/**
 * Opens `path` (or the folder holding it) on the OS file explorer, after making
 * sure it's there. Notifies "notifications.body.folderDoesntExists" and does
 * nothing else when it isn't.
 */
export function useOpenPathInExplorer(): (path: string, options?: OpenPathInExplorerOptions) => Promise<boolean> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  async function openPathInExplorer(path: string, options: OpenPathInExplorerOptions = {}): Promise<boolean> {
    const folder = options.parentOfFile ? await window.api.pathsManager.removeFileFromPath(path) : path

    const exists = options.ensure ? await window.api.pathsManager.ensurePathExists(folder) : await window.api.pathsManager.checkPathExists(folder)

    if (!exists) {
      addNotification(t("notifications.body.folderDoesntExists"), "error")
      return false
    }

    window.api.pathsManager.openPathOnFileExplorer(folder)
    return true
  }

  return openPathInExplorer
}
