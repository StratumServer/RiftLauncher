import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { AccountSecrets } from "@domain/account/credentials"

/**
 * The encrypted account store, against a fake `safeStorage`.
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
 * `cachedSecrets` is module state, which is why almost every case re-imports
 * the store through `loadStore()` after `vi.resetModules()`: a test that shared
 * the cache with the one before it would be reading the previous test's answer.
 */

const PLACEHOLDER_SECRETS: AccountSecrets = {
  sessionKey: "placeholder-session-key",
  sessionSignature: "placeholder-session-signature",
  mptoken: "placeholder-multiplayer-token"
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

/** Writes the store file directly, standing in for whatever left it in that state. */
function writeStoreFile(contents: unknown): void {
  writeFileSync(storePath(), typeof contents === "string" ? contents : JSON.stringify(contents))
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
    await writer.saveAccountSecrets(PLACEHOLDER_SECRETS)

    const reader = await loadStore()

    assert.deepEqual(await reader.getAccountSecrets(), PLACEHOLDER_SECRETS)
  })

  it("leaves no plaintext secret in the file", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets(PLACEHOLDER_SECRETS)

    const raw = readFileSync(storePath(), "utf8")
    assert.equal(raw.includes(PLACEHOLDER_SECRETS.sessionKey), false, "the session key is readable in the store file")
    assert.equal(raw.includes(PLACEHOLDER_SECRETS.sessionSignature), false, "the session signature is readable in the store file")
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["ciphertext", "version"])
    assert.equal(JSON.parse(raw).version, 1)
  })

  it("keeps the file readable only by its owner", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets(PLACEHOLDER_SECRETS)

    assert.equal(statSync(storePath()).mode & 0o777, 0o600)
  })

  it("leaves no temporary file behind", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets(PLACEHOLDER_SECRETS)

    assert.deepEqual(
      readdirSync(mockState.userDataDir).filter((entry) => entry.endsWith(".tmp")),
      []
    )
  })

  it("replaces the secrets a previous save wrote", async () => {
    const first = await loadStore()
    await first.saveAccountSecrets(PLACEHOLDER_SECRETS)

    const second = await loadStore()
    await second.saveAccountSecrets({ ...PLACEHOLDER_SECRETS, sessionKey: "placeholder-session-key-two", mptoken: null })

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets(), { ...PLACEHOLDER_SECRETS, sessionKey: "placeholder-session-key-two", mptoken: null })
  })

  it("refuses to write when the platform offers no encryption", async () => {
    mockState.encryptionAvailable = false
    const store = await loadStore()

    await assert.rejects(store.saveAccountSecrets(PLACEHOLDER_SECRETS), /Secure account storage is unavailable/)

    assert.equal(existsSync(storePath()), false)
  })

  it.skipIf(process.platform !== "linux")("refuses to write when Linux would fall back to an unencrypted backend", async () => {
    // `basic_text` is safeStorage's answer for a Linux session with no keyring:
    // it still encrypts, with a hardcoded key, which is not storage a session
    // key belongs in. The rule is Linux-only, and so is the case.
    mockState.storageBackend = "basic_text"
    const store = await loadStore()

    await assert.rejects(store.saveAccountSecrets(PLACEHOLDER_SECRETS), /A system password store is required/)
    assert.equal(existsSync(storePath()), false)
  })
})

describe("getAccountSecrets", () => {
  it("answers null when nothing was ever stored", async () => {
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null for a file that is not JSON", async () => {
    writeStoreFile("{ not json at all")
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null for a store written by a version this one does not know", async () => {
    writeStoreFile({ version: 2, ciphertext: Buffer.from("sealed:{}", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null when the ciphertext field is not a string", async () => {
    writeStoreFile({ version: 1, ciphertext: 42 })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null when the ciphertext cannot be decrypted", async () => {
    writeStoreFile({ version: 1, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null when the decrypted payload is not JSON", async () => {
    writeStoreFile({ version: 1, ciphertext: Buffer.from("sealed:not json", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null when the decrypted payload is missing a session field", async () => {
    writeStoreFile({ version: 1, ciphertext: Buffer.from(`sealed:${JSON.stringify({ sessionKey: "placeholder-session-key" })}`, "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.getAccountSecrets(), null)
  })

  it("answers null when the platform offers no encryption, rather than reading the file", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets(PLACEHOLDER_SECRETS)

    mockState.encryptionAvailable = false
    const reader = await loadStore()

    assert.equal(await reader.getAccountSecrets(), null)
  })

  it("reads the file once and answers from memory after that", async () => {
    const writer = await loadStore()
    await writer.saveAccountSecrets(PLACEHOLDER_SECRETS)

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets(), PLACEHOLDER_SECRETS)
    rmSync(storePath())

    assert.deepEqual(await reader.getAccountSecrets(), PLACEHOLDER_SECRETS)
  })

  it("remembers a miss too, rather than re-reading a file that is not there", async () => {
    const store = await loadStore()
    assert.equal(await store.getAccountSecrets(), null)

    // A save is what refreshes the cache; a file appearing underneath it is not.
    writeStoreFile({ version: 1, ciphertext: Buffer.from(`sealed:${JSON.stringify(PLACEHOLDER_SECRETS)}`, "utf8").toString("base64") })

    assert.equal(await store.getAccountSecrets(), null)
  })
})

describe("clearAccountSecrets", () => {
  it("removes the file and forgets what was cached", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets(PLACEHOLDER_SECRETS)
    assert.deepEqual(await store.getAccountSecrets(), PLACEHOLDER_SECRETS)

    assert.equal(await store.clearAccountSecrets(), true)

    assert.equal(existsSync(storePath()), false)
    assert.equal(await store.getAccountSecrets(), null)
  })

  it("reports success when there was nothing to remove", async () => {
    const store = await loadStore()

    assert.equal(await store.clearAccountSecrets(), true)
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("reports failure when the file cannot be removed", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets(PLACEHOLDER_SECRETS)
    // Removing a file needs write permission on its folder, not on the file.
    chmodSync(mockState.userDataDir, 0o500)

    assert.equal(await store.clearAccountSecrets(), false)

    chmodSync(mockState.userDataDir, 0o700)
    assert.equal(existsSync(storePath()), true)
  })
})
