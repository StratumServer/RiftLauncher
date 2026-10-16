import { firstHeldFolder, folderIsInUse, folderIsInside, type FolderPlatform } from "@domain/paths"

/** The config slices that name a folder or an archive next to an Installation. */
export interface ManagedFolders {
  settings: { backupsFolder: string; defaultInstallationsFolder: string; defaultVersionsFolder: string }
  installations: readonly { id: string; name: string; path: string; backups?: readonly { path: string }[]; worldBackups?: readonly { path: string; worldName: string }[] }[]
  gameVersions: readonly { path: string; label?: string; linked?: boolean }[]
}

/**
 * What a wipe of the Installation's folder would take: the kinds the player is told apart, in the
 * order they are reported. An Installation on the very same folder is its own kind (the way out is
 * not to move that folder, it is this one), and so is a VS Version on the very same folder (it
 * cannot be moved out either: it is removed from the VS Versions page, whose game files stay in
 * place). A linked VS Version inside the folder is its own kind too: its folder stays when it is
 * removed from the list, so uninstalling it is no way out.
 */
export type HeldKind = "config" | "archive" | "installation" | "sameFolder" | "version" | "linkedVersion" | "sameFolderVersion"

export interface HeldOptions {
  /**
   * True for a delete with data: the Installation's own backups and world backups leave with it
   * (the records go with the entry), so they are not held. A restore keeps the records, so it
   * leaves this off and its own archives count like any other.
   */
  ignoreOwnArchives?: boolean
}

interface Candidate {
  path: string
  kind: HeldKind
  /** For an Installation: its name. For a VS Version: its label. */
  name?: string
  /** For an archive: whose it is, and the world for a world backup. */
  archive?: { installation: string; world?: string }
}

/**
 * Everything a wipe of `installation.path` must not take, in the order the player deals with it:
 * the three Config folders, then the backup archives the config lists, then the other Installations
 * and the VS Versions. The archives come before the Installations because removing an Installation's
 * entry makes the launcher forget its archives, so each one has to be dealt with while it is listed.
 */
function candidates(installation: { id: string }, { settings, installations, gameVersions }: ManagedFolders, { ignoreOwnArchives = false }: HeldOptions): Candidate[] {
  const archives = installations
    .filter((owner) => !(ignoreOwnArchives && owner.id === installation.id))
    .flatMap((owner) => [
      ...(owner.backups ?? []).map((backup) => ({ path: backup.path, kind: "archive" as const, archive: { installation: owner.name } })),
      ...(owner.worldBackups ?? []).map((backup) => ({ path: backup.path, kind: "archive" as const, archive: { installation: owner.name, world: backup.worldName } }))
    ])

  return [
    ...[settings.backupsFolder, settings.defaultInstallationsFolder, settings.defaultVersionsFolder].map((path) => ({ path, kind: "config" as const })),
    ...archives,
    ...installations.filter((other) => other.id !== installation.id).map((other) => ({ path: other.path, kind: "installation" as const, name: other.name })),
    ...gameVersions.map((gameVersion) => ({
      path: gameVersion.path,
      kind: gameVersion.linked === true ? ("linkedVersion" as const) : ("version" as const),
      name: gameVersion.label ?? gameVersion.path
    }))
  ]
}

/**
 * The managed folder or file an Installation's own folder holds, if any: one of the three folders
 * from Config, a backup archive the config lists (whichever Installation it belongs to and wherever
 * the Backups folder is set now), another Installation (or one sharing its folder) or a VS Version.
 * Restoring or deleting the Installation wipes its folder, and the host refuses to when this is not
 * null, so the caller says what to move before any archive is extracted.
 */
export function findHeldManagedFolder(installation: { id: string; path: string }, folders: ManagedFolders, platform: FolderPlatform, options: HeldOptions = {}): string | null {
  return describeHeldFolder(installation, folders, platform, options)?.path ?? null
}

/** What findHeldManagedFolder found, and which kind it is. For a listed archive: whose, and how many the folder holds in all. */
export interface HeldFolder {
  path: string
  kind: HeldKind
  /** For an Installation: its name. For a VS Version on the same folder: its label. */
  name?: string
  archive?: { installation: string; world?: string; total: number }
}

/**
 * findHeldManagedFolder, plus the kind of what it found. A listed archive's path says neither which
 * Installation nor which world, and a folder that held an old Backups folder holds many, so its
 * entry names the first one's owner and the total instead of one refusal per archive.
 */
export function describeHeldFolder(installation: { id: string; path: string }, folders: ManagedFolders, platform: FolderPlatform, options: HeldOptions = {}): HeldFolder | null {
  const all = candidates(installation, folders, options)
  const first = all.find((candidate) => firstHeldFolder(installation.path, [candidate.path], platform) !== null)
  if (!first) return null
  const onSameFolder = folderIsInUse(first.path, [installation.path], platform)
  if (first.kind === "installation") return { path: first.path, kind: onSameFolder ? "sameFolder" : "installation", name: first.name }
  if (first.kind === "version" || first.kind === "linkedVersion") return onSameFolder ? { path: first.path, kind: "sameFolderVersion", name: first.name } : { path: first.path, kind: first.kind }
  if (first.kind !== "archive" || !first.archive) return { path: first.path, kind: first.kind }
  const total = all.filter((candidate) => candidate.kind === "archive" && folderIsInside(candidate.path, installation.path, platform)).length
  return { path: first.path, kind: "archive", archive: { ...first.archive, total } }
}
