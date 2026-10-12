import { firstHeldFolder, type FolderPlatform } from "@domain/paths"

/** The config slices that name a folder next to an Installation. */
export interface ManagedFolders {
  settings: { backupsFolder: string; defaultInstallationsFolder: string; defaultVersionsFolder: string }
  installations: readonly { id: string; path: string }[]
  gameVersions: readonly { path: string }[]
}

/**
 * The managed folder an Installation's own folder holds, if any: another Installation (or one
 * sharing its folder), a VS Version, or one of the three folders from Config. Restoring or deleting
 * the Installation wipes its folder, and the host refuses to when this is not null, so the caller
 * says which folder to move before any archive is extracted.
 */
export function findHeldManagedFolder(installation: { id: string; path: string }, { settings, installations, gameVersions }: ManagedFolders, platform: FolderPlatform): string | null {
  const others = installations.filter((other) => other.id !== installation.id).map((other) => other.path)
  const managed = [settings.backupsFolder, settings.defaultInstallationsFolder, settings.defaultVersionsFolder, ...others, ...gameVersions.map((gameVersion) => gameVersion.path)]
  return firstHeldFolder(installation.path, managed, platform)
}
