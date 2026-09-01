import { app, safeStorage } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { parseStoredSecrets, parseStoredSecretsById, type AccountSecrets, type StoredAccountSecretsEntry } from "@domain/account/credentials"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { isRecord } from "@src/ipc/validation"

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
 * How much the map that came back can be trusted. Three states, because the
 * two ways a read can come back empty-but-not-really need different answers:
 *
 * - `readable`: the map is the whole truth. Either the file was read, or there
 *   is genuinely no file, which is the ordinary no-accounts-yet case and not a
 *   problem to report.
 * - `locked`: the file is there, but secure storage is not, so nothing could be
 *   opened. Temporary, and not the file's fault: the keyring unlocking later
 *   must still reach the real bytes, so this must never trigger the
 *   preserve-and-rebuild path a corrupt store gets (#261).
 * - `corrupt`: the file is there and cannot be trusted (wrong version, bad
 *   JSON, decrypt failure, a payload with no accounts list). The sessions it
 *   held are already gone, so a login may rebuild the store around itself once
 *   its bytes are safely copied aside.
 *
 * Both non-`readable` states hand back an empty map that says nothing about
 * what is on disk, so no mutation may treat "not in the map" as "not stored".
 */
type StoreStatus = "readable" | "locked" | "corrupt"

/** `undefined` for `cachedRead` means the file has not been read this process. */
type StoreRead = { accounts: Map<string, AccountSecrets>; status: StoreStatus }
let cachedRead: StoreRead | undefined

/**
 * Every mutation of the store is a read-modify-write: read the whole map,
 * change one entry, rewrite the whole file. Two of those overlapping both
 * build their new map from the same starting point, and the second `rename()`
 * then wins with a map that never saw the first one's change, silently
 * dropping an account's session. Overlapping logins and the game-session
 * adoption path both reach this.
 *
 * So mutations run one at a time, chained onto this promise the way the config
 * writer chains its own. Reads stay outside the chain: they only ever hand
 * back the cached map, and a read racing a write already resolves to whichever
 * of the two maps it observes, which is what a caller asking "what is stored
 * right now" gets in any case.
 *
 * ponytail: one chain for the whole store, not one per account. This is a
 * desktop store rewritten in full on every change, so per-account locks would
 * not let anything more overlap: the file is the contended resource, not the
 * entry.
 */
let storeMutations: Promise<unknown> = Promise.resolve()

/** Runs `mutate` once every mutation queued before it has settled, failure included. */
function serializeMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const run = storeMutations.then(mutate)
  storeMutations = run.catch(() => undefined)
  return run
}

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

/**
 * Where an unreadable store's bytes are kept before {@link saveAccountSecrets}
 * rebuilds the file around a new login. A separate file from the
 * pre-migration backup above on purpose: those are two different events (an
 * old-format file being upgraded, versus a current-format file that stopped
 * decrypting), and sharing one path would let whichever happens second
 * silently erase the first one's snapshot.
 */
function getUnreadableStoreBackupPath(): string {
  return join(app.getPath("userData"), "account-secrets.unreadable.bak.json")
}

/** The unreadable store's bytes could not be copied aside, so nothing was written over it. */
export class AccountStoreUnreadableError extends Error {
  constructor(cause?: unknown) {
    super("The account store is unreadable and its bytes could not be preserved", { cause })
    this.name = "AccountStoreUnreadableError"
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function assertSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure account storage is unavailable")
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("A system password store is required for account storage")
}

async function readStore(): Promise<StoreRead> {
  if (cachedRead !== undefined) return cachedRead

  try {
    assertSecureStorage()
  } catch {
    // Not the file's fault, and not cached: the keyring becoming available later must still
    // reach the real bytes. Whether there is a file at all is the whole difference between
    // "nothing is stored" and "something is stored and cannot be opened right now", and only
    // the first of those lets a caller act as if the empty map were the truth.
    return { accounts: new Map(), status: (await fse.pathExists(getAccountStorePath())) ? "locked" : "readable" }
  }

  try {
    const stored = (await fse.readJSON(getAccountStorePath(), "utf8")) as Partial<EncryptedAccountFile>
    if (stored.version !== ACCOUNT_STORE_VERSION || typeof stored.ciphertext !== "string") throw new Error("Invalid account store")

    const decrypted = safeStorage.decryptString(Buffer.from(stored.ciphertext, "base64"))
    const payload: unknown = JSON.parse(decrypted)
    // An entry parseStoredSecretsById itself drops is not corruption: a file holding one
    // broken entry beside three good ones is still a store worth writing to. A payload with
    // no accounts list at all is the file failing to be this store's shape in the first place.
    if (!isRecord(payload) || !Array.isArray(payload.accounts)) throw new Error("Invalid account store payload")
    cachedRead = { accounts: parseStoredSecretsById(payload), status: "readable" }
  } catch (error) {
    cachedRead = { accounts: new Map(), status: isMissingFileError(error) ? "readable" : "corrupt" }
  }

  return cachedRead
}

async function readAccounts(): Promise<Map<string, AccountSecrets>> {
  return (await readStore()).accounts
}

/**
 * Copies the current, unreadable store file aside once, so a rebuild around a
 * new login never destroys bytes that might still hold other accounts'
 * sessions. `overwrite: false` keeps the first snapshot and skips every later
 * one. That is a deliberate one-shot: a second corruption event can land after
 * the store has rebuilt and grown, so the skipped snapshot sometimes holds
 * more than the kept one, which for a version-mismatch file (recoverable by
 * the newer build that wrote it) is a real loss. The trade is accepted here
 * because a single predictable recovery file beats an unbounded pile of them,
 * and nothing in the app surfaces or clears these yet regardless (tracked as a
 * follow-up on #259).
 *
 * Throws {@link AccountStoreUnreadableError} when the copy itself fails (a
 * permissions problem, most likely): that is the one case where proceeding
 * to rebuild would destroy bytes rather than merely fail to read them, so
 * the caller must not write anything.
 */
async function preserveUnreadableStore(): Promise<void> {
  try {
    await fse.copy(getAccountStorePath(), getUnreadableStoreBackupPath(), { overwrite: false, errorOnExist: false })
  } catch (error) {
    if (isMissingFileError(error)) return // Vanished since the read; nothing left to preserve.
    throw new AccountStoreUnreadableError(error)
  }
}

/**
 * Encrypts and writes the whole account map, atomically.
 *
 * Callers decide what "the whole account map" should contain before calling
 * this; it always overwrites the file with exactly what it is given. See
 * {@link saveAccountSecrets} for the policy on when that is safe to do.
 */
async function writeAccounts(accounts: Map<string, AccountSecrets>): Promise<void> {
  assertSecureStorage()

  const payload: StoredAccountsPayload = { accounts: Array.from(accounts, ([id, secrets]) => ({ id, secrets })) }
  const encrypted = safeStorage.encryptString(JSON.stringify(payload)).toString("base64")
  const storePath = getAccountStorePath()
  const contents: EncryptedAccountFile = { version: ACCOUNT_STORE_VERSION, ciphertext: encrypted }

  // write-file-atomic opens the temp file with this mode, so the file rename() lands
  // is already 0600; the explicit chmod is defense in depth against a permissive umask,
  // matching what this store did before.
  await writeJsonAtomic(storePath, contents, { mode: 0o600 })
  await fse.chmod(storePath, 0o600).catch(() => undefined)
  cachedRead = { accounts, status: "readable" }
}

/** What {@link saveAccountSecrets} actually did: a plain save, or a save that first had to rebuild an unreadable store around it. */
export type AccountSaveOutcome = "saved" | "saved-after-rebuild"

/**
 * Saves or replaces one account's secrets. Logging into an already-saved
 * account overwrites its entry: a session refresh, not a duplicate.
 *
 * When the store is present but unreadable, the sessions it held are already
 * gone the moment it stopped decrypting: refusing this write would not bring
 * any of them back, only leave the launcher unable to save any account ever
 * again, with nothing in the app to clear the dead file for it. So this
 * preserves the unreadable bytes once (see {@link preserveUnreadableStore})
 * and rebuilds the store around just the account logging in now, the same
 * "never destroy without a snapshot" rule the rest of this file already
 * follows. The caller is told which happened, so a login that quietly wiped
 * a housemate's session is never reported as an ordinary one.
 */
export function saveAccountSecrets(accountId: string, secrets: AccountSecrets): Promise<AccountSaveOutcome> {
  return serializeMutation(async () => {
    const store = await readStore()
    const accounts = new Map(store.accounts)
    accounts.set(accountId, secrets)

    // Only a corrupt store is rebuilt. A locked keyring falls through to writeAccounts, which
    // asserts secure storage and throws before it could overwrite anything (#261).
    if (store.status !== "corrupt") {
      await writeAccounts(accounts)
      return "saved"
    }

    await preserveUnreadableStore()
    await writeAccounts(accounts)
    return "saved-after-rebuild"
  })
}

/** Reads one account's secrets, or null when nothing is stored for it. */
export async function getAccountSecrets(accountId: string): Promise<AccountSecrets | null> {
  return (await readAccounts()).get(accountId) ?? null
}

/**
 * Drops one account's secrets. `true` when there was nothing to remove from a
 * store that could actually be read, matching the old single-account store's
 * `clearAccountSecrets`: a caller asking to remove an account that already has
 * no stored session is not a failure. When the map empties, the file itself is
 * removed rather than left behind holding an empty list, so a never-used store
 * and a fully-logged-out one are byte-for-byte the same on disk.
 *
 * `false` when the account is not in the map only because the store could not
 * be read (a locked keyring, or bytes that stopped decrypting). The entry may
 * well be sitting in those bytes, so "nothing to remove" is not the truth, and
 * reporting success would have the renderer drop the account from config and
 * tell the player it is gone while its session is still on disk under a uid
 * nothing names any more. Refusing keeps the account and surfaces the store
 * problem instead. This never rebuilds the file: only `saveAccountSecrets`,
 * running for a login the player actually asked for, does that.
 */
export function removeAccountSecrets(accountId: string): Promise<boolean> {
  return serializeMutation(async () => {
    const store = await readStore()
    const accounts = new Map(store.accounts)
    if (!accounts.delete(accountId)) return store.status === "readable"

    try {
      if (accounts.size === 0) {
        await fse.remove(getAccountStorePath())
        cachedRead = { accounts: new Map(), status: "readable" }
      } else {
        await writeAccounts(accounts)
      }
      return true
    } catch {
      return false
    }
  })
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
export function adoptLegacySingleAccountSecrets(accountId: string): Promise<boolean> {
  return serializeMutation(async () => {
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
  })
}
