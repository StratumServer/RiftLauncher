import type { IdGenerator } from "../ports"
import { firstHeldFolder, folderIsInUse, folderOverlapsInUse, type FolderPlatform } from "../paths"
import { refuse } from "../refusal"

/** Bounds an installation name must fall within. */
export const INSTALLATION_NAME_MIN_LENGTH = 5
export const INSTALLATION_NAME_MAX_LENGTH = 50

/** Start param the launcher injects itself; an installation may not claim it as its own. */
export const RESERVED_START_PARAM = "--dataPath"

/**
 * Checks whether a Backups max amount is a valid non-negative integer.
 * `0` is valid and turns automatic and manual backups off for that installation.
 */
export function isValidBackupsLimit(backupsLimit: number): boolean {
  return Number.isInteger(backupsLimit) && backupsLimit >= 0
}

/** Why the name or start params of an installation don't hold up, shared by create and edit. */
export type InstallationFieldsFailure = "name-length" | "reserved-start-param"

export type InstallationFieldsResult = { ok: true } | { ok: false; reason: InstallationFieldsFailure }

export interface InstallationFieldsInput {
  name: string
  startParams: string
}

/**
 * Checks the two rules that apply to an installation's data whether it is
 * being created or edited: the name has to fit inside the launcher's bounds,
 * and the start params can't fight the launcher's own `--dataPath` flag.
 *
 * @param input The name and start params to check.
 * @returns Success, or the reason the fields don't hold up.
 */
export function validateInstallationFields(input: InstallationFieldsInput): InstallationFieldsResult {
  const { name, startParams } = input

  if (name.length < INSTALLATION_NAME_MIN_LENGTH || name.length > INSTALLATION_NAME_MAX_LENGTH) return refuse("name-length")
  if (startParams.includes(RESERVED_START_PARAM)) return refuse("reserved-start-param")

  return { ok: true }
}

/** Why an installation was not created. */
export type CreateInstallationFailure = InstallationFieldsFailure | "folder-in-use" | "folder-nested"

export type CreateInstallationResult = { ok: true; installation: CreatedInstallation } | { ok: false; reason: CreateInstallationFailure }

export interface CreateInstallationPorts {
  ids: IdGenerator
}

export interface CreateInstallationInput {
  name: string
  icon: string
  path: string
  version: string
  gameVersionId?: string | null
  startParams: string
  backupsLimit: number
  backupsAuto: boolean
  compressionLevel: number
  mesaGlThread: boolean
  envVars: string
  launchWrapper?: string
  /** Folders the launcher already uses for backups, versions or other installations. */
  foldersInUse: readonly string[]
  /**
   * The Installations and VS Versions folders from Config. An Installation folder may sit inside
   * them, as the default layout does, but may not be one or hold one: wiping it would take the
   * folders with it. Left out, nothing is checked.
   */
  configuredFolders?: readonly string[]
  /** Host platform for path normalization. Read off the path's shape when absent, which cannot tell macOS from Linux. */
  platform?: FolderPlatform
}

/** The record built for a fresh installation, ready for the caller to add to its list. */
export interface CreatedInstallation {
  id: string
  name: string
  icon: string
  path: string
  version: string
  gameVersionId: string | null
  startParams: string
  backupsLimit: number
  backupsAuto: boolean
  compressionLevel: number
  mesaGlThread: boolean
  envVars: string
  launchWrapper?: string
  backups: []
  lastTimePlayed: number
  totalTimePlayed: number
}

/**
 * Validates a new installation's fields and builds the record for it.
 *
 * Nothing is written to disk and nothing is dispatched: the caller owns
 * ensuring the data folder exists and adding the built record to its list.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The fields the user filled in, plus what folders are already in use.
 * @returns The built record, or the reason nothing was built.
 */
export function createInstallation(ports: CreateInstallationPorts, input: CreateInstallationInput): CreateInstallationResult {
  const fields = validateInstallationFields(input)
  if (!fields.ok) return refuse(fields.reason)

  if (folderIsInUse(input.path, input.foldersInUse, input.platform)) return refuse("folder-in-use")
  // Restoring or deleting the outer folder takes the inner one with it, backups included.
  if (folderOverlapsInUse(input.path, input.foldersInUse, input.platform)) return refuse("folder-nested")
  if (input.configuredFolders && firstHeldFolder(input.path, input.configuredFolders, input.platform)) return refuse("folder-nested")

  return {
    ok: true,
    installation: {
      id: ports.ids.newId(),
      name: input.name,
      icon: input.icon,
      path: input.path,
      version: input.version,
      gameVersionId: input.gameVersionId ?? null,
      startParams: input.startParams,
      backupsLimit: input.backupsLimit,
      backupsAuto: input.backupsAuto,
      compressionLevel: input.compressionLevel,
      mesaGlThread: input.mesaGlThread,
      envVars: input.envVars,
      ...(input.launchWrapper?.trim() ? { launchWrapper: input.launchWrapper.trim() } : {}),
      backups: [],
      lastTimePlayed: -1,
      totalTimePlayed: 0
    }
  }
}
