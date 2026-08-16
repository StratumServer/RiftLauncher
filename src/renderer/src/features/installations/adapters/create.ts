import { v4 as uuidv4 } from "uuid"

import type { CreateInstallationPorts, CreatedInstallation, InstallationFieldsFailure, CreateInstallationFailure } from "@domain/installations/create"

/** Wires the create service onto the renderer. It only needs to mint an id. */
export function createCreateInstallationPorts(): CreateInstallationPorts {
  return { ids: { newId: () => uuidv4() } }
}

/** The three config slices a folder collision can come from. Narrower than the whole config on purpose. */
export interface FoldersInUse {
  backupsFolder: string
  installations: readonly { path: string }[]
  gameVersions: readonly { path: string }[]
}

/** Folders the launcher already treats as spoken for: backups, installations, versions. */
export function toFoldersInUse({ backupsFolder, installations, gameVersions }: FoldersInUse): string[] {
  return [backupsFolder, ...installations.map((i) => i.path), ...gameVersions.map((gv) => gv.path)]
}

/** Turns the built record into the full config shape, with the runtime flags a fresh installation starts without. */
export function toInstallationType(installation: CreatedInstallation): InstallationType {
  return { ...installation, _modsCount: 0 }
}

export interface InstallationFailureFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/** How the UI reacts to a name or start params that don't hold up, shared by create and edit. */
export function describeInstallationFieldsFailure(reason: InstallationFieldsFailure): InstallationFailureFeedback {
  switch (reason) {
    case "name-length":
      return { messageKey: "features.installations.installationNameMinMaxCharacters", logged: false }
    case "reserved-start-param":
      return { messageKey: "features.installations.cantUseDataPath", logged: false }
  }
}

/** How the UI reacts to a refused installation creation. */
export function describeCreateInstallationFailure(reason: CreateInstallationFailure): InstallationFailureFeedback {
  if (reason === "folder-in-use") return { messageKey: "features.installations.folderAlreadyInUse", logged: false }
  return describeInstallationFieldsFailure(reason)
}
