import { useEffect, useState } from "react"

import { firstFreeFolder } from "@domain/paths"
import { createPathBuilderPort } from "@renderer/adapters/paths"
import { usePickEmptyFolder } from "@renderer/features/installations/hooks/usePathActions"

export interface UseVersionInstallFolderResult {
  /** The folder the version installs into, either suggested or user picked. */
  folder: string
  /** Opens the OS folder picker and, once one is picked, warns when it is not empty. */
  browseFolder: () => Promise<void>
}

/** Which build the folder is being suggested for. An Optimum build gets a folder of its own. */
export type InstallBuild = "official" | "optimum"

/**
 * Owns AddVersion's target folder: a suggestion built from the settings'
 * default versions folder, the selected catalog version and the build, kept
 * in sync until the user picks their own folder through the browse button.
 *
 * The suggestion never lands on a folder the launcher already uses. A player
 * who holds 1.22.7 and asks for its Optimum build is offered `1.22.7-optimum`,
 * and a second official copy `1.22.7-2`, where the plain `1.22.7` used to be
 * offered again and refused as already installed.
 *
 * Only `browseFolder` flips the suggestion off for good. The input used to be
 * editable too, and a typed folder outside the managed roots was refused by
 * assertManagedPath with a message about the download failing rather than
 * about the folder (#411). The picker is what grants the path, so it is the
 * only way to change this field now.
 */
export function useVersionInstallFolder(
  version: DownloadableGameVersionTypeType | undefined,
  defaultVersionsFolder: string,
  build: InstallBuild,
  foldersInUse: readonly string[]
): UseVersionInstallFolderResult {
  const pickEmptyFolder = usePickEmptyFolder()

  const [folder, setFolder] = useState<string>("")
  const [folderByUser, setFolderByUser] = useState<boolean>(false)

  // The list as one string, so the effect follows its content rather than the array's identity.
  const inUse = foldersInUse.join("\n")

  useEffect(() => {
    let stale = false
    ;(async (): Promise<void> => {
      if (!version || folderByUser) return
      const name = build === "optimum" ? `${version.version}-optimum` : version.version
      const base = await createPathBuilderPort().join([defaultVersionsFolder, name])
      if (!stale) setFolder(firstFreeFolder(base, inUse.split("\n")))
    })()
    return (): void => {
      stale = true
    }
  }, [version, build, inUse, folderByUser, defaultVersionsFolder])

  async function browseFolder(): Promise<void> {
    const selectedPath = await pickEmptyFolder()
    if (!selectedPath) return

    setFolder(selectedPath)
    setFolderByUser(true)
  }

  return { folder, browseFolder }
}
