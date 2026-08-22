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
 * ## The game's own session wins
 *
 * The file is not only written, it is read first, and what it already carries
 * decides what happens next. A `sessionkey` that is not the launcher's own, on
 * the account the launcher is logged in as, can only have got there one way:
 * the game asked the player to log in and stored what the auth service handed
 * back. That key is newer than the launcher's and it is known good, so the
 * write is skipped and the caller is told to adopt it instead. Overwriting it
 * is what turned one invalidated session into a login prompt on every single
 * launch, forever (issue #204).
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

import { parseStoredSecrets } from "./credentials"
import type { AccountSecrets } from "./credentials"
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
  /** Null for an account with no entitlements. The game reads this straight into `ClientSettings.Entitlements`, so null is a value it already expects. */
  playerEntitlements: string | null
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
 * The session already in the file, when it is one worth keeping over ours.
 *
 * Null covers every other case, all of which end in the launcher's own session
 * being written exactly as before: no session in the file, our own session
 * already in it, a session belonging to somebody else, or one too incomplete to
 * store.
 *
 * ## Which fields say "somebody else"
 *
 * `sessionkey` alone says the session CHANGED. It cannot say whose it is now,
 * and that distinction decides whether adopting is a repair or a hijack: the
 * launcher's secret store holds a session key with no account attached to it,
 * so adopting one issued for a different player would leave the launcher
 * showing one name while carrying another player's credentials. `playeruid` is
 * checked against ours for that reason, and it is the right field for it: the
 * game writes it out of the same login response the key came from, and unlike
 * `useremail` (which the launcher fills in from what the user typed, not from
 * the response) it is the account's own identifier. A file whose `playeruid` is
 * missing or different is left alone and overwritten, which is what the
 * launcher has always done.
 *
 * Known limit: newer is inferred, never verified. There is no endpoint here to ask
 * whether a key is still live, so "the game wrote it, so the service accepted
 * it" is the whole argument. If the adopted key was itself invalidated in the
 * meantime the player gets one more prompt and the game writes another one,
 * which still terminates. Validating before adopting needs a session-check
 * endpoint mapped first.
 */
function sessionToAdopt(existingDocument: unknown, session: AccountSessionFields): AccountSecrets | null {
  const stringSettings = existingStringSettings(existingDocument)
  if (stringSettings.sessionkey === session.sessionKey) return null
  if (stringSettings.playeruid !== session.playerUid) return null

  return parseStoredSecrets({
    sessionKey: stringSettings.sessionkey,
    sessionSignature: stringSettings.sessionsignature,
    mptoken: stringSettings.mptoken
  })
}

/**
 * What became of the session.
 *
 * `written` is the ordinary outcome: the launcher's session is now in the file.
 * `adopted` means the file already held a newer one for this same account and
 * nothing was written, so the caller has to store the carried secrets as its
 * own or the next launch will stomp them again. `unreadable-settings` means the
 * file is there and holds something that is not JSON. `write-failed` means the
 * merged document could not be put back.
 *
 * One tagged field, no `ok` boolean, because `adopted` is neither a success a
 * caller may ignore nor a failure it may report: it carries work. A caller that
 * switches on this cannot quietly skip it.
 */
export type WriteClientSettingsSessionResult = { outcome: "written" } | { outcome: "adopted"; secrets: AccountSecrets } | { outcome: "unreadable-settings" } | { outcome: "write-failed" }

export interface WriteClientSettingsSessionPorts {
  jsonFile: JsonFile
}

export interface WriteClientSettingsSessionInput {
  /** Full path of the settings file. The caller resolves it, so path policy stays on the host side. */
  settingsPath: string
  session: AccountSessionFields
}

/**
 * Reads the settings file, and either lays the session over it and writes it
 * back, or steps aside for the session the game put there.
 *
 * @param ports Host capabilities the work runs on.
 * @param input Where the file is and what to install into it.
 * @returns What became of the session, adoption included.
 */
export async function writeClientSettingsSession(ports: WriteClientSettingsSessionPorts, input: WriteClientSettingsSessionInput): Promise<WriteClientSettingsSessionResult> {
  const existing = await ports.jsonFile.read(input.settingsPath)
  if (!existing.ok) return { outcome: "unreadable-settings" }

  const adoptable = sessionToAdopt(existing.document, input.session)
  if (adoptable) return { outcome: "adopted", secrets: adoptable }

  const written = await ports.jsonFile.write(input.settingsPath, mergeSessionIntoClientSettings(existing.document, input.session))

  return written.ok ? { outcome: "written" } : { outcome: "write-failed" }
}
