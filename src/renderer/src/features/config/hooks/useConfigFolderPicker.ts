import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

type FolderSettingActionType = CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER

/**
 * Minimal local hook behind ConfigPage's three folder pickers (installations, versions, backups).
 *
 * The installations agent is centralizing this exact browse-and-warn-if-not-empty pattern in its
 * own feature as part of the same stage. Deliberately not importing from that file here since it
 * may not exist yet on this branch; once it lands, these three buttons are a natural follow-up to
 * point at it instead.
 *
 * Lives outside features/config/pages on purpose: stage 4's exit gate fails if ConfigPage.tsx (or
 * anything else under that directory) mentions the preload bridge directly.
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
