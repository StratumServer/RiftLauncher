import type { PathBuilder } from "../ports"

/**
 * The subfolder of an installation that Vintage Story loads mods from.
 *
 * The game hardcodes this name, so it is a fact about the game rather than a launcher preference.
 * It used to be spelled out at each of the four places that needed it, which is how a scan could end
 * up looking somewhere an install had never written to.
 */
export const MODS_FOLDER_NAME = "Mods"

/**
 * The Mods folder of one installation, joined with the host's separator.
 *
 * @param paths Host path joining.
 * @param installationPath The installation folder itself, never its Mods subfolder.
 */
export function modsFolder(paths: PathBuilder, installationPath: string): Promise<string> {
  return paths.join([installationPath, MODS_FOLDER_NAME])
}
