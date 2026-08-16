/**
 * Reading of the account fields the launcher keeps, wherever they came from: a
 * fresh `auth3.vintagestory.at/v2/gamelogin` response, the encrypted secret
 * store, or the plaintext `config.json` older versions used to write.
 *
 * Everything here splits one blob into two halves that are never allowed back
 * together: a {@link AccountPublicType} the renderer may see, and an
 * {@link AccountSecrets} the main process encrypts and keeps to itself. That
 * split is the point of the module. A parser that returned one object with
 * `playerName` next to `sessionKey` would put a session key one careless
 * `configDispatch` away from the renderer, which is exactly the shape the
 * launcher used to have.
 *
 * These functions are pure and stay pure: they read values handed to them and
 * return values. No storage, no network, no logging. Nothing in here ever puts
 * a secret in a thrown message either, which is why the guards below report the
 * NAME of the field they refused and never its value.
 */

/** Session credentials. Main process only: these never cross IPC. */
export type AccountSecrets = {
  sessionKey: string
  sessionSignature: string
  mptoken: string | null
}

/** One account, split along the line the renderer is not allowed to cross. */
export type AccountCredentials = {
  publicAccount: AccountPublicType
  secrets: AccountSecrets
}

const MAX_ACCOUNT_FIELD_LENGTH = 128 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function accountString(value: unknown, name: string, maxLength = MAX_ACCOUNT_FIELD_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) throw new TypeError(`Invalid account ${name}`)
  return value
}

/**
 * Reads a flag the account API spells three different ways.
 *
 * `hasgameserver` comes back as a JSON boolean, as `1`/`0`, or as `"1"`/`"0"`
 * depending on where the value was read from, and the launcher stores it as a
 * boolean. Anything outside those six values is refused rather than coerced,
 * because a silent `Boolean(value)` here would grant a server entitlement to
 * every account whose flag arrived in a shape nobody expected.
 */
function accountBoolean(value: unknown, name: string): boolean {
  if (value === true || value === 1 || value === "1") return true
  if (value === false || value === 0 || value === "0") return false
  throw new TypeError(`Invalid account ${name}`)
}

function nullableAccountString(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null
  return accountString(value, name)
}

/**
 * Reads a successful gamelogin response into the two halves.
 *
 * Throws when a field the launcher needs is missing or unusable. That is
 * deliberate: an account object built out of half a response would be stored,
 * written into the game's client settings, and fail much later with nothing
 * left to point at. {@link ../account/login} is the caller that turns the throw
 * into a named verdict.
 *
 * @param email The address the user typed. The response does not echo it back.
 * @param value The parsed response body.
 */
export function parseLoginAccount(email: string, value: unknown): AccountCredentials {
  if (!isRecord(value)) throw new TypeError("Invalid login response")

  const publicAccount: AccountPublicType = {
    email: accountString(email, "email", 320),
    playerName: accountString(value.playername, "player name", 256),
    playerUid: accountString(value.uid, "player uid", 256),
    playerEntitlements: accountString(value.entitlements, "entitlements"),
    hostGameServer: accountBoolean(value.hasgameserver, "game server flag")
  }

  return {
    publicAccount,
    secrets: {
      sessionKey: accountString(value.sessionkey, "session key"),
      sessionSignature: accountString(value.sessionsignature, "session signature"),
      mptoken: nullableAccountString(value.mptoken, "multiplayer token")
    }
  }
}

/**
 * Reads the account object older launcher versions wrote into `config.json` in
 * the clear, so the migration can move its secrets into the encrypted store.
 *
 * The field names differ from the API's, which is the whole reason this exists:
 * the legacy blob was written from an already-parsed account. Returns null
 * rather than throwing, because an unreadable legacy entry means there is
 * nothing to migrate, not that the launcher should refuse to start.
 */
export function parseLegacyAccount(value: unknown): AccountCredentials | null {
  if (!isRecord(value)) return null

  try {
    return parseLoginAccount(value.email as string, {
      playername: value.playerName,
      uid: value.playerUid,
      entitlements: value.playerEntitlements,
      hasgameserver: value.hostGameServer,
      sessionkey: value.sessionKey,
      sessionsignature: value.sessionSignature,
      mptoken: value.mptoken
    })
  } catch {
    return null
  }
}

/**
 * Reads secrets back out of the encrypted store. Null on anything unreadable,
 * which logs the user out instead of failing the launch.
 */
export function parseStoredSecrets(value: unknown): AccountSecrets | null {
  if (!isRecord(value)) return null

  try {
    return {
      sessionKey: accountString(value.sessionKey, "session key"),
      sessionSignature: accountString(value.sessionSignature, "session signature"),
      mptoken: nullableAccountString(value.mptoken, "multiplayer token")
    }
  } catch {
    return null
  }
}

/**
 * Reads the renderer-visible half out of stored config, dropping anything else
 * the object carried. A config file that still holds legacy session fields
 * loses them here, so they cannot ride along into the renderer.
 */
export function toPublicAccount(value: unknown): AccountPublicType | null {
  if (!isRecord(value)) return null

  try {
    return {
      email: accountString(value.email, "email", 320),
      playerName: accountString(value.playerName, "player name", 256),
      playerUid: accountString(value.playerUid, "player uid", 256),
      playerEntitlements: accountString(value.playerEntitlements, "entitlements"),
      hostGameServer: accountBoolean(value.hostGameServer, "game server flag")
    }
  } catch {
    return null
  }
}
