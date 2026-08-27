import { app, safeStorage } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { parseStoredSecrets, parseStoredSecretsById, type AccountSecrets, type StoredAccountSecretsEntry } from "@domain/account/credentials"

type EncryptedAccountFile = {
  version: 2
  ciphertext: string
}

/** Decrypted shape of `EncryptedAccountFile.ciphertext`, one entry per saved account. */
type StoredAccountsPayload = {
  accounts: StoredAccountSecretsEntry[]
}

/** Pre-multi-account store shape, kept only so a v1 file can be re-keyed once. */
type LegacyEncryptedAccountFile = {
  version: 1
  ciphertext: string
}

const ACCOUNT_STORE_VERSION = 2
const LEGACY_ACCOUNT_STORE_VERSION = 1

/**
 * `undefined` means the file has not been read this process. A read that
 * cannot be decrypted, or finds nothing there, caches an empty map rather
 * than `undefined`, so a later call answers from memory instead of hitting
 * the disk again. A miss on one account cannot poison a later hit on another,
 * because the cache holds the whole file's contents, not one account's.
 */
let cachedAccounts: Map<string, AccountSecrets> | undefined

function getAccountStorePath(): string {
  return join(app.getPath("userData"), "account-secrets.json")
}

/**
 * Where a pre-migration copy of the store is kept, so a re-key gone wrong or a
 * downgrade to a build that only understands one account never destroys the
 * original bytes. One rolling file, not one per migration: this is a local
 * single-writer desktop store, not a fleet of servers, so a single "as it was
 * right before the multi-account migration" snapshot is the useful recovery
 * point, and it is only ever written once, by {@link adoptLegacySingleAccountSecrets}.
 */
function getAccountStoreBackupPath(): string {
  return join(app.getPath("userData"), "account-secrets.pre-migration.bak.json")
}

function assertSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure account storage is unavailable")
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("A system password store is required for account storage")
}

async function readAccounts(): Promise<Map<string, AccountSecrets>> {
  if (cachedAccounts !== undefined) return cachedAccounts

  try {
    assertSecureStorage()
    const stored = (await fse.readJSON(getAccountStorePath(), "utf8")) as Partial<EncryptedAccountFile>
    if (stored.version !== ACCOUNT_STORE_VERSION || typeof stored.ciphertext !== "string") throw new Error("Invalid account store")

    const decrypted = safeStorage.decryptString(Buffer.from(stored.ciphertext, "base64"))
    cachedAccounts = parseStoredSecretsById(JSON.parse(decrypted))
  } catch {
    cachedAccounts = new Map()
  }

  return cachedAccounts
}

/**
 * Encrypts and writes the whole account map, atomically.
 *
 * If the file on disk exists but cannot be decrypted, this still overwrites
 * it: the old bytes are already unrecoverable, so refusing to write would
 * only leave the launcher permanently unable to save any account. At
 * multi-account scale this means one undecryptable file now costs every
 * saved account's session instead of the one account the old single-account
 * store held, which is a real change in blast radius worth this comment,
 * even though it is not a new kind of risk.
 */
async function writeAccounts(accounts: Map<string, AccountSecrets>): Promise<void> {
  assertSecureStorage()

  const payload: StoredAccountsPayload = { accounts: Array.from(accounts, ([id, secrets]) => ({ id, secrets })) }
  const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString("base64")
  const storePath = getAccountStorePath()
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`
  const contents: EncryptedAccountFile = { version: ACCOUNT_STORE_VERSION, ciphertext: encrypted }

  try {
    await fse.writeJSON(temporaryPath, contents, { spaces: 0, mode: 0o600 })
    await fse.chmod(temporaryPath, 0o600).catch(() => undefined)
    await fse.move(temporaryPath, storePath, { overwrite: true })
    await fse.chmod(storePath, 0o600).catch(() => undefined)
    cachedAccounts = accounts
  } finally {
    await fse.remove(temporaryPath).catch(() => undefined)
  }
}

/** Saves or replaces one account's secrets. Logging into an already-saved account overwrites its entry: a session refresh, not a duplicate. */
export async function saveAccountSecrets(accountId: string, secrets: AccountSecrets): Promise<void> {
  const accounts = new Map(await readAccounts())
  accounts.set(accountId, secrets)
  await writeAccounts(accounts)
}

/** Reads one account's secrets, or null when nothing is stored for it. */
export async function getAccountSecrets(accountId: string): Promise<AccountSecrets | null> {
  return (await readAccounts()).get(accountId) ?? null
}

/**
 * Drops one account's secrets. `true` when there was nothing to remove,
 * matching the old single-account store's `clearAccountSecrets`: a caller
 * asking to remove an account that already has no stored session is not a
 * failure. When the map empties, the file itself is removed rather than left
 * behind holding an empty list, so a never-used store and a fully-logged-out
 * one are byte-for-byte the same on disk.
 */
export async function removeAccountSecrets(accountId: string): Promise<boolean> {
  const accounts = new Map(await readAccounts())
  if (!accounts.delete(accountId)) return true

  try {
    if (accounts.size === 0) {
      await fse.remove(getAccountStorePath())
      cachedAccounts = new Map()
    } else {
      await writeAccounts(accounts)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Re-keys a pre-multi-account store under the one account it used to hold.
 *
 * A no-op, returning `false`, on anything that is not exactly a v1 file:
 * already migrated, never existed, or unreadable. That makes this safe to
 * call on every launch, the same way the schema-3-to-4 config migration it
 * runs alongside is: idempotent by construction, not by a separate "already
 * ran" flag.
 *
 * Takes a backup of the original v1 file before overwriting it, once, so the
 * pre-migration bytes are never destroyed. See {@link getAccountStoreBackupPath}.
 */
export async function adoptLegacySingleAccountSecrets(accountId: string): Promise<boolean> {
  const storePath = getAccountStorePath()

  let stored: Partial<LegacyEncryptedAccountFile>
  try {
    stored = (await fse.readJSON(storePath, "utf8")) as Partial<LegacyEncryptedAccountFile>
  } catch {
    return false
  }
  if (stored.version !== LEGACY_ACCOUNT_STORE_VERSION || typeof stored.ciphertext !== "string") return false

  assertSecureStorage()
  let secrets: AccountSecrets | null
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(stored.ciphertext, "base64"))
    secrets = parseStoredSecrets(JSON.parse(decrypted))
  } catch {
    return false
  }
  if (!secrets) return false

  await fse.copy(storePath, getAccountStoreBackupPath(), { overwrite: false, errorOnExist: false })

  await writeAccounts(new Map([[accountId, secrets]]))
  return true
}
