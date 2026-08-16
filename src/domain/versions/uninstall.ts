import type { FileSystem } from "../ports"

/** The game version state an uninstall decision needs, copied out of wherever it lives. */
export interface GameVersionSnapshot {
  version: string
  path: string
  isPlaying: boolean
  isDeleting: boolean
}

/** Why a version was not uninstalled. */
export type UninstallGameVersionFailure = "version-playing" | "version-busy" | "version-in-use" | "file-delete-failed"

export type UninstallGameVersionResult = { ok: true } | { ok: false; reason: UninstallGameVersionFailure }

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
 * Deletes one installed version's folder off disk. Dropping it from the
 * launcher's list is the caller's job, and only once this says the folder is
 * gone.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The version to uninstall.
 * @param events Hooks the caller uses to mirror progress into its own state.
 * @returns Success, or the reason the folder is still there.
 */
export async function uninstallGameVersion(ports: UninstallGameVersionPorts, input: UninstallGameVersionInput, events: UninstallGameVersionEvents = {}): Promise<UninstallGameVersionResult> {
  const { version, usedByInstallations, confirmedInUse } = input

  if (version.isPlaying) return refuse("version-playing")
  if (version.isDeleting) return refuse("version-busy")
  if (usedByInstallations.length > 0 && !confirmedInUse) return refuse("version-in-use")

  events.onStarted?.()

  try {
    if (!(await ports.fileSystem.remove(version.path))) return refuse("file-delete-failed")

    return { ok: true }
  } finally {
    events.onFinished?.()
  }
}
