/**
 * Putting the account session into the game's own settings file, which is the
 * only thing the launcher ever does with a logged-in account.
 *
 * The launcher does not authenticate anything at launch time. It writes eight
 * keys into the `clientsettings.json` of the installation's data folder, and
 * the GAME reads them on startup to consider itself logged in for multiplayer.
 * The spelling of those keys is the contract, to the character: they are all
 * lowercase, and they do not match the names the launcher stores them under
 * (`sessionKey` becomes `sessionkey`, `hostGameServer` becomes
 * `hostgameserver`). That mapping lives here so a test can pin it.
 *
 * ## Read, modify, write. Never replace
 *
 * That file belongs to the game and holds every preference in it: resolution,
 * volumes, key bindings, language. Only the session keys are touched, and
 * everything else in the document comes back out unchanged. A file that exists
 * but holds no readable JSON stops the launch instead of being overwritten,
 * which is the behaviour the launcher has always had: losing somebody's game
 * settings to install a session in them would be a very bad trade.
 *
 * ## Shapes nobody expects
 *
 * A document that is not an object at all, and a `stringSettings` that is an
 * array, both have defined outcomes here. They are inherited outcomes, not
 * designed ones, and they are pinned by tests exactly as they were: this module
 * moved the launch path into the domain, and doing that while quietly changing
 * what happens to a weird settings file would be the one thing worse than
 * leaving the code where it was.
 */

import type { JsonFile } from "../ports"

/** Name of the game's settings file, inside an installation's data folder. */
export const CLIENT_SETTINGS_FILE_NAME = "clientsettings.json"

/** Key of the section the session keys live in. */
const STRING_SETTINGS_SECTION = "stringSettings"

/**
 * The account session, under the names the launcher stores it with.
 *
 * Takes the launcher's spelling rather than the game's so the caller hands over
 * what it already holds and this module owns the whole translation.
 */
export interface AccountSessionFields {
  mptoken: string | null
  sessionKey: string
  sessionSignature: string
  email: string
  playerEntitlements: string
  playerUid: string
  playerName: string
  hostGameServer: boolean
}

/**
 * The section to build the session keys on top of.
 *
 * Returns the existing section when the document is a plain object carrying one
 * that is any kind of object, and an empty section otherwise. Note the
 * asymmetry, which is inherited: the DOCUMENT is refused when it is an array,
 * the SECTION is not, so a `stringSettings` that is an array is kept and merged
 * into. It is left that way on purpose. Both branches produce a settings file
 * the game can read the session out of, and picking a different answer here
 * would be a change to what somebody's game does, made on the way past.
 */
function existingStringSettings(document: unknown): Record<string, unknown> {
  if (!document || typeof document !== "object" || Array.isArray(document)) return {}

  const stringSettings = (document as Record<string, unknown>)[STRING_SETTINGS_SECTION]
  if (typeof stringSettings !== "object" || stringSettings === null) return {}

  return stringSettings as Record<string, unknown>
}

/**
 * Lays the session over `existingDocument` and gives back the whole document to
 * write.
 *
 * @param existingDocument What the settings file held, or undefined when there was none.
 * @param session The account session to install.
 * @returns The complete document, everything the old one carried included.
 */
export function mergeSessionIntoClientSettings(existingDocument: unknown, session: AccountSessionFields): Record<string, unknown> {
  return {
    ...(existingDocument as Record<string, unknown>),
    [STRING_SETTINGS_SECTION]: {
      ...existingStringSettings(existingDocument),
      mptoken: session.mptoken,
      sessionkey: session.sessionKey,
      sessionsignature: session.sessionSignature,
      useremail: session.email,
      entitlements: session.playerEntitlements,
      playeruid: session.playerUid,
      playername: session.playerName,
      hostgameserver: session.hostGameServer
    }
  }
}

/**
 * Why the session was not installed.
 *
 * `unreadable-settings` means the file is there and holds something that is not
 * JSON, so nothing was written. `write-failed` means the merged document could
 * not be put back.
 */
export type WriteClientSettingsSessionFailure = "unreadable-settings" | "write-failed"

export type WriteClientSettingsSessionResult = { ok: true } | { ok: false; reason: WriteClientSettingsSessionFailure }

export interface WriteClientSettingsSessionPorts {
  jsonFile: JsonFile
}

export interface WriteClientSettingsSessionInput {
  /** Full path of the settings file. The caller resolves it, so path policy stays on the host side. */
  settingsPath: string
  session: AccountSessionFields
}

/**
 * Reads the settings file, lays the session over it, and writes it back.
 *
 * @param ports Host capabilities the work runs on.
 * @param input Where the file is and what to install into it.
 * @returns Success, or the reason the session was not installed.
 */
export async function writeClientSettingsSession(ports: WriteClientSettingsSessionPorts, input: WriteClientSettingsSessionInput): Promise<WriteClientSettingsSessionResult> {
  const existing = await ports.jsonFile.read(input.settingsPath)
  if (!existing.ok) return { ok: false, reason: "unreadable-settings" }

  const written = await ports.jsonFile.write(input.settingsPath, mergeSessionIntoClientSettings(existing.document, input.session))

  return written.ok ? { ok: true } : { ok: false, reason: "write-failed" }
}
