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
  storageBackend: "gnome_libsecret",
  /** Set by the overlapping-mutation cases to hold a write open; every other case leaves the real writer alone. */
  beforeWrite: undefined as (() => Promise<void>) | undefined
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

/**
 * The real atomic writer, with one suspension point in front of it. Overlapping
 * saves are otherwise impossible to stage: a mutation only becomes observable
 * to another one at its `rename()`, so a test needs to stop a write mid-flight
 * and let the next caller run against the store as it stands.
 */
vi.mock("@src/ipc/atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/atomicJsonFile")>()
  return {
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>): Promise<void> => {
      await mockState.beforeWrite?.()
      await actual.writeJsonAtomic(...args)
    }
  }
})

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

function unreadableBackupPath(): string {
  return join(mockState.userDataDir, "account-secrets.unreadable.bak.json")
}

function versionedUnreadableBackupPath(version: number): string {
  return join(mockState.userDataDir, `account-secrets.unreadable.v${version}.bak.json`)
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
  mockState.beforeWrite = undefined
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

  // chmod on Windows only toggles the read-only attribute; it cannot produce
  // the POSIX 0o600 this reads back off disk.
  it.skipIf(process.platform === "win32")("keeps the file readable only by its owner", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(statSync(storePath()).mode & 0o777, 0o600)
  })

  it("leaves no temporary file behind", async () => {
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    // write-file-atomic names its temp sibling `<file>.<hash>`, never `<file>.tmp`, so a
    // suffix filter would pass on anything: assert the store file is the only entry left.
    assert.deepEqual(
      readdirSync(mockState.userDataDir).filter((entry) => entry !== "account-secrets.json"),
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

    const stored = JSON.parse(readFileSync(storePath(), "utf8"))
    const payload = JSON.parse(Buffer.from(stored.ciphertext, "base64").toString("utf8").slice("sealed:".length))
    assert.equal(payload.accounts.length, 1, "one entry replaced in place, not a second one appended")
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

/**
 * #259: a store present but unreadable used to be indistinguishable from an absent one, so the
 * next `saveAccountSecrets` silently overwrote it, losing every other account's session in one
 * shot instead of just the one the old single-account store would have held. These pin the fix:
 * the bytes are preserved once, the write still lands so the player logging in is not blocked,
 * and the caller is told a rebuild happened rather than an ordinary save.
 */
describe("saveAccountSecrets rebuilding an unreadable store", () => {
  it("copies an undecryptable store aside before rebuilding it around the new login", async () => {
    const original = JSON.stringify({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    writeStoreFile(original)
    const store = await loadStore()

    const outcome = await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(outcome, "saved-after-rebuild")
    assert.equal(readFileSync(unreadableBackupPath(), "utf8"), original, "the backup holds the exact bytes that were there, not a re-serialised guess at them")

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
  })

  it("does the same for a file that is not JSON at all", async () => {
    writeStoreFile("{ not json at all")
    const store = await loadStore()

    assert.equal(await store.saveAccountSecrets("uid-a", ACCOUNT_A), "saved-after-rebuild")
    assert.equal(existsSync(unreadableBackupPath()), true)
  })

  it("rebuilds around a store written by a version this build does not know", async () => {
    writeStoreFile({ version: 3, ciphertext: Buffer.from("sealed:{}", "utf8").toString("base64") })
    const store = await loadStore()

    assert.equal(await store.saveAccountSecrets("uid-a", ACCOUNT_A), "saved-after-rebuild")
    // Its snapshot goes to a version-scoped path, not the unversioned corruption slot (#270).
    assert.equal(existsSync(join(mockState.userDataDir, "account-secrets.unreadable.v3.bak.json")), true)
  })

  it("treats a store whose entries it merely dropped as readable, not unreadable", async () => {
    // Same fixture as the "drops one unreadable entry" case above: one bad entry beside one
    // good one is a store worth writing to, not a store worth rebuilding around.
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

    assert.equal(await store.saveAccountSecrets("uid-a", ACCOUNT_A), "saved")
    assert.equal(existsSync(unreadableBackupPath()), false)

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
    assert.deepEqual(await reader.getAccountSecrets("uid-b"), ACCOUNT_B, "the account the corrupt-entry check let through survives the save too")
  })

  it("keeps the first unreadable snapshot rather than overwriting it on a later corruption", async () => {
    writeFileSync(unreadableBackupPath(), JSON.stringify({ sentinel: "already there" }))
    writeStoreFile({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(readFileSync(unreadableBackupPath(), "utf8"), JSON.stringify({ sentinel: "already there" }))
  })

  // #270: a store rejected only for a newer version is not corrupt (a newer build can still read
  // it), so its snapshot must not take the single unversioned slot that a later, genuinely
  // unrecoverable store will need.
  it("keeps a newer-version store's snapshot on its own path, not the unversioned slot", async () => {
    const foreign = JSON.stringify({ version: 3, ciphertext: Buffer.from("sealed:{}", "utf8").toString("base64") })
    writeStoreFile(foreign)
    const store = await loadStore()

    assert.equal(await store.saveAccountSecrets("uid-a", ACCOUNT_A), "saved-after-rebuild")

    assert.equal(existsSync(unreadableBackupPath()), false, "the unversioned slot is left free")
    assert.equal(readFileSync(join(mockState.userDataDir, "account-secrets.unreadable.v3.bak.json"), "utf8"), foreign, "the newer-version bytes are kept on a version-scoped path")
  })

  it("still snapshots a genuine corruption after a newer-version rebuild has happened", async () => {
    writeStoreFile({ version: 3, ciphertext: Buffer.from("sealed:{}", "utf8").toString("base64") })
    assert.equal(await (await loadStore()).saveAccountSecrets("uid-a", ACCOUNT_A), "saved-after-rebuild")

    const genuinelyCorrupt = JSON.stringify({ version: 2, ciphertext: Buffer.from("truncated garbage", "utf8").toString("base64") })
    writeStoreFile(genuinelyCorrupt)
    assert.equal(await (await loadStore()).saveAccountSecrets("uid-b", ACCOUNT_B), "saved-after-rebuild")

    assert.equal(readFileSync(unreadableBackupPath(), "utf8"), genuinelyCorrupt, "the irrecoverable bytes get the unversioned slot the newer-version file no longer holds")
  })

  it("never collides with the pre-migration backup file", async () => {
    writeFileSync(backupPath(), JSON.stringify({ sentinel: "pre-migration snapshot" }))
    writeStoreFile({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    const store = await loadStore()

    await store.saveAccountSecrets("uid-a", ACCOUNT_A)

    assert.equal(readFileSync(backupPath(), "utf8"), JSON.stringify({ sentinel: "pre-migration snapshot" }), "the migration backup is a different event and a different file")
    assert.equal(existsSync(unreadableBackupPath()), true)
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("refuses to rebuild a store it cannot even copy aside", async () => {
    const original = JSON.stringify({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    writeStoreFile(original)
    chmodSync(mockState.userDataDir, 0o500) // read the file, but fse.copy cannot create a new one here
    const store = await loadStore()

    try {
      await assert.rejects(store.saveAccountSecrets("uid-a", ACCOUNT_A), /could not be preserved/)
    } finally {
      chmodSync(mockState.userDataDir, 0o700)
    }

    assert.equal(existsSync(unreadableBackupPath()), false)
    assert.equal(readFileSync(storePath(), "utf8"), original, "nothing was written over a file this could not back up first")
  })

  it("does not snapshot or touch an intact store when only the keyring is locked", async () => {
    // A locked keyring reads as unreadable-adjacent, but the file is fine: readStore returns
    // early with unreadable:false so a later unlock still reaches it, and writeAccounts throws
    // before it could overwrite anything. Without that split, the first locked-keyring login
    // would copy the intact store to the one-shot snapshot slot and then fail the login anyway,
    // stranding a stale copy where a genuine corruption event would later need one (#261 review).
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)
    await writer.saveAccountSecrets("uid-b", ACCOUNT_B)
    const onDisk = readFileSync(storePath(), "utf8")
    const mode = statSync(storePath()).mode & 0o777

    mockState.encryptionAvailable = false
    const store = await loadStore()

    await assert.rejects(store.saveAccountSecrets("uid-c", ACCOUNT_A), /Secure account storage is unavailable/)

    assert.equal(existsSync(unreadableBackupPath()), false, "a locked keyring is not a corruption event")
    assert.equal(readFileSync(storePath(), "utf8"), onDisk, "the real store is left byte-for-byte")
    assert.equal(statSync(storePath()).mode & 0o777, mode, "and at the mode it had")
  })
})

/**
 * #291: every mutation here is a read-modify-write over the whole file. Two of
 * them overlapping used to snapshot the same map, and whichever `rename()`
 * landed last then wrote a map that had never seen the other one's change,
 * dropping an account's session with nothing to show for it. Overlapping
 * logins and the game-session adoption path both reach this.
 */
describe("overlapping mutations", () => {
  /**
   * Parks the next atomic write and hands back the release. `reached` resolves
   * once that write is actually parked, so a case can start a second mutation
   * knowing the first is stopped in the middle of its read-modify-write.
   */
  function holdNextWrite(): { reached: Promise<void>; release: () => void } {
    let release = (): void => undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    let signalReached = (): void => undefined
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve
    })

    mockState.beforeWrite = async (): Promise<void> => {
      mockState.beforeWrite = undefined // Only the first write is held; whatever queues behind it runs normally.
      signalReached()
      await parked
    }

    return { reached, release: () => release() }
  }

  /**
   * Long enough for an unserialized mutation to read the store, build its own
   * map and land its rename while the held one is still parked, which is the
   * loss reproduced in review. Serialized, the second one simply waits, and
   * the pause costs the suite these few milliseconds instead.
   */
  async function letTheSecondMutationRun(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }

  it("keeps both accounts when two saves for different ids overlap", async () => {
    const store = await loadStore()
    const held = holdNextWrite()

    const first = store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await held.reached
    const second = store.saveAccountSecrets("uid-b", ACCOUNT_B)
    await letTheSecondMutationRun()
    held.release()
    await Promise.all([first, second])

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A, "the save that was still in flight survived the one that started after it")
    assert.deepEqual(await reader.getAccountSecrets("uid-b"), ACCOUNT_B, "and the second account landed too")
  })

  it("keeps a save that overlaps the removal of another account", async () => {
    const accountC: AccountSecrets = { ...ACCOUNT_A, sessionKey: "placeholder-session-key-c" }
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await store.saveAccountSecrets("uid-b", ACCOUNT_B)

    const held = holdNextWrite()
    const removal = store.removeAccountSecrets("uid-b")
    await held.reached
    const save = store.saveAccountSecrets("uid-c", accountC)
    await letTheSecondMutationRun()
    held.release()

    assert.equal(await removal, true)
    await save

    const reader = await loadStore()
    assert.deepEqual(await reader.getAccountSecrets("uid-a"), ACCOUNT_A)
    assert.equal(await reader.getAccountSecrets("uid-b"), null, "the removal still took effect")
    assert.deepEqual(await reader.getAccountSecrets("uid-c"), accountC, "and the save that overlapped it was not undone by the removal's rewrite")
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

  it("keeps recovery copies while another account remains, then removes all of them with the last account", async () => {
    const store = await loadStore()
    await store.saveAccountSecrets("uid-a", ACCOUNT_A)
    await store.saveAccountSecrets("uid-b", ACCOUNT_B)

    const recoveryPaths = [backupPath(), unreadableBackupPath(), versionedUnreadableBackupPath(3), versionedUnreadableBackupPath(17)]
    for (const path of recoveryPaths) writeFileSync(path, "recovery copy")
    const unrelatedPath = join(mockState.userDataDir, "account-secrets.unreadable.vx.bak.json")
    writeFileSync(unrelatedPath, "not a recognized versioned backup")

    assert.equal(await store.removeAccountSecrets("uid-a"), true)
    assert.equal(existsSync(storePath()), true)
    for (const path of recoveryPaths) assert.equal(existsSync(path), true)

    assert.equal(await store.removeAccountSecrets("uid-b"), true)
    assert.equal(existsSync(storePath()), false)
    for (const path of recoveryPaths) assert.equal(existsSync(path), false)
    assert.equal(existsSync(unrelatedPath), true)
  })

  it("reports success when there was nothing to remove", async () => {
    const store = await loadStore()

    assert.equal(await store.removeAccountSecrets("uid-a"), true)
  })

  it("reports failure, and leaves the file alone, when secure storage is unavailable", async () => {
    // #291: an existing store used to count as readable whenever the keyring was unavailable,
    // so this reached the success path with an empty map and returned true. SessionButton then
    // dropped the profile from config and told the player the account was gone, while its
    // encrypted credentials sat on disk under a uid nothing named any more.
    const writer = await loadStore()
    await writer.saveAccountSecrets("uid-a", ACCOUNT_A)
    const onDisk = readFileSync(storePath(), "utf8")

    mockState.encryptionAvailable = false
    const store = await loadStore()

    assert.equal(await store.removeAccountSecrets("uid-a"), false)
    assert.equal(readFileSync(storePath(), "utf8"), onDisk, "the credentials it could not open are still exactly where they were")
  })

  it("still reports success when secure storage is unavailable and there is no store file", async () => {
    // The other way a read comes back empty. Nothing is stored, so nothing was left behind,
    // and refusing here would strand an account in config over a store that never existed.
    mockState.encryptionAvailable = false
    const store = await loadStore()

    assert.equal(await store.removeAccountSecrets("uid-a"), true)
  })

  it("reports failure, not a false success, when the store cannot be read", async () => {
    // A locked keyring, or a file that stopped decrypting. The account asked for could be in
    // those very bytes, so "nothing to remove" is not the truth. A false success would have
    // the renderer drop it from config and tell the player it is gone (#253 review).
    const original = JSON.stringify({ version: 2, ciphertext: Buffer.from("someone else's bytes", "utf8").toString("base64") })
    writeFileSync(storePath(), original)
    const store = await loadStore()

    assert.equal(await store.removeAccountSecrets("uid-a"), false)
    assert.equal(readFileSync(storePath(), "utf8"), original, "the unreadable file is left exactly as it was")
    assert.equal(existsSync(unreadableBackupPath()), false, "removing an account never snapshots or rebuilds the store")
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
