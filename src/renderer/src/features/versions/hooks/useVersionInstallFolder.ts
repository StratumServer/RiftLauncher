import { useEffect, useState } from "react"

import { createPathBuilderPort } from "@renderer/adapters/paths"
import { usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"

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
  const pickEmptyFolder = usePickEmptyFolder()

  const [folder, setFolder] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)

  useEffect(() => {
    ;(async (): Promise<void> => {
      if (version && !folderByUser) setFolder(await createPathBuilderPort().join([defaultVersionsFolder, version.version]))
    })()
    // Matches the original effect: only re-suggests when the selected version changes.
  }, [version])

  async function browseFolder(): Promise<void> {
    const selectedPath = await pickEmptyFolder()
    if (!selectedPath) return

    setFolder(selectedPath)
    setFolderByUser(true)
  }

  return { folder, browseFolder }
}
