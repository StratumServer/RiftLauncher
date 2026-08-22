import { useEffect, useState } from "react"

import { cleanFolderName } from "@domain/naming"
import { usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"

/**
 * The suggested data folder for an Installation: the configured base folder
 * joined with the Installation's name, cleaned into a single folder segment.
 *
 * A name with nothing usable left after cleaning ("***", "..", whitespace)
 * contributes no segment and the base folder comes back as-is. Handing
 * formatPath the empty string would only get it thrown back: the path layer
 * refuses empty and dot-only parts.
 */
async function suggestInstallationFolder(baseFolder: string, name: string): Promise<string> {
  const segment = cleanFolderName(name)
  return segment ? window.api.pathsManager.formatPath([baseFolder, segment]) : baseFolder
}

export interface UseInstallationFolderResult {
  /** The folder the Installation's data lives in, either suggested or the user's own. */
  folder: string
  /** Free text edit of the folder, e.g. typing directly in the input. Takes the field over. */
  setFolder: (folder: string) => void
  /** Opens the OS folder picker and, once one is picked, takes the field over with it. */
  browseFolder: () => Promise<void>
}

/**
 * Owns AddInstallation's data folder: a suggestion built from the settings'
 * default installations folder and the Installation's name, cleaned into
 * something the path layer accepts, kept in sync with both until the user
 * takes the field over.
 *
 * Same shape as useVersionInstallFolder, with one deliberate difference.
 * There, typing in the folder input does not count as a pick, because the
 * other half of the suggestion is a version chosen from a list and settles
 * early. Here it is a name the user keeps editing, so a folder they typed
 * themselves would be thrown away on the next keystroke in the name field.
 * Typing counts here, and so does the browse button.
 *
 * The base folder is part of the suggestion too: it arrives empty on the first
 * render and only fills in once the config has loaded, so a suggestion built
 * before that has to be rebuilt after.
 */
export function useInstallationFolder(name: string, defaultInstallationsFolder: string): UseInstallationFolderResult {
  const pickEmptyFolder = usePickEmptyFolder()

  const [folder, setSuggestedFolder] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)

  useEffect(() => {
    if (folderByUser || !defaultInstallationsFolder) return

    // Building the suggestion crosses the IPC bridge, so someone typing quickly
    // has several in flight at once. Only the last one asked for may land, or a
    // slow early keystroke overwrites the folder the latest name deserves.
    let latest = true
    ;(async (): Promise<void> => {
      const suggestion = await suggestInstallationFolder(defaultInstallationsFolder, name)
      if (latest) setSuggestedFolder(suggestion)
    })()

    return (): void => {
      latest = false
    }
  }, [name, defaultInstallationsFolder, folderByUser])

  function takeFolderOver(pickedFolder: string): void {
    setSuggestedFolder(pickedFolder)
    setFolderByUser(true)
  }

  async function browseFolder(): Promise<void> {
    const selectedPath = await pickEmptyFolder()
    if (selectedPath) takeFolderOver(selectedPath)
  }

  return { folder, setFolder: takeFolderOver, browseFolder }
}
