import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"

type FolderSettingActionType = CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER

/**
 * Minimal local hook behind ConfigPage's three folder pickers (installations, versions, backups):
 * usePickEmptyFolder's pick-and-warn, dispatched into config once a folder comes back.
 *
 * Lives outside features/config/pages on purpose: neither ConfigPage.tsx nor anything else under
 * that directory may mention the preload bridge directly. Reaching into features/installations
 * for usePickEmptyFolder is already normal here (useInstallationFolder and
 * useVersionInstallFolder both cross feature lines the same way for the same hook).
 *
 * usePickEmptyFolder warns without blocking the pick, so dispatching has to happen whether or
 * not it warned, never only on the clean path.
 */
export function useConfigFolderPicker(actionType: FolderSettingActionType): () => Promise<void> {
  const configDispatch = useConfigDispatch()
  const pickEmptyFolder = usePickEmptyFolder()

  return async function pickFolder(): Promise<void> {
    const selectedPath = await pickEmptyFolder()
    if (!selectedPath) return

    configDispatch({ type: actionType, payload: selectedPath })
  }
}
