import { useTranslation } from "react-i18next"

import { checkConfiguredFolder, type ConfiguredFolderKind, type ConfiguredFolderRefusal } from "@domain/config/folders"
import { toFolderPlatform } from "@domain/paths"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigDispatch, useInstallations } from "@renderer/features/config/contexts/ConfigContext"
import { usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"

type FolderSettingActionType = CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER | CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER

const FOLDER_KINDS: Record<FolderSettingActionType, ConfiguredFolderKind> = {
  [CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER]: "installations",
  [CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER]: "versions",
  [CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER]: "backups"
}

const REFUSAL_MESSAGES: Record<ConfiguredFolderRefusal, string> = {
  "inside-installation": "features.config.folderInsideInstallation",
  "holds-installation": "features.config.folderHoldsInstallation"
}

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
 *
 * A folder inside an Installation, or a Backups folder holding one, is refused instead: restoring
 * or deleting that Installation would erase the folder along with it. Nothing already in the
 * config is touched, so a setup that predates this check keeps working until the folder is changed.
 */
export function useConfigFolderPicker(actionType: FolderSettingActionType): () => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()
  const installations = useInstallations()
  const pickEmptyFolder = usePickEmptyFolder()

  return async function pickFolder(): Promise<void> {
    const selectedPath = await pickEmptyFolder()
    if (!selectedPath) return

    const platform = toFolderPlatform(await window.api.utils.getOs())
    const refusal = checkConfiguredFolder(
      FOLDER_KINDS[actionType],
      selectedPath,
      installations.map((installation) => installation.path),
      platform
    )
    if (refusal) return addNotification(t(REFUSAL_MESSAGES[refusal]), "error")

    configDispatch({ type: actionType, payload: selectedPath })
  }
}
