import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * SET_MOD_ENABLED, the rename behind turning a Mod off and on again (#287).
 *
 * Its own file rather than a section of modsHandlers.test.ts, and the reason is the whole point of
 * these rows: that file mocks `assertManagedPath` into a pass-through, and what has to be proved
 * here is that a hostile path meets the real policy, at the same grade a delete meets it. Nothing is
 * mocked below except the `electron` module itself, so every refusal is the launcher's own.
 */

let temporaryRoot: string
let userDataFolder: string
/** A Mods folder under the configured installations folder, which the policy grants with its subtree. */
let managedMods: string
/** A folder the config names nowhere, so nothing about it is managed. */
let outside: string

const ARCHIVE = "alpha-1.0.0.zip"
const DISABLED_ARCHIVE = `${ARCHIVE}.disabled`

type SetModEnabledHandler = (event: IpcMainInvokeEvent, path: string, enabled: boolean) => Promise<SetModEnabledResult>

function setModEnabled(): SetModEnabledHandler {
  return getIpcHandler<SetModEnabledHandler>(IPC_CHANNELS.MODS_MANAGER.SET_MOD_ENABLED)
}

/**
 * The config the policy reads, optionally naming one installation.
 *
 * Written before the handler is ever called, which is all the timing this needs: the config is read
 * on the first call and cached from there, and `vi.resetModules()` hands each test a fresh cache.
 */
function writeConfig(installationPath?: string): void {
  writeFileSync(
    join(userDataFolder, "config.json"),
    JSON.stringify({
      schemaVersion: 4,
      lastUsedInstallation: null,
      defaultInstallationsFolder: join(temporaryRoot, "Installations"),
      defaultVersionsFolder: join(temporaryRoot, "Versions"),
      backupsFolder: join(temporaryRoot, "Backups"),
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations: installationPath ? [{ id: "linked", name: "Linked", path: installationPath, version: "1.20.0" }] : [],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )
}

function seedArchive(name: string, contents = "not really a zip"): string {
  const archivePath = join(managedMods, name)
  writeFileSync(archivePath, contents, "utf-8")
  return archivePath
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "set-mod-enabled-"))
  userDataFolder = join(temporaryRoot, "userData")
  managedMods = join(temporaryRoot, "Installations", "Mods")
  outside = join(temporaryRoot, "elsewhere")
  mkdirSync(userDataFolder, { recursive: true })
  mkdirSync(managedMods, { recursive: true })
  mkdirSync(outside, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  writeConfig()

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("SET_MOD_ENABLED", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    seedArchive(ARCHIVE)

    await assert.rejects(() => setModEnabled()(createUntrustedEvent(), join(managedMods, ARCHIVE), false), /Unauthorized IPC sender/)
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
  })

  it("disables a mod by renaming its archive in place, and enables it by renaming it back", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)

    const off = await setModEnabled()(event, join(managedMods, ARCHIVE), false)

    assert.deepEqual(off, { ok: true, path: join(managedMods, DISABLED_ARCHIVE) })
    // One file the whole way through: renaming is the mechanism, so nothing was copied anywhere and
    // the bytes on the other side are the same bytes.
    assert.deepEqual(readdirSync(managedMods), [DISABLED_ARCHIVE])
    assert.equal(readFileSync(join(managedMods, DISABLED_ARCHIVE), "utf-8"), "not really a zip")

    const on = await setModEnabled()(event, join(managedMods, DISABLED_ARCHIVE), true)

    assert.deepEqual(on, { ok: true, path: join(managedMods, ARCHIVE) })
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
    assert.equal(readFileSync(join(managedMods, ARCHIVE), "utf-8"), "not really a zip")
  })

  it("leaves both archives alone when the name on the other side is already taken", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)
    seedArchive(DISABLED_ARCHIVE, "the other one")

    const result = await setModEnabled()(event, join(managedMods, ARCHIVE), false)

    assert.deepEqual(result, { ok: false, reason: "name-taken" })
    // Neither is destroyed and neither is quietly overwritten: a folder holding both halves of one
    // name is one the player made by hand, and only they know which of the two they meant to keep.
    assert.equal(readFileSync(join(managedMods, ARCHIVE), "utf-8"), "not really a zip")
    assert.equal(readFileSync(join(managedMods, DISABLED_ARCHIVE), "utf-8"), "the other one")
  })

  it("refuses to rename an archive that is already in the state being asked for", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)

    assert.deepEqual(await setModEnabled()(event, join(managedMods, ARCHIVE), true), { ok: false, reason: "already-in-state" })
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
  })

  it("refuses a file that is not a mod archive at all, however managed its folder is", async () => {
    const event = await createTrustedEvent()
    seedArchive("notes.txt")

    assert.deepEqual(await setModEnabled()(event, join(managedMods, "notes.txt"), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(managedMods), ["notes.txt"])
  })

  it("refuses a path outside every managed folder, the gate a delete meets too", async () => {
    const event = await createTrustedEvent()
    writeFileSync(join(outside, ARCHIVE), "not yours", "utf-8")

    assert.deepEqual(await setModEnabled()(event, join(outside, ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(outside), [ARCHIVE])
  })

  it("refuses a traversal back out of the Mods folder, even starting from inside it", async () => {
    const event = await createTrustedEvent()
    writeFileSync(join(outside, ARCHIVE), "not yours", "utf-8")

    assert.deepEqual(await setModEnabled()(event, join(managedMods, "..", "..", "elsewhere", ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(outside), [ARCHIVE])
  })

  it.skipIf(process.platform === "win32")("refuses an archive reached through a symbolic link, the same as a delete does", async () => {
    const event = await createTrustedEvent()
    writeFileSync(join(outside, ARCHIVE), "not yours", "utf-8")
    // Lexically under the managed folder, actually wherever the link points. The symlink walk is
    // what keeps the lexical answer honest, and the toggle takes the grade that keeps it.
    symlinkSync(outside, join(managedMods, "linked"))

    assert.deepEqual(await setModEnabled()(event, join(managedMods, "linked", ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(outside), [ARCHIVE])
  })

  it.skipIf(process.platform === "win32")("refuses an archive that is itself a symbolic link, so the rename cannot follow it out", async () => {
    const event = await createTrustedEvent()
    writeFileSync(join(outside, "real.zip"), "not yours", "utf-8")
    // The nastier shape: the link is the archive, not a folder above it, so the destination name
    // sits in a perfectly ordinary folder and only the source check stands between the toggle and
    // renaming a link that points anywhere at all. The scan drops link entries and never lists this
    // as a row, and the channel has to refuse it on its own account regardless.
    symlinkSync(join(outside, "real.zip"), join(managedMods, ARCHIVE))

    assert.deepEqual(await setModEnabled()(event, join(managedMods, ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
  })

  it.skipIf(process.platform === "win32")("renames an archive inside a Mods folder that is itself a symbolic link", async () => {
    const event = await createTrustedEvent()
    // The setup the scan supports and the toggle used to refuse: the game data lives somewhere else,
    // usually the default Vintage Story folder or another disk, and the installation's Mods folder is
    // a link at it. Nothing about the archive is a link, so the rename stays inside one real folder.
    const realMods = join(outside, "Mods")
    mkdirSync(realMods, { recursive: true })
    writeFileSync(join(realMods, ARCHIVE), "not really a zip", "utf-8")
    const installation = join(temporaryRoot, "Installations", "linked-install")
    mkdirSync(installation, { recursive: true })
    symlinkSync(realMods, join(installation, "Mods"))
    writeConfig(installation)

    const off = await setModEnabled()(event, join(installation, "Mods", ARCHIVE), false)

    assert.deepEqual(off, { ok: true, path: join(installation, "Mods", DISABLED_ARCHIVE) })
    assert.deepEqual(readdirSync(realMods), [DISABLED_ARCHIVE])
    assert.equal(readFileSync(join(realMods, DISABLED_ARCHIVE), "utf-8"), "not really a zip")
  })

  it.skipIf(process.platform === "win32")("still refuses an archive that is a link inside a Mods folder that is a link", async () => {
    const event = await createTrustedEvent()
    // Both halves at once: the folder earns the exception, the archive does not, and the check that
    // stands between the toggle and renaming a file anywhere on the disk is the one on the archive.
    const realMods = join(outside, "Mods")
    mkdirSync(realMods, { recursive: true })
    writeFileSync(join(outside, "real.zip"), "not yours", "utf-8")
    symlinkSync(join(outside, "real.zip"), join(realMods, ARCHIVE))
    const installation = join(temporaryRoot, "Installations", "linked-install")
    mkdirSync(installation, { recursive: true })
    symlinkSync(realMods, join(installation, "Mods"))
    writeConfig(installation)

    assert.deepEqual(await setModEnabled()(event, join(installation, "Mods", ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(realMods), [ARCHIVE])
    assert.equal(readFileSync(join(outside, "real.zip"), "utf-8"), "not yours")
  })

  it.skipIf(process.platform === "win32")("still refuses an archive a level deeper, behind a link planted in a Mods folder", async () => {
    const event = await createTrustedEvent()
    // The exception is the Mods folder itself and nothing under it: a link the folder happens to hold
    // is not a Mods folder the config names, so the strict walk decides, and it says no.
    const installation = join(temporaryRoot, "Installations", "plain-install")
    mkdirSync(join(installation, "Mods"), { recursive: true })
    writeFileSync(join(outside, ARCHIVE), "not yours", "utf-8")
    symlinkSync(outside, join(installation, "Mods", "linked"))
    writeConfig(installation)

    assert.deepEqual(await setModEnabled()(event, join(installation, "Mods", "linked", ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(outside), [ARCHIVE])
  })

  it("refuses a path carrying a NUL, before any name is derived from it", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)

    assert.deepEqual(await setModEnabled()(event, `${join(managedMods, ARCHIVE)}\0.png`, false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
  })

  it("refuses a state argument that is not a boolean", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)

    assert.deepEqual(await setModEnabled()(event, join(managedMods, ARCHIVE), "false" as unknown as boolean), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(managedMods), [ARCHIVE])
  })

  it("refuses a missing archive rather than inventing one", async () => {
    const event = await createTrustedEvent()

    assert.deepEqual(await setModEnabled()(event, join(managedMods, ARCHIVE), false), { ok: false, reason: "refused" })
    assert.deepEqual(readdirSync(managedMods), [])
  })

  it.skipIf(process.platform === "win32")("returns a refusal rather than throwing when the host will not rename the file", async () => {
    const event = await createTrustedEvent()
    seedArchive(ARCHIVE)
    chmodSync(managedMods, 0o500)

    try {
      assert.deepEqual(await setModEnabled()(event, join(managedMods, ARCHIVE), false), { ok: false, reason: "refused" })
    } finally {
      chmodSync(managedMods, 0o700)
    }
  })
})
