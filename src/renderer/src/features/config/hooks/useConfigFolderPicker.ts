import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

type FolderSettingActionType = CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER

/**
 * Minimal local hook behind ConfigPage's three folder pickers (installations, versions, backups).
 *
 * The installations feature carries the same browse-and-warn-if-not-empty pattern. Sharing one
 * implementation between the two is a natural follow-up, kept separate here so this hook does not
 * depend on that file's shape.
 *
 * Lives outside features/config/pages on purpose: neither ConfigPage.tsx nor anything else under
 * that directory may mention the preload bridge directly.
 */
export function useConfigFolderPicker(actionType: FolderSettingActionType): () => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()

  return async function pickFolder(): Promise<void> {
    const path = await window.api.utils.selectFolderDialog()
    const selectedPath = path[0]
    if (!selectedPath || selectedPath.length < 1) return

    if (!(await window.api.pathsManager.checkPathEmpty(selectedPath))) addNotification(t("notifications.body.folderNotEmpty"), "warning")
    configDispatch({ type: actionType, payload: selectedPath })
  }
}
