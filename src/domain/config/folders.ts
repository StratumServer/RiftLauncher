import { folderIsInUse, folderIsInside, type FolderPlatform } from "../paths"

/** The three folders the Config page lets the player point somewhere else. */
export type ConfiguredFolderKind = "installations" | "versions" | "backups"

/** Why a folder cannot be one of the configured ones. */
export type ConfiguredFolderRefusal = "inside-installation" | "holds-installation"

/**
 * Whether a folder picked in Config can be used without putting a managed folder at risk.
 *
 * Restoring or deleting an Installation wipes its whole folder, so a configured folder inside one
 * goes with it: the Installations folder would lose its siblings, the Backups folder every archive
 * (the one a restore reads included). The Backups folder may not hold an Installation either, the
 * same overlap seen from the other side. The Installations folder holding Installations is the
 * normal layout and the Versions folder holding one is harmless, so only "inside" is checked there.
 *
 * @param kind Which configured folder is being set.
 * @param folder The folder the player picked.
 * @param installationFolders The data folder of every Installation in the config.
 * @param platform Host platform for path normalization.
 * @returns The reason the folder is refused, or null when it is fine.
 */
export function checkConfiguredFolder(kind: ConfiguredFolderKind, folder: string, installationFolders: readonly string[], platform?: FolderPlatform): ConfiguredFolderRefusal | null {
  if (installationFolders.some((installation) => folderIsInUse(folder, [installation], platform) || folderIsInside(folder, installation, platform))) return "inside-installation"
  if (kind === "backups" && installationFolders.some((installation) => folderIsInside(installation, folder, platform))) return "holds-installation"
  return null
}
