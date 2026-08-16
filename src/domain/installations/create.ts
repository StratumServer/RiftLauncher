import type { IdGenerator } from "../ports"

/** Bounds an installation name must fall within. */
export const INSTALLATION_NAME_MIN_LENGTH = 5
export const INSTALLATION_NAME_MAX_LENGTH = 50

/** Start param the launcher injects itself; an installation may not claim it as its own. */
export const RESERVED_START_PARAM = "--dataPath"

/** Why the name or start params of an installation don't hold up, shared by create and edit. */
export type InstallationFieldsFailure = "name-length" | "reserved-start-param"

export type InstallationFieldsResult = { ok: true } | { ok: false; reason: InstallationFieldsFailure }

export interface InstallationFieldsInput {
  name: string
  startParams: string
}

function refuseFields(reason: InstallationFieldsFailure): InstallationFieldsResult {
  return { ok: false, reason }
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

  if (name.length < INSTALLATION_NAME_MIN_LENGTH || name.length > INSTALLATION_NAME_MAX_LENGTH) return refuseFields("name-length")
  if (startParams.includes(RESERVED_START_PARAM)) return refuseFields("reserved-start-param")

  return { ok: true }
}

/** Why an installation was not created. */
export type CreateInstallationFailure = InstallationFieldsFailure | "folder-in-use"

export type CreateInstallationResult = { ok: true; installation: CreatedInstallation } | { ok: false; reason: CreateInstallationFailure }

export interface CreateInstallationPorts {
  ids: IdGenerator
}

export interface CreateInstallationInput {
  name: string
  icon: string
  path: string
  version: string
  startParams: string
  backupsLimit: number
  backupsAuto: boolean
  compressionLevel: number
  mesaGlThread: boolean
  envVars: string
  /** Folders the launcher already uses for backups, versions or other installations. */
  foldersInUse: readonly string[]
}

/** The record built for a fresh installation, ready for the caller to add to its list. */
export interface CreatedInstallation {
  id: string
  name: string
  icon: string
  path: string
  version: string
  startParams: string
  backupsLimit: number
  backupsAuto: boolean
  compressionLevel: number
  mesaGlThread: boolean
  envVars: string
  backups: []
  lastTimePlayed: number
  totalTimePlayed: number
}

function refuseCreate(reason: CreateInstallationFailure): CreateInstallationResult {
  return { ok: false, reason }
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
  if (!fields.ok) return refuseCreate(fields.reason)

  if (input.foldersInUse.includes(input.path)) return refuseCreate("folder-in-use")

  return {
    ok: true,
    installation: {
      id: ports.ids.newId(),
      name: input.name,
      icon: input.icon,
      path: input.path,
      version: input.version,
      startParams: input.startParams,
      backupsLimit: input.backupsLimit,
      backupsAuto: input.backupsAuto,
      compressionLevel: input.compressionLevel,
      mesaGlThread: input.mesaGlThread,
      envVars: input.envVars,
      backups: [],
      lastTimePlayed: -1,
      totalTimePlayed: 0
    }
  }
}
