import type { PathBuilder } from "../ports"
import { scanInstalledMods } from "./scanInstalled"
import type { ScanInstalledModsPorts, ScannedMod } from "./scanInstalled"

/**
 * The subfolder of an installation Vintage Story downloads a server's mods into.
 *
 * The game hardcodes this name the way it hardcodes `Mods`, and it writes one subfolder per server
 * under it, named after the server. That folder name is the only record of where a mod came from:
 * nothing inside the archive says it was pushed by a server, so provenance here is the folder and
 * nothing else.
 */
export const MODS_BY_SERVER_FOLDER_NAME = "ModsByServer"

/** Most server folders one scan will open. Past this, nobody is reading the list anyway. */
export const MAX_SERVER_MOD_FOLDERS = 24

/**
 * Most archives one scan will read across every server folder together.
 *
 * `scanInstalledMods` already bounds one folder. This bounds the sum, so a player who joined twenty
 * modded servers does not pay for twenty full folder scans to see a list they arrive at collapsed.
 */
export const MAX_SERVER_MOD_ARCHIVES = 1_000

/** One server's downloaded mods, as the folder named after that server holds them. */
export interface ServerModGroup {
  /** The folder's name, which is the server's name or address. Untrusted text, for display only. */
  server: string
  /** Full path of the folder, built by the host from a name the host itself listed. */
  path: string
  mods: ScannedMod[]
  /**
   * How many archives in this folder did not read. Counted, never listed: nothing here acts on one
   * archive, so naming them would only be noise the player cannot use.
   */
  unreadable: number
}

/**
 * The ModsByServer folder of one installation, joined with the host's separator.
 *
 * @param paths Host path joining.
 * @param installationPath The installation folder itself.
 */
export function modsByServerFolder(paths: PathBuilder, installationPath: string): Promise<string> {
  return paths.join([installationPath, MODS_BY_SERVER_FOLDER_NAME])
}

/**
 * Reads every server folder under `ModsByServer` and says what each one holds.
 *
 * Reading a mod is `scanInstalledMods` again, once per folder, so nothing about opening an archive
 * is written twice here. An empty folder still comes back as a group: an empty folder is a folder
 * the player can still clear.
 *
 * No name checking of its own. The directory reader port has already dropped entries the launcher
 * will not touch, symlinks and unsafe names among them, and its contract says what comes back is
 * what may be opened. Nothing outside that port ever builds a path from a server folder name: if a
 * caller ever sends a name instead of the path this returns, the check has to come back.
 *
 * @returns The groups in name order, and whether there is more on disk than came back.
 */
export async function scanServerMods(ports: ScanInstalledModsPorts, input: { folder: string }): Promise<{ groups: ServerModGroup[]; truncated: boolean }> {
  const names = (await ports.directories.listFileNames(input.folder)).sort((a, b) => a.localeCompare(b))
  const kept = names.slice(0, MAX_SERVER_MOD_FOLDERS)

  const groups: ServerModGroup[] = []
  let truncated = names.length > kept.length
  let archives = 0

  for (let index = 0; index < kept.length; index++) {
    const server = kept[index]
    const path = await ports.paths.join([input.folder, server])

    let scan
    try {
      scan = await scanInstalledMods(ports, { folder: path })
    } catch {
      // A plain file sitting beside the server folders, or a folder that will not list at all.
      // Neither is a server's mod set, and a group for it would offer the player a folder to clear
      // that is not there.
      continue
    }

    groups.push({ server, path, mods: scan.mods, unreadable: scan.errors.length })

    // Counted after the folder rather than before it: a folder is scanned whole or not at all, so a
    // group never comes back holding half of what its folder has.
    archives += scan.mods.length + scan.errors.length
    if (archives >= MAX_SERVER_MOD_ARCHIVES) {
      truncated = truncated || index < kept.length - 1
      break
    }
  }

  return { groups, truncated }
}
