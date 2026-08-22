import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { describeAddCustomIconFailure, type AddCustomIconFailure } from "@renderer/features/config/adapters/customIcon"

const LOG_TAG = "[front] [config] [features/config/hooks/useAddCustomIcon.ts] [useAddCustomIcon > pickAndCopyIcon]"

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
    function refuse(reason: AddCustomIconFailure, cause?: unknown): undefined {
      const { messageKey, logged } = describeAddCustomIconFailure(reason)

      if (logged) {
        window.api.utils.logMessage("error", `${LOG_TAG} Couldn't add a custom icon.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} Custom icon refused: ${reason}${cause instanceof Error ? ` (${cause.message})` : ""}.`)
      }

      addNotification(t(messageKey), "error")
      return undefined
    }

    // Both bridge calls are awaited inside a try: a rejected invoke used to
    // travel back up through the popup's own async onClick, where nothing
    // caught it, so the flow ended with no notification and no log line at all.
    let selectedPath: string | undefined
    try {
      const path = await window.api.utils.selectFolderDialog({ type: "file", extensions: ["png"] })
      selectedPath = path[0]
    } catch (error) {
      return refuse("bridge-failed", error)
    }

    if (!selectedPath || selectedPath.length < 1) return refuse("no-file-selected")

    const id = crypto.randomUUID()

    try {
      const result = await window.api.pathsManager.copyToIcons(selectedPath, id)
      if (!result.status) return refuse(result.reason)
      return { id, file: result.file }
    } catch (error) {
      return refuse("bridge-failed", error)
    }
  }
}
