import { isRecord } from "./validation"

export type AccountSecrets = {
  sessionKey: string
  sessionSignature: string
  mptoken: string | null
}

export type AccountCredentials = {
  publicAccount: AccountPublicType
  secrets: AccountSecrets
}

const MAX_ACCOUNT_FIELD_LENGTH = 128 * 1024

function accountString(value: unknown, name: string, maxLength = MAX_ACCOUNT_FIELD_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) throw new TypeError(`Invalid account ${name}`)
  return value
}

function accountBoolean(value: unknown, name: string): boolean {
  if (value === true || value === 1 || value === "1") return true
  if (value === false || value === 0 || value === "0") return false
  throw new TypeError(`Invalid account ${name}`)
}

function nullableAccountString(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null
  return accountString(value, name)
}

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
