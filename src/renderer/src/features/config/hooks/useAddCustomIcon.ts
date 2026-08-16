import { useTranslation } from "react-i18next"
import { v4 as uuidv4 } from "uuid"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

/**
 * Picks a PNG from disk and copies it into the icons folder, ready to hand to
 * `CONFIG_ACTIONS.ADD_CUSTOM_ICON`.
 *
 * Kept in features/config/hooks rather than under components/ui, where AddCustomIconPupup.tsx
 * lives: stage 4's exit gate fails if anything under src/renderer/src/components mentions the
 * preload bridge directly.
 */
export function useAddCustomIcon(): () => Promise<{ id: string; file: string } | undefined> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  return async function pickAndCopyIcon(): Promise<{ id: string; file: string } | undefined> {
    const path = await window.api.utils.selectFolderDialog({ type: "file", extensions: ["png"] })
    const selectedPath = path[0]

    if (!selectedPath || selectedPath.length < 1) {
      addNotification(t("notifications.body.noFileSelected"), "error")
      return undefined
    }

    const id = uuidv4()
    const filePath = await window.api.pathsManager.copyToIcons(selectedPath, id)

    if (!filePath.status) {
      addNotification(t("notifications.body.coulndtCopyIcon"), "error")
      return undefined
    }

    return { id, file: filePath.file }
  }
}
