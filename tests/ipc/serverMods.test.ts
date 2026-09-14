import assert from "node:assert/strict"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * GET_SERVER_MODS, the Mods the game downloaded to play on a server (#459).
 *
 * Run against the real path policy, following modProfiles.test.ts and setModEnabled.test.ts:
 * modsHandlers.test.ts mocks `assertManagedPath` into a pass-through, and what this channel has to
 * prove is that the renderer can name an Installation and nothing else.
 */

let temporaryRoot: string
let userDataFolder: string
/** The one Installation the config names. */
let installation: string
/** A folder under the installations root the config does not name as an Installation. */
let unconfigured: string

type GetServerModsHandler = (event: IpcMainInvokeEvent, installationPath: unknown) => Promise<ServerModsScan>

function getServerMods(): GetServerModsHandler {
  return getIpcHandler<GetServerModsHandler>(IPC_CHANNELS.MODS_MANAGER.GET_SERVER_MODS)
}

function serverFolder(server: string): string {
  return join(installation, "ModsByServer", server)
}

/** Copies the real modinfo fixture into `<installation>/ModsByServer/<server>/<name>`. */
function seedServerMod(server: string, name: string): void {
  mkdirSync(serverFolder(server), { recursive: true })
  copyFileSync(resolve(__dirname, "../fixtures/valid-mod.zip"), join(serverFolder(server), name))
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "server-mods-"))
  userDataFolder = join(temporaryRoot, "userData")
  installation = join(temporaryRoot, "Installations", "install-a")
  unconfigured = join(temporaryRoot, "Installations", "not-an-installation")
  for (const folder of [userDataFolder, join(installation, "Mods"), unconfigured]) mkdirSync(folder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

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
      installations: [{ id: "install-a", name: "Install A", path: installation, version: "1.20.0" }],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_SERVER_MODS", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => getServerMods()(createUntrustedEvent(), installation), /Unauthorized IPC sender/)
  })

  // The renderer names the Installation and never the folder, so a path the config does not name is
  // a refusal rather than an empty answer.
  it("refuses a folder beside the Installations that is not an Installation", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => getServerMods()(event, unconfigured), /Unconfigured installation path/)
  })

  it("refuses a subfolder of the Installation, not just a stranger", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => getServerMods()(event, join(installation, "ModsByServer")), /Unconfigured installation path/)
  })

  it("refuses anything that is not a string", async () => {
    const event = await createTrustedEvent()
    await assert.rejects(() => getServerMods()(event, 42), /installation path/)
    await assert.rejects(() => getServerMods()(event, { path: installation }), /installation path/)
  })

  it("answers no groups when the Installation has no ModsByServer folder", async () => {
    const event = await createTrustedEvent()

    assert.deepEqual(await getServerMods()(event, installation), { groups: [] })
  })

  it("answers one group per server folder, with the Mods each one holds", async () => {
    seedServerMod("My Test Server", "valid-mod.zip")
    seedServerMod("192.168.1.10", "valid-mod.zip")
    mkdirSync(serverFolder("Empty Server"), { recursive: true })

    const event = await createTrustedEvent()
    const result = await getServerMods()(event, installation)

    assert.deepEqual(
      result.groups.map((group) => group.server),
      ["192.168.1.10", "Empty Server", "My Test Server"]
    )
    assert.equal(result.groups[0]!.path, serverFolder("192.168.1.10"))
    assert.deepEqual(
      result.groups[0]!.mods.map((mod) => ({ modid: mod.modid, version: mod.version, enabled: mod.enabled, path: mod.path })),
      [{ modid: "riftfixture", version: "1.0.0", enabled: true, path: join(serverFolder("192.168.1.10"), "valid-mod.zip") }]
    )
    assert.deepEqual(result.groups[1]!.mods, [])
    assert.equal(result.truncated, undefined)
  })

  it("counts an archive that will not read without naming it", async () => {
    seedServerMod("My Test Server", "valid-mod.zip")
    writeFileSync(join(serverFolder("My Test Server"), "torn.zip"), "not a zip")

    const event = await createTrustedEvent()
    const result = await getServerMods()(event, installation)

    assert.equal(result.groups[0]!.mods.length, 1)
    assert.equal(result.groups[0]!.unreadable, 1)
  })

  // The Mods folder's own scan never sees this folder, and this one never sees the Mods folder: the
  // Installation's Mod count is its own Mods, which is the confusion the feature answers.
  it("never reads the Installation's own Mods folder", async () => {
    copyFileSync(resolve(__dirname, "../fixtures/valid-mod.zip"), join(installation, "Mods", "valid-mod.zip"))

    const event = await createTrustedEvent()

    assert.deepEqual(await getServerMods()(event, installation), { groups: [] })
  })

  // Listing is a read, and a data folder the player linked in is a setup the launcher already
  // supports (#237). Without the read grade this answers nothing on a linked folder that is right
  // there, which reads to the player as "the launcher cannot see my server Mods".
  it.skipIf(process.platform === "win32")("reads a ModsByServer folder the player linked in", async () => {
    const real = join(temporaryRoot, "data", "ModsByServer", "My Test Server")
    mkdirSync(real, { recursive: true })
    copyFileSync(resolve(__dirname, "../fixtures/valid-mod.zip"), join(real, "valid-mod.zip"))
    symlinkSync(join(temporaryRoot, "data", "ModsByServer"), join(installation, "ModsByServer"), "dir")

    const event = await createTrustedEvent()
    const result = await getServerMods()(event, installation)

    assert.deepEqual(
      result.groups.map((group) => group.server),
      ["My Test Server"]
    )
    assert.equal(result.groups[0]!.mods.length, 1)
  })

  // The wiki's own fix for a stale server cache is "delete that server's folder", so the folder the
  // launcher cannot open is exactly the one the player came looking for. Dropping it would leave
  // them the other servers and no way to reach this one.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps a server folder it cannot open, while dropping a plain file beside it", async () => {
    seedServerMod("Good Server", "valid-mod.zip")
    writeFileSync(join(installation, "ModsByServer", "notes.txt"), "not a server")
    mkdirSync(serverFolder("Locked Server"), { recursive: true })
    chmodSync(serverFolder("Locked Server"), 0o000)

    const event = await createTrustedEvent()
    try {
      const result = await getServerMods()(event, installation)

      assert.deepEqual(
        result.groups.map((group) => group.server),
        ["Good Server", "Locked Server"]
      )
      assert.equal(result.groups[1]!.unlistable, true)
      assert.deepEqual(result.groups[1]!.mods, [])
    } finally {
      chmodSync(serverFolder("Locked Server"), 0o755)
    }
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says the folder could not be read rather than answering an empty list", async () => {
    mkdirSync(join(installation, "ModsByServer"), { recursive: true })
    chmodSync(join(installation, "ModsByServer"), 0o000)
    const event = await createTrustedEvent()
    try {
      assert.deepEqual(await getServerMods()(event, installation), { groups: [], unreadable: true })
    } finally {
      chmodSync(join(installation, "ModsByServer"), 0o755)
    }
  })
})
