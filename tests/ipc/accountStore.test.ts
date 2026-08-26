import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { AccountSecrets } from "@domain/account/credentials"

/**
 * The encrypted multi-account store, against a fake `safeStorage`.
 *
 * Electron's `safeStorage` talks to the OS keychain, so it is replaced here by
 * a reversible transform: enough to prove the store writes ciphertext and reads
 * it back, not enough to prove the OS encryption works, which is not this
 * repository's to test.
 *
 * The values below are placeholders and nothing else. A session key is what an
 * attacker would want out of this file, so no fixture here is shaped like a
 * real one.
 *
 * `cachedAccounts` is module state, which is why almost every case re-imports
 * the store through `loadStore()` after `vi.resetModules()`: a test that shared
 * the cache with the one before it would be reading the previous test's answer.
 */

const ACCOUNT_A: AccountSecrets = {
  sessionKey: "placeholder-session-key-a",
  sessionSignature: "placeholder-session-signature-a",
  mptoken: "placeholder-multiplayer-token-a"
}

const ACCOUNT_B: AccountSecrets = {
  sessionKey: "placeholder-session-key-b",
  sessionSignature: "placeholder-session-signature-b",
  mptoken: null
}

const mockState = vi.hoisted(() => ({
  userDataDir: "",
  encryptionAvailable: true,
  storageBackend: "gnome_libsecret"
}))

/**
 * `encryptString`/`decryptString` are a reversible prefix, so a test can assert
 * that what landed on disk is not the plaintext without pretending to test the
 * platform's crypto.
 */
vi.mock("electron", () => ({
  app: { getPath: (): string => mockState.userDataDir },
  safeStorage: {
    isEncryptionAvailable: (): boolean => mockState.encryptionAvailable,
    getSelectedStorageBackend: (): string => mockState.storageBackend,
    encryptString: (text: string): Buffer => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (buffer: Buffer): string => {
      const text = buffer.toString("utf8")
      if (!text.startsWith("sealed:")) throw new Error("Cannot decrypt")
      return text.slice("sealed:".length)
    }
  }
}))

type AccountStore = typeof import("@src/ipc/accountStore")

/** A store with an empty cache, so a read actually reaches the file. */
async function loadStore(): Promise<AccountStore> {
  vi.resetModules()
  return await import("@src/ipc/accountStore")
}

function storePath(): string {
  return join(mockState.userDataDir, "account-secrets.json")
}

function backupPath(): string {
  return join(mockState.userDataDir, "account-secrets.pre-migration.bak.json")
}

/** Writes the store file directly, standing in for whatever left it in that state. */
function writeStoreFile(contents: unknown): void {
  writeFileSync(storePath(), typeof contents === "string" ? contents : JSON.stringify(contents))
}

/** A legacy v1 single-account file, in the shape the pre-multi-account store wrote. */
function writeLegacyStoreFile(secrets: AccountSecrets): void {
  writeStoreFile({ version: 1, ciphertext: Buffer.from(`sealed:${JSON.stringify(secrets)}`, "utf8").toString("base64") })
}

beforeEach(() => {
  mockState.userDataDir = mkdtempSync(join(tmpdir(), "rift-account-store-test-"))
  mockState.encryptionAvailable = true
  mockState.storageBackend = "gnome_libsecret"
})

afterEach(() => {
  chmodSync(mockState.userDataDir, 0o700)
  rmSync(mockState.userDataDir, { recursive: true, force: true })
})

describe("saveAccountSecrets", () => {
  it("round-trips through a store the same process reads back cold", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)

    const reader = await loadStore()

    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
  })

  it("keeps two accounts independent: saving one leaves the other exactly as it was", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)
    await writer.saveAccountSecrets("uid-b", ACCOUNT_B)

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
    assert.deepEqual(await reader.getAccountSecrets("uid-b"), ACCOUNT_B)
  })

  it("leaves no plaintext secret in the file", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    const raw = readFileSync(storePath(), "utf8")
    assert.equal(raw.includes(ACCOUNT_A.sessionKey), false, "the session key is readable in the store file")
    assert.equal(raw.includes(ACCOUNT_A.sessionSignature), false, "the session signature is readable in the store file")
    assert.equal(raw.includes("uid-a"), false, "the account id is readable outside the ciphertext")
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["ciphertext", "version"])
    assert.equal(JSON.parse(raw).version, 2)
  })

  it("keeps the file readable only by its owner", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(statSync(storePath()).mode & 0o777, 0o600)
  })

  it("leaves no temporary file behind", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.deepEqual(
      readdirSync(mockState.userDataDir).filter((entry) => entry.endsWith(".tmp")),
      []
    )
  })

  it("replaces the secrets a previous save wrote for the same account, a session refresh rather than a duplicate", async () => {
    const first = await loadStore()
    await first.saveAccountSecrets("uid-a", ACCOUNT_A)

    const second = await loadStore()
    await second.saveAccountSecrets("uid-a", { ...ACCOUNT_A, sessionKey: "placeholder-session-key-a-refreshed" })

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), { ...ACCOUNT_A, sessionKey: "placeholder-session-key-a-refreshed" })
    assert.deepEqual(await reader.listStoredAccountIds(), ["uid-a"])
  })

  it("refuses to write when the platform offers no encryption", async () => {
    mockState.encryptionAvailable = false
    const store = await loadStore()

    await assert.rejects(store.saveAccountSecrets("uid-a", ACCOUNT_A), /Secure account storage is unavailable/)

    assert.equal(existsSync(storePath()), false)
  })

  it.skipIf(process.platform !== "linux")("refuses to write when Linux would fall back to an unencrypted backend", async () => {
    // `basic_text` is safeStorage's answer for a Linux session with no keyring:
    // it still encrypts, with a hardcoded key, which is not storage a session
    // key belongs in. The rule is Linux-only, and so is the case.
    mockState.storageBackend = "basic_text"
    const store = await loadStore()

    await assert.rejects(store.saveAccountSecrets("uid-a", ACCOUNT_A), /A system password store is required/)
    assert.equal(existsSync(storePath()), false)
  })
})

describe("getAccountSecrets", () => {
  it("answers null when nothing was ever stored", async () => {
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("answers null for an id nobody saved, even when other accounts exist", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)

    const reader = await loadStore()
    assert.equal(await reader.getAccountSecrets("uid-b"), null)
  })

  it("answers null for a file that is not JSON", async () => {
    writeStoreFile("{ not json at all")
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("answers null for a store written by a version this one does not know", async () => {
    writeStoreFile({ version: 3, ciphertext: Buffer.from("sealed:{}", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("answers null for a legacy v1 store: reading it does not migrate it", async () => {
    writeLegacyStoreFile(ACCOUNT_A)
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null, "only adoptLegacySingleAccountSecrets reads a v1 file")
  })

  it("answers null when the ciphertext field is not a string", async () => {
    writeStoreFile({ version: 2, ciphertext: 42 })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("answers null when the ciphertext cannot be decrypted", async () => {
    writeStoreFile({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("answers null when the decrypted payload is not JSON", async () => {
    writeStoreFile({ version: 2, ciphertext: Buffer.from("sealed:not json", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("drops one unreadable entry without losing the others in the same file", async () => {
    writeStoreFile({
      version: 2,
      ciphertext: Buffer.from(
        `sealed:${JSON.stringify({
          accounts: [
            { id: "uid-a", secrets: { sessionKey: "only-a-key" } },
            { id: "uid-b", secrets: ACCOUNT_B }
          ]
        })}`,
        "utf8"
      ).toString("base64")
    })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets("uid-a"), null, "missing sessionSignature makes this entry unreadable")
    assert.deepEqual(await store.getAccountSecrets("uid-b"), ACCOUNT_B)
  })

  it("keeps the first entry on a duplicate id", async () => {
    writeStoreFile({
      version: 2,
      ciphertext: Buffer.from(
        `sealed:${JSON.stringify({
          accounts: [
            { id: "uid-a", secrets: ACCOUNT_A },
            { id: "uid-a", secrets: ACCOUNT_B }
          ]
        })}`,
        "utf8"
      ).toString("base64")
    })
    const store = await loadStore()

    assert.deepEqual(await store.getAccountSecrets("uid-a"), ACCOUNT_A)
  })

  it("treats an id equal to __proto__ as ordinary data, since the store is a Map keyed by string, not an object", async () => {
    writeStoreFile({
      version: 2,
      ciphertext: Buffer.from(`sealed:${JSON.stringify({ accounts: [{ id: "__proto__", secrets: ACCOUNT_A }] })}`, "utf8").toString("base64")
    })
    const store = await loadStore()

    assert.deepEqual(await store.getAccountSecrets("__proto__"), ACCOUNT_A)
  })

  it("answers null when the platform offers no encryption, rather than reading the file", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)

    mockState.encryptionAvailable = false
    const reader = await loadStore()

    assert.equal(await reader.getAccountSecrets("uid-a"), null)
  })

  it("reads the file once and answers from memory after that", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
    rmSync(storePath())

    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
  })

  it("remembers a miss too, rather than re-reading a file that is not there", async () => {
    const store = await loadStore()
    assert.equal(await store.getAccountSecrets("uid-a"), null)

    // A save is what refreshes the cache; a file appearing underneath it is not.
    writeStoreFile({ version: 2, ciphertext: Buffer.from(`sealed:${JSON.stringify({ accounts: [{ id: "uid-a", secrets: ACCOUNT_A }] })}`, "utf8").toString("base64") })

    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })
})

describe("removeAccountSecrets", () => {
  it("removes one account and leaves the file readable for the other", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await store.saveAccountSecrets("uid-b", ACCOUNT_B)

    assert.equal(await store.removeAccountSecrets("uid-a"), true)

    assert.equal(await store.getAccountSecrets("uid-a"), null)
    assert.deepEqual(await store.getAccountSecrets("uid-b"), ACCOUNT_B)
    assert.equal(existsSync(storePath()), true, "the file itself survives while another account is still in it")
  })

  it("removes the file entirely once the last account is gone", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(await store.removeAccountSecrets("uid-a"), true)

    assert.equal(existsSync(storePath()), false)
    assert.equal(await store.getAccountSecrets("uid-a"), null)
  })

  it("reports success when there was nothing to remove", async () => {
    const store = await loadStore()

    assert.equal(await store.removeAccountSecrets("uid-a"), true)
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("reports failure when the file cannot be rewritten", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await store.saveAccountSecrets("uid-b", ACCOUNT_B)
    // Removing uid-a still has to rewrite the file (uid-b remains), which needs
    // write access to the directory the same way saveAccountSecrets does.
    chmodSync(mockState.userDataDir, 0o500)

    assert.equal(await store.removeAccountSecrets("uid-a"), false)

    chmodSync(mockState.userDataDir, 0o700)
    assert.deepEqual(await store.getAccountSecrets("uid-b"), ACCOUNT_B)
  })
})

describe("listStoredAccountIds", () => {
  it("lists every id the store currently holds secrets for", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await store.saveAccountSecrets("uid-b", ACCOUNT_B)

    assert.deepEqual(new Set(await store.listStoredAccountIds()), new Set(["uid-a", "uid-b"]))
  })

  it("is empty when nothing has ever been saved", async () => {
    const store = await loadStore()
    assert.deepEqual(await store.listStoredAccountIds(), [])
  })
})

describe("adoptLegacySingleAccountSecrets", () => {
  it("re-keys a v1 store under the given account id", async () => {
    writeLegacyStoreFile(ACCOUNT_A)
    const store = await loadStore()

    assert.equal(await store.adoptLegacySingleAccountSecrets("uid-a"), true)
    assert.deepEqual(await store.getAccountSecrets("uid-a"), ACCOUNT_A)

    const raw = JSON.parse(readFileSync(storePath(), "utf8"))
    assert.equal(raw.version, 2)
  })

  it("backs up the original v1 file before overwriting it", async () => {
    writeLegacyStoreFile(ACCOUNT_A)
    const store = await loadStore()

    await store.adoptLegacySingleAccountSecrets("uid-a")

    assert.equal(existsSync(backupPath()), true)
    const backed = JSON.parse(readFileSync(backupPath(), "utf8"))
    assert.equal(backed.version, 1, "the backup holds the pre-migration v1 bytes, not the re-keyed result")
  })

  it("keeps the first backup rather than overwriting it on a later re-key attempt", async () => {
    writeFileSync(backupPath(), JSON.stringify({ sentinel: "already there" }))
    writeLegacyStoreFile(ACCOUNT_A)
    const store = await loadStore()

    await store.adoptLegacySingleAccountSecrets("uid-a")

    const backed = JSON.parse(readFileSync(backupPath(), "utf8"))
    assert.equal(backed.sentinel, "already there")
  })

  it("is a no-op on a store that has already been re-keyed", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)

    const later = await loadStore()
    assert.equal(await later.adoptLegacySingleAccountSecrets("uid-a"), false)
    assert.deepEqual(await later.getAccountSecrets("uid-a"), ACCOUNT_A, "the already-current store is untouched")
  })

  it("is a no-op when there is no store file at all", async () => {
    const store = await loadStore()
    assert.equal(await store.adoptLegacySingleAccountSecrets("uid-a"), false)
  })

  it("is a no-op on a v1 file that cannot be decrypted", async () => {
    writeStoreFile({ version: 1, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.adoptLegacySingleAccountSecrets("uid-a"), false)
    assert.equal(existsSync(backupPath()), false, "nothing worth backing up when the source was never readable")
  })

  it("is a no-op on a v1 file that decrypts but holds an incomplete secret", async () => {
    writeStoreFile({ version: 1, ciphertext: Buffer.from(`sealed:${JSON.stringify({ sessionKey: "only-a-key" })}`, "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.adoptLegacySingleAccountSecrets("uid-a"), false)
    assert.equal(existsSync(backupPath()), false, "nothing worth backing up when the source was never usable")
  })
})
