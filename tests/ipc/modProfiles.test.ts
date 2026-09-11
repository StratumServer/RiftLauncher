import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { normalizeModProfilesDocument } from "@domain/mods/profiles"

/**
 * GET_MOD_PROFILES and SAVE_MOD_PROFILES, the profiles file at an Installation's root (#287).
 *
 * Run against the real path policy, following setModEnabled.test.ts: modsHandlers.test.ts mocks
 * `assertManagedPath` into a pass-through, and what these rows prove is that a hostile path or
 * document meets the launcher's own refusals. Only the `electron` module is mocked.
 */

let temporaryRoot: string
let userDataFolder: string
/** The one Installation the config names. */
let installation: string
/** A folder under the installations root that the config does not name as an Installation. */
let unconfigured: string
let outside: string

const FILE_NAME = "riftlauncher-mod-profiles.json"

type GetModProfilesHandler = (event: IpcMainInvokeEvent, installationPath: unknown) => Promise<ModProfilesReadResult>
type SaveModProfilesHandler = (event: IpcMainInvokeEvent, installationPath: unknown, document: unknown) => Promise<ModProfilesSaveResult>

function getModProfiles(): GetModProfilesHandler {
  return getIpcHandler<GetModProfilesHandler>(IPC_CHANNELS.MODS_MANAGER.GET_MOD_PROFILES)
}

function saveModProfiles(): SaveModProfilesHandler {
  return getIpcHandler<SaveModProfilesHandler>(IPC_CHANNELS.MODS_MANAGER.SAVE_MOD_PROFILES)
}

function writeConfig(installationPath: string): void {
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
      installations: [{ id: "install-a", name: "Install A", path: installationPath, version: "1.20.0" }],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )
}

function aDocument(overrides: Partial<ModProfilesDocument> = {}): ModProfilesDocument {
  return {
    format: 1,
    activeProfileId: "server",
    profiles: [
      { id: "server", name: "Server", mods: [{ modid: "alpha", file: "alpha-1.0.0.zip" }] },
      { id: "solo", name: "Solo", mods: [] }
    ],
    ...overrides
  }
}

/** A document whose file, indented as the host writes it, is exactly `bytes` long. Every entry keeps to the rules. */
function aDocumentOfBytes(bytes: number): ModProfilesDocument {
  const size = (document: ModProfilesDocument): number => Buffer.byteLength(JSON.stringify(document, undefined, 2))
  const entry = (tag: string, modidLength: number, fileLength: number): ModProfileEntry => ({ modid: tag.padEnd(modidLength, "m"), file: `${tag.padEnd(fileLength - 4, "f")}.zip` })
  const profiles = Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `Profile ${index}`, mods: [entry(`p${index}-0-`, 200, 200)] }))
  const document: ModProfilesDocument = { format: 1, activeProfileId: null, profiles }

  // Past a profile's first entry, each one adds its two names plus a fixed frame, so the rest is arithmetic.
  const before = size(document)
  profiles[0]!.mods.push(entry("p0-1-", 200, 200))
  const frame = size(document) - before - 400
  let remaining = bytes - size(document)
  for (let index = 0; remaining - frame - 6 >= 400 + frame; index++, remaining -= 400 + frame) profiles[index % profiles.length]!.mods.push(entry(`e${index}-`, 200, 200))
  const modidLength = Math.min(256, remaining - frame - 5)
  profiles[profiles.length - 1]!.mods.push(entry("z", modidLength, remaining - frame - modidLength))
  return document
}

function profilesFile(folder = installation): string {
  return join(folder, FILE_NAME)
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "mod-profiles-"))
  userDataFolder = join(temporaryRoot, "userData")
  installation = join(temporaryRoot, "Installations", "install-a")
  unconfigured = join(temporaryRoot, "Installations", "not-an-installation")
  outside = join(temporaryRoot, "elsewhere")
  for (const folder of [userDataFolder, join(installation, "Mods"), unconfigured, outside]) mkdirSync(folder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  writeConfig(installation)

  vi.resetModules()
  await import("@src/ipc/handlers/modsHandlers")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("GET_MOD_PROFILES and SAVE_MOD_PROFILES", () => {
  it("refuses an untrusted sender on both channels", async () => {
    await assert.rejects(() => getModProfiles()(createUntrustedEvent(), installation), /Unauthorized IPC sender/)
    await assert.rejects(() => saveModProfiles()(createUntrustedEvent(), installation, aDocument()), /Unauthorized IPC sender/)
    assert.deepEqual(readdirSync(installation), ["Mods"])
  })

  it("refuses a folder that is not a configured installation, even inside the managed tree, and writes nothing", async () => {
    const event = await createTrustedEvent()

    // The installations root, a folder under it, and a folder inside the Installation are all managed,
    // and none of them is the Installation.
    for (const folder of [unconfigured, join(temporaryRoot, "Installations"), join(installation, "Mods"), outside]) {
      assert.deepEqual(await getModProfiles()(event, folder), { ok: false, reason: "refused" }, folder)
      assert.deepEqual(await saveModProfiles()(event, folder, aDocument()), { ok: false, reason: "refused" }, folder)
    }
    assert.deepEqual(readdirSync(unconfigured), [])
    assert.deepEqual(readdirSync(join(installation, "Mods")), [])
    assert.deepEqual(readdirSync(outside), [])
  })

  it("refuses an installation path that is not a usable path at all", async () => {
    const event = await createTrustedEvent()

    for (const value of [undefined, 42, "", `${installation}\0`, { path: installation }, "/"]) {
      assert.deepEqual(await getModProfiles()(event, value), { ok: false, reason: "refused" }, String(value))
      assert.deepEqual(await saveModProfiles()(event, value, aDocument()), { ok: false, reason: "refused" }, String(value))
    }
    assert.deepEqual(readdirSync(installation), ["Mods"])
  })

  it("reads a missing file as an empty document", async () => {
    assert.deepEqual(await getModProfiles()(await createTrustedEvent(), installation), { ok: true, document: { format: 1, activeProfileId: null, profiles: [] } })
    assert.deepEqual(readdirSync(installation), ["Mods"])
  })

  it("saves to <installation>/riftlauncher-mod-profiles.json and reads the same document back", async () => {
    const event = await createTrustedEvent()
    writeFileSync(join(installation, "Mods", "alpha-1.0.0.zip"), "zip", "utf-8")

    assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: true })

    // Exactly one new file, at the root, pretty-printed for a player who opens it, and nothing else touched.
    assert.deepEqual(readdirSync(installation).sort(), ["Mods", FILE_NAME])
    assert.deepEqual(readdirSync(join(installation, "Mods")), ["alpha-1.0.0.zip"])
    assert.equal(readFileSync(profilesFile(), "utf-8"), JSON.stringify(aDocument(), undefined, 2))
    assert.deepEqual(await getModProfiles()(event, installation), { ok: true, document: aDocument() })

    // A second save replaces the first.
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument({ activeProfileId: null })), { ok: true })
    assert.deepEqual(await getModProfiles()(event, installation), { ok: true, document: aDocument({ activeProfileId: null }) })
  })

  it("writes the cleaned document, never the hostile parts of one", async () => {
    const event = await createTrustedEvent()
    const profiles = Array.from({ length: 60 }, (_, index) => ({ id: `p${index}`, name: `Profile ${index}`, mods: [] as unknown[] }))
    const hostile = {
      format: 1,
      activeProfileId: "ghost",
      extra: "dropped",
      profiles: [
        { id: "../../escape", name: "Escape", mods: [] },
        { id: "ctl", name: "Bell\u0007", mods: [] },
        {
          id: "keep",
          name: "Keep",
          mods: [
            { modid: "alpha", file: "../../evil.zip" },
            { modid: "beta", file: "beta.zip" },
            { modid: "gamma", file: "C:\\evil.zip" }
          ]
        },
        ...profiles
      ]
    }

    assert.deepEqual(await saveModProfiles()(event, installation, hostile), { ok: true })

    const written = JSON.parse(readFileSync(profilesFile(), "utf-8")) as ModProfilesDocument
    assert.deepEqual(Object.keys(written), ["format", "activeProfileId", "profiles"])
    assert.equal(written.activeProfileId, null)
    assert.equal(written.profiles.length, 50)
    assert.deepEqual(written.profiles[0], { id: "keep", name: "Keep", mods: [{ modid: "beta", file: "beta.zip" }] })
    assert.deepEqual(readdirSync(installation).sort(), ["Mods", FILE_NAME])
  })

  it("refuses a document that is not a format-1 profiles document, and writes nothing", async () => {
    const event = await createTrustedEvent()

    for (const value of [undefined, null, "{}", [], { profiles: [] }, { format: "1", profiles: [] }, { format: 2, activeProfileId: null, profiles: [] }]) {
      assert.deepEqual(await saveModProfiles()(event, installation, value), { ok: false, reason: "invalid" }, JSON.stringify(value))
    }
    assert.deepEqual(readdirSync(installation), ["Mods"])
  })

  it("never writes a file bigger than a read accepts, and writes one at exactly 4 MiB", async () => {
    const event = await createTrustedEvent()
    const over = aDocumentOfBytes(4 * 1024 * 1024 + 1)
    const atCap = aDocumentOfBytes(4 * 1024 * 1024)

    // Within every cap the rules set, and still one byte over what a read takes: written, it would
    // read back as unreadable and could never be replaced.
    assert.deepEqual(normalizeModProfilesDocument(over), { ok: true, document: over })
    assert.deepEqual(await saveModProfiles()(event, installation, over), { ok: false, reason: "invalid" })
    assert.deepEqual(readdirSync(installation), ["Mods"])

    assert.deepEqual(await saveModProfiles()(event, installation, atCap), { ok: true })
    assert.equal(statSync(profilesFile()).size, 4 * 1024 * 1024)
    assert.deepEqual(await getModProfiles()(event, installation), { ok: true, document: atCap })
  })

  it("never overwrites a file from a newer format", async () => {
    const event = await createTrustedEvent()
    const newer = JSON.stringify({ format: 2, activeProfileId: null, profiles: [], tags: ["future"] })
    writeFileSync(profilesFile(), newer, "utf-8")

    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "newer-format" })
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: false, reason: "newer-format" })
    assert.equal(readFileSync(profilesFile(), "utf-8"), newer)
  })

  it("never overwrites a file it cannot read", async () => {
    const event = await createTrustedEvent()

    for (const contents of ["{not json", "null", "[]", JSON.stringify({ format: 0, profiles: [] })]) {
      writeFileSync(profilesFile(), contents, "utf-8")
      assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" }, contents)
      assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: false, reason: "unreadable" }, contents)
      assert.equal(readFileSync(profilesFile(), "utf-8"), contents)
    }
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reads a file it may not look up as unreadable, not as a missing one, and never writes over it", async () => {
    const event = await createTrustedEvent()
    const contents = JSON.stringify(aDocument())
    writeFileSync(profilesFile(), contents, "utf-8")
    // With no search permission on the folder, looking the file up fails with EACCES, not ENOENT.
    chmodSync(installation, 0o600)
    try {
      assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
      assert.deepEqual(await saveModProfiles()(event, installation, aDocument({ activeProfileId: null })), { ok: false, reason: "unreadable" })
    } finally {
      chmodSync(installation, 0o755)
    }
    assert.equal(readFileSync(profilesFile(), "utf-8"), contents)
  })

  it("reads a folder in the file's place as unreadable, and leaves it a folder", async () => {
    const event = await createTrustedEvent()
    mkdirSync(profilesFile())

    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: false, reason: "unreadable" })
    assert.equal(statSync(profilesFile()).isDirectory(), true)
  })

  it.skipIf(process.platform === "win32")("reads a named pipe in the file's place as unreadable, without waiting on it", async () => {
    const event = await createTrustedEvent()
    // Opening a pipe for reading blocks until something writes to it, so a read that did not check
    // for a regular file first would hang the channel for good.
    execFileSync("mkfifo", [profilesFile()])

    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: false, reason: "unreadable" })
    assert.equal(statSync(profilesFile()).isFIFO(), true)
  })

  it("reads a file over 4 MiB as unreadable, and never overwrites it", async () => {
    const event = await createTrustedEvent()
    // Valid JSON, so only the size can be what refuses it.
    const big = JSON.stringify({ format: 1, activeProfileId: null, profiles: [], padding: "x".repeat(4 * 1024 * 1024) })
    writeFileSync(profilesFile(), big, "utf-8")

    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument()), { ok: false, reason: "unreadable" })
    assert.equal(readFileSync(profilesFile(), "utf-8"), big)
  })

  it("reads a file at exactly 4 MiB", async () => {
    const event = await createTrustedEvent()
    const head = JSON.stringify({ format: 1, activeProfileId: null, profiles: [] })
    writeFileSync(profilesFile(), head.padEnd(4 * 1024 * 1024, " "), "utf-8")

    assert.deepEqual(await getModProfiles()(event, installation), { ok: true, document: { format: 1, activeProfileId: null, profiles: [] } })
  })

  it.skipIf(process.platform === "win32")("refuses a profiles file that is a symbolic link, and writes nothing through it", async () => {
    const event = await createTrustedEvent()
    const target = join(outside, "target.json")
    const contents = JSON.stringify(aDocument())
    writeFileSync(target, contents, "utf-8")
    symlinkSync(target, profilesFile())

    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, installation, aDocument({ activeProfileId: null })), { ok: false, reason: "unreadable" })
    assert.equal(readFileSync(target, "utf-8"), contents)
  })

  it.skipIf(process.platform === "win32")("refuses an Installation folder that is itself a symbolic link, and writes nothing through it", async () => {
    const linked = join(temporaryRoot, "Installations", "linked")
    symlinkSync(outside, linked)
    writeConfig(linked)
    vi.resetModules()
    await import("@src/ipc/handlers/modsHandlers")
    const event = await createTrustedEvent()

    assert.deepEqual(await getModProfiles()(event, linked), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, linked, aDocument()), { ok: false, reason: "unreadable" })
    assert.deepEqual(readdirSync(outside), [])
  })

  it("keeps the profile name, the Mods and the path out of every log line", async () => {
    const event = await createTrustedEvent()
    const logMessage = vi.spyOn(await import("@src/utils/logManager"), "logMessage")
    const secret = aDocument({ profiles: [{ id: "server", name: "SECRET-NAME", mods: [{ modid: "SECRET-MOD", file: "SECRET-FILE.zip" }] }] })

    assert.deepEqual(await saveModProfiles()(event, installation, secret), { ok: true })
    assert.deepEqual(await getModProfiles()(event, installation), { ok: true, document: secret })
    // A parse error quotes the text it failed on, so an unreadable file is the other way a name could leak.
    writeFileSync(profilesFile(), '{"SECRET-NAME', "utf-8")
    assert.deepEqual(await getModProfiles()(event, installation), { ok: false, reason: "unreadable" })
    assert.deepEqual(await saveModProfiles()(event, installation, secret), { ok: false, reason: "unreadable" })
    await getModProfiles()(event, unconfigured)

    // Every line but the config loader's own, which names where it found the config and is not these
    // channels'. A line with no tag at all still counts, so nothing can leak by leaving the tag off.
    const lines = logMessage.mock.calls.map((call) => call.join(" ")).filter((line) => !line.includes("[config/configManager.ts]"))
    assert.ok(lines.filter((line) => line.includes("modsHandlers.ts")).length >= 5, "the channels stopped logging, so this proves nothing")
    assert.deepEqual(
      lines.filter((line) => line.includes("SECRET") || line.includes(temporaryRoot)),
      []
    )
    assert.ok(lines.some((line) => line.includes("[SAVE_MOD_PROFILES] Saved 1 profiles.")))
    assert.ok(lines.some((line) => line.includes("[GET_MOD_PROFILES] Refused: unreadable.")))
  })
})
