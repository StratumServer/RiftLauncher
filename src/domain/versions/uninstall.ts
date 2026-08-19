import type { FileSystem } from "../ports"

/** The game version state an uninstall decision needs, copied out of wherever it lives. */
export interface GameVersionSnapshot {
  version: string
  path: string
  isPlaying: boolean
  isDeleting: boolean
  /** True when this folder was registered, not installed, by the launcher. See `uninstallGameVersion`. */
  linked: boolean
}

/** Why a version was not uninstalled. */
export type UninstallGameVersionFailure = "version-playing" | "version-busy" | "version-in-use" | "file-delete-failed"

/** `folderRemoved` tells a caller which of the two outcomes happened without re-deriving it from the input. */
export type UninstallGameVersionResult = { ok: true; folderRemoved: boolean } | { ok: false; reason: UninstallGameVersionFailure }

export interface UninstallGameVersionPorts {
  fileSystem: Pick<FileSystem, "remove">
}

export interface UninstallGameVersionInput {
  version: GameVersionSnapshot
  /** Names of the installations still pointing at this version, for display in the warning. */
  usedByInstallations: readonly string[]
  /** Whether the caller already warned the player about `usedByInstallations` and got a yes. */
  confirmedInUse: boolean
}

/**
 * Side effects the caller owns: persisted flags, notifications, logging. The
 * service only says when they happen.
 */
export interface UninstallGameVersionEvents {
  /** Fired once the preconditions pass and the deletion is about to start. */
  onStarted?(): void
  /** Fired once the work is over, success or not. */
  onFinished?(): void
}

function refuse(reason: UninstallGameVersionFailure): UninstallGameVersionResult {
  return { ok: false, reason }
}

/**
 * Deletes one installed version's folder off disk, and drops it from the
 * launcher's list either way (the caller's job, and only once this says the
 * outcome).
 *
 * A `linked` version is one the launcher never installed, only registered
 * from a folder the player already had. For that case removing it from the
 * list is the whole job: calling `fileSystem.remove` on it would delete a
 * folder the launcher does not own, which is the exact bug this flag exists
 * to prevent. The guards above still apply unchanged, since a linked version
 * being played or still pinned by an installation is just as real a reason
 * to refuse.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The version to uninstall.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns Success (and whether the folder was actually removed), or the reason the folder is still there.
 */
export async function uninstallGameVersion(ports: UninstallGameVersionPorts, input: UninstallGameVersionInput, events: UninstallGameVersionEvents = {}): Promise<UninstallGameVersionResult> {
  const { version, usedByInstallations, confirmedInUse } = input

  if (version.isPlaying) return refuse("version-playing")
  if (version.isDeleting) return refuse("version-busy")
  if (usedByInstallations.length > 0 && !confirmedInUse) return refuse("version-in-use")

  events.onStarted?.()

  try {
    if (version.linked) return { ok: true, folderRemoved: false }

    if (!(await ports.fileSystem.remove(version.path))) return refuse("file-delete-failed")

    return { ok: true, folderRemoved: true }
  } finally {
    events.onFinished?.()
  }
}
