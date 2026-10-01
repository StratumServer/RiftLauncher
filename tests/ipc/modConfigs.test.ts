import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Branch coverage for src/ipc/handlers/modConfigs.ts.
 *
 * The filesystem is real and pathPolicy is not mocked: what these tests are about is a key
 * reaching the disk it was meant to reach and nothing else, so stubbing the boundary that decides
 * that would leave the thing under test unmeasured.
 */

let temporaryRoot: string
let installationPath: string
let backupsFolder: string

type GetModConfigsHandler = (event: IpcMainInvokeEvent, installationPath: unknown) => Promise<ModConfigsReadResult>
type ApplyModConfigsHandler = (event: IpcMainInvokeEvent, installationPath: unknown, files: unknown) => Promise<ApplyModConfigsResult>

function getModConfigsHandler(): GetModConfigsHandler {
  return getIpcHandler<GetModConfigsHandler>(IPC_CHANNELS.MODS_MANAGER.GET_MOD_CONFIGS)
}

function applyModConfigsHandler(): ApplyModConfigsHandler {
  return getIpcHandler<ApplyModConfigsHandler>(IPC_CHANNELS.MODS_MANAGER.APPLY_MOD_CONFIGS)
}

/** A record the way a pack carries one: the digest is over the bytes the text becomes. */
function entry(text: string): ModConfigEntry {
  return { text, sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") }
}

function modConfigFolder(): string {
  return join(installationPath, "ModConfig")
}

function writeConfig(overrides: { backupsFolder?: string; backupsLimit?: number; alsoInstall?: { id: string; name: string; path: string; backupsLimit: number } } = {}): void {
  writeFileSync(
    join(temporaryRoot, "userData", "config.json"),
    JSON.stringify({
      schemaVersion: 3,
      lastUsedInstallation: null,
      defaultInstallationsFolder: join(temporaryRoot, "Installations"),
      defaultVersionsFolder: join(temporaryRoot, "Versions"),
      backupsFolder: "backupsFolder" in overrides ? overrides.backupsFolder : join(temporaryRoot, "Backups"),
      window: { width: 1280, height: 720, x: 0, y: 0, maximized: false },
      accounts: [],
      activeAccountId: null,
      installations: [
        ...(overrides.alsoInstall
          ? [
              {
                id: overrides.alsoInstall.id,
                name: overrides.alsoInstall.name,
                path: overrides.alsoInstall.path,
                version: "1.0.0",
                gameVersionId: null,
                startParams: "",
                backupsLimit: overrides.alsoInstall.backupsLimit,
                backupsAuto: false,
                compressionLevel: 0,
                backups: [],
                lastTimePlayed: 0,
                totalTimePlayed: 0,
                mesaGlThread: false,
                envVars: ""
              }
            ]
          : []),
        {
          id: "inst-1",
          name: "test",
          path: installationPath,
          version: "1.0.0",
          gameVersionId: null,
          startParams: "",
          backupsLimit: "backupsLimit" in overrides ? overrides.backupsLimit : 3,
          backupsAuto: false,
          compressionLevel: 0,
          backups: [],
          lastTimePlayed: 0,
          totalTimePlayed: 0,
          mesaGlThread: false,
          envVars: ""
        }
      ],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )
}

/**
 * The recovery folders an apply made, read straight off disk: one per Installation, named for it, so
 * the list is a read of the second level rather than the first.
 */
function recoveryFolders(): string[] {
  const settings = join(backupsFolder, "Settings")
  if (!existsDirectory(settings)) return []
  const installationFolders = readdirSync(settings)
  return installationFolders.flatMap((name) => readdirSync(join(settings, name)))
}

function existsDirectory(path: string): boolean {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "mod-configs-"))
  installationPath = join(temporaryRoot, "Installations", "test")
  backupsFolder = join(temporaryRoot, "Backups")
  mkdirSync(join(temporaryRoot, "userData"), { recursive: true })
  mkdirSync(installationPath, { recursive: true })
  mkdirSync(backupsFolder, { recursive: true })
  writeConfig()

  setElectronUserDataPath(join(temporaryRoot, "userData"))
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))

  vi.resetModules()
  await import("@src/ipc/handlers/modConfigs")
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("assertModConfigKey", () => {
  it("keeps a nested name and refuses one that would leave the folder", async () => {
    const { assertModConfigKey } = await import("@src/ipc/handlers/modConfigs")

    assert.equal(assertModConfigKey("ConfigureEverything/Client/RoomSize.json"), "ConfigureEverything/Client/RoomSize.json")
    assert.throws(() => assertModConfigKey("../clientsettings.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("Client/RoomSize.txt"), /must name a \.json file/)
    assert.throws(() => assertModConfigKey("a//b.json"), /Invalid mod config key/)
  })

  it("refuses a name Windows could not create, whatever its case", async () => {
    const { assertModConfigKey } = await import("@src/ipc/handlers/modConfigs")

    assert.throws(() => assertModConfigKey("notjson.txt"), /must name a \.json file/)
    assert.throws(() => assertModConfigKey("NUL.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("clock$.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("trailing .json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("what?.json"), /Invalid mod config key/)
    assert.equal(assertModConfigKey("ROOM.JSON"), "ROOM.JSON")
  })
})

describe("parseModpackSettings", () => {
  it("refuses a settings value that is not a block of records instead of throwing", async () => {
    const { parseModpackSettings } = await import("@src/ipc/handlers/modConfigs")

    const missing = parseModpackSettings(undefined)
    assert.equal(missing.ok, true)
    assert.deepEqual(missing.ok && missing.settings, {})

    // The block itself, not a manifest around it: the caller unwraps `settings` before this runs.
    for (const bad of [null, [], 7, "settings"]) {
      const refused = parseModpackSettings(bad)
      assert.equal(refused.ok, false)
      assert.equal(refused.ok === false && refused.refused.reason, "bad-value")
    }
  })

  it("refuses a bad key and names it, and a bad value without dropping the whole pack's mods", async () => {
    const { parseModpackSettings } = await import("@src/ipc/handlers/modConfigs")

    const badKey = parseModpackSettings({ "notjson.txt": entry("{}") })
    assert.equal(badKey.ok, false)
    assert.deepEqual(badKey.ok === false && badKey.refused, { reason: "bad-key", name: "notjson.txt" })

    const badValue = parseModpackSettings({ "a.json": { text: "{}", sha256: "NOTHEX" } })
    assert.equal(badValue.ok, false)
    assert.equal(badValue.ok === false && badValue.refused.reason, "bad-value")

    const good = parseModpackSettings({ "a.json": entry("{}") })
    assert.equal(good.ok, true)
    assert.deepEqual(Object.keys(good.ok && good.settings), ["a.json"])
  })

  it("refuses two keys that are one file on a case-insensitive filesystem", async () => {
    const { parseModpackSettings } = await import("@src/ipc/handlers/modConfigs")

    const refused = parseModpackSettings({ "Config.json": entry("{}"), "config.json": entry("{}") })

    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.refused.reason, "bad-key")
  })

  it("refuses a block larger than the pack's own ceiling", async () => {
    const { parseModpackSettings, MAX_MODPACK_ENTRIES } = await import("@src/ipc/handlers/modConfigs")

    const settings: Record<string, ModConfigEntry> = {}
    for (let index = 0; index <= MAX_MODPACK_ENTRIES; index += 1) settings[`file${index}.json`] = entry("{}")

    const refused = parseModpackSettings(settings)

    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.refused.reason, "too-many")
  })
})

describe("collectModConfigs", () => {
  it("carries every file under the folder with the digest of the bytes it becomes", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(join(modConfigFolder(), "ConfigureEverything", "Client"), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), '{ "a": 1 }', "utf-8")
    writeFileSync(join(modConfigFolder(), "ConfigureEverything", "Client", "RoomSize.json"), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.equal(collected.ok, true)
    const settings = collected.ok ? collected.settings : {}
    assert.deepEqual(Object.keys(settings).sort(), ["ConfigureEverything/Client/RoomSize.json", "a.json"])
    assert.deepEqual(settings["a.json"], entry('{ "a": 1 }'))
  })

  it("refuses, and names, a file that is not UTF-8 rather than shipping a pack it would reject", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    // A latin-1 é: one byte in the file, two out of Buffer.from(text, "utf8").
    writeFileSync(join(modConfigFolder(), "latin1.json"), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe7, 0x22, 0x7d]))

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "not-utf8", name: "latin1.json" })
  })

  it("refuses a file name Windows would not accept, and says which one", async () => {
    // Imported here, not at the top: beforeEach resets the module registry, so a top-level import
    // would be a second copy of this module, holding its own state the handlers never see.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    // Windows keeps this one, because the space is not at the end of the name, and then strips the
    // space on its way out. The pack carries the name as read, so the importer has to refuse it.
    // A name Windows cannot hold, such as `what?.json`, is covered by the rule test below instead:
    // it cannot be created on NTFS, so a walk test of it would only ever pass on Linux.
    writeFileSync(join(modConfigFolder(), "trailing .json"), "{}", "utf-8")
    writeFileSync(join(modConfigFolder(), "RoomSize.json"), "{}", "utf-8")
    // Stated rather than assumed: a host that renamed the file on the way in would have taken the
    // premise of this test away, and the failure would otherwise read as a missing file.
    assert.ok(readdirSync(modConfigFolder()).includes("trailing .json"), "the host did not keep the name this test is about")

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "bad-name", name: "trailing .json" })
  })

  it.skipIf(process.platform === "win32")("refuses two names that differ only in case, and says which one it found second", async () => {
    // Imported here, not at the top: beforeEach resets the module registry, so a top-level import
    // would be a second copy of this module, holding its own state the handlers never see.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(join(modConfigFolder(), "Client"), { recursive: true })
    writeFileSync(join(modConfigFolder(), "Client", "RoomSize.json"), "{}", "utf-8")
    writeFileSync(join(modConfigFolder(), "Client", "roomsize.json"), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.equal(collected.ok, false)
    if (collected.ok) return
    // Whichever the readdir handed over second, the pair is the problem and one of the two is the name.
    assert.equal(collected.reason, "collides")
    assert.match(collected.name ?? "", /^Client\/roomsize\.json$/i)
  })

  it("names the same rules whatever the host file system can hold", async () => {
    // The walk can only be asked about files that exist, and on NTFS that rules out every name the
    // forbidden-character and reserved-device rules exist for. The rule is a pure function of the
    // name, so it is tested here rather than through a file the Windows runner could not create.
    // The matching pack-level test is the one in `parseModpackSettings` above: a pack built on a
    // case-sensitive file system is the only way a Windows player ever meets these names.
    const { assertModConfigKey } = await import("@src/ipc/handlers/modConfigs")

    for (const name of [
      "what?.json",
      "a*b.json",
      "a:b.json",
      "a<b.json",
      "a|b.json",
      'a"b.json',
      "nul.json",
      "NUL.json",
      "Client/nul/room.json",
      "com1.json",
      "COM¹.json",
      "CLOCK$.json",
      "aux.txt.json",
      "trailing .json",
      "trailing..json",
      "ConfigureEverything/Client/RoomSize.json\u0000"
    ]) {
      assert.throws(() => assertModConfigKey(name), /Invalid mod config key/, `accepted ${JSON.stringify(name)}`)
    }

    // The shapes that have to survive, because they are what the game and its mods actually write.
    for (const name of ["RoomSize.json", "ConfigureEverything/Client/RoomSize.json", "ROOM.JSON", "a-b_c.1.json", ".json"]) {
      assert.doesNotThrow(() => assertModConfigKey(name), `refused ${JSON.stringify(name)}`)
    }
  })

  it("refuses a folder past the entry ceiling, and says the folder is too big rather than unreadable", async () => {
    const { MAX_MODPACK_ENTRIES, collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    const folder = modConfigFolder()
    mkdirSync(folder, { recursive: true })
    for (let index = 0; index <= MAX_MODPACK_ENTRIES; index += 1) writeFileSync(join(folder, `c${index}.json`), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "too-many" })
  })
})

describe("GET_MOD_CONFIGS", () => {
  it("lists names and sizes, and nothing while the Installation is playing", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "{}", "utf-8")
    const event = await createTrustedEvent()

    const listed = await getModConfigsHandler()(event, installationPath)
    assert.deepEqual(listed, { ok: true, configs: [{ name: "a.json", bytes: 2 }] })

    // Imported here and not at the top of the file: beforeEach resets the module registry, and a
    // top-level import would be a second, unrelated copy of the playing set the handler never sees.
    const { markInstallationPlaying } = await import("@src/ipc/installationActivity")
    markInstallationPlaying("inst-1")
    const playing = await getModConfigsHandler()(event, installationPath)
    assert.deepEqual(playing, { ok: false, reason: "playing" })
  })
})

describe("APPLY_MOD_CONFIGS", () => {
  it("writes a new file, backs up what it replaced, and records what landed", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "old", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    assert.deepEqual(applied.ok && applied.applied, [{ name: "a.json", kind: "replace" }])
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), "new")

    const [folder] = recoveryFolders()
    assert.ok(folder, "a recovery folder was made")
    // The parent is read rather than spelled out, since it is the prune that is under test here and
    // the naming is a separate test's business.
    const written = join(backupsFolder, "Settings", readdirSync(join(backupsFolder, "Settings"))[0] as string, folder)
    assert.equal(readFileSync(join(written, "a.json"), "utf-8"), "old")
    assert.match(readFileSync(join(written, "applied.txt"), "utf-8"), /a\.json/)
  })

  it("calls a file that is already byte-identical unchanged, and keeps it out of the backup", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "same", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("same") }])

    assert.equal(applied.ok, true)
    assert.deepEqual(applied.ok && applied.skipped, ["a.json"])
    assert.deepEqual(applied.ok && applied.applied, [])
    assert.deepEqual(recoveryFolders(), [])
  })

  it("refuses a digest that does not match the text it was sent with, and writes nothing", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "mine", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", text: "theirs", sha256: entry("mine").sha256 }])

    // Spelled out rather than deep-equal against itself, which is what this used to assert: the
    // point is what the refusal did NOT leave behind, and a value compared with itself proves none of it.
    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [])
    assert.deepEqual(applied.skipped, [])
    assert.deepEqual(applied.failed, [{ name: "a.json", reason: "digest-mismatch" }])
    assert.equal(applied.backupFolder, "")
    assert.deepEqual(recoveryFolders(), [])
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), "mine")
  })

  it("refuses the whole request when one key would leave the folder", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    const event = await createTrustedEvent()

    await assert.rejects(
      () =>
        applyModConfigsHandler()(event, installationPath, [
          { name: "good.json", ...entry("{}") },
          { name: "../clientsettings.json", ...entry("{}") }
        ]),
      /Invalid mod config key/
    )

    assert.deepEqual(readdirSync(modConfigFolder()), [])
  })

  it("refuses with no backups folder rather than writing over something it cannot copy", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "mine", "utf-8")
    writeConfig({ backupsFolder: "" })
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("new") }])

    assert.deepEqual(applied, { ok: false, reason: "no-backups-folder" })
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), "mine")
  })

  it("refuses while the Installation is playing", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    const event = await createTrustedEvent()
    // Imported here and not at the top of the file: beforeEach resets the module registry, and a
    // top-level import would be a second, unrelated copy of the playing set the handler never sees.
    const { markInstallationPlaying } = await import("@src/ipc/installationActivity")
    markInstallationPlaying("inst-1")

    const playing = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("{}") }])

    assert.deepEqual(playing, { ok: false, reason: "playing" })
  })

  it("refuses while another operation already holds the Installation", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    const event = await createTrustedEvent()
    // Taken here and never released, which is the whole shape of a second window writing at once.
    const { tryAcquireInstallationOperation } = await import("@src/ipc/installationActivity")
    const held = tryAcquireInstallationOperation(["inst-1"])
    assert.equal(held.ok, true)

    const busy = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("{}") }])

    assert.deepEqual(busy, { ok: false, reason: "busy" })
  })

  it("does nothing at all for an empty request, folder or not", async () => {
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [])

    assert.deepEqual(applied, { ok: true, backupFolder: "", applied: [], skipped: [], failed: [] })
  })

  it("prunes recovery folders past the Installation's limit, never by name", async () => {
    writeConfig({ backupsLimit: 1 })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "old", "utf-8")
    const event = await createTrustedEvent()

    await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("one") }])
    writeFileSync(join(modConfigFolder(), "a.json"), "one", "utf-8")
    await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("two") }])

    const folders = recoveryFolders()
    assert.equal(folders.length, 1)
    // The survivor is the newer one by mtime, which is the only ordering this prune uses. The parent
    // is read rather than spelled out, because what this test is about is the prune.
    const parent = readdirSync(join(backupsFolder, "Settings"))[0] as string
    const survivor = readFileSync(join(backupsFolder, "Settings", parent, folders[0] as string, "a.json"), "utf-8")
    assert.equal(survivor, "one")
  })

  /**
   * The recovery folder of one apply is the one thing standing between a displaced config and being
   * gone, so what these tests are about is which bytes actually land there.
   */
  it("puts the displaced bytes in the recovery folder, and the file it read is what it wrote", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    // Two files of the same length, so a check that only compares sizes would pass with the wrong one.
    writeFileSync(join(modConfigFolder(), "a.json"), '{"n":1}', "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry('{"n":2}') }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "a.json", kind: "replace" }])
    const parent = readdirSync(join(backupsFolder, "Settings"))[0] as string
    assert.equal(readFileSync(join(applied.backupFolder, "a.json"), "utf-8"), '{"n":1}')
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), '{"n":2}')
    assert.equal(readdirSync(join(backupsFolder, "Settings", parent)).length, 1)
  })

  it("keeps one Installation's recovery folder when another with the same name applies", async () => {
    // The sequence is the loss, and it is why the id is in the folder name. Both Installations are
    // called "test" and both keep one recovery folder. Under a shared parent, the second apply to
    // prune to its own limit of one finds the first Installation's only folder newer than nothing
    // and deletes it, so the first player loses their way back during an apply they never asked for.
    const secondPath = join(temporaryRoot, "Installations", "second")
    mkdirSync(join(secondPath, "ModConfig"), { recursive: true })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeConfig({ backupsLimit: 1, alsoInstall: { id: "inst-2", name: "test", path: secondPath, backupsLimit: 1 } })
    writeFileSync(join(modConfigFolder(), "a.json"), "mine", "utf-8")
    writeFileSync(join(secondPath, "ModConfig", "b.json"), "theirs", "utf-8")
    const event = await createTrustedEvent()

    const first = await applyModConfigsHandler()(event, secondPath, [{ name: "b.json", ...entry("newer") }])
    const second = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("newer") }])

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (first.ok !== true || second.ok !== true) return
    assert.notEqual(first.backupFolder, second.backupFolder)
    assert.equal(readFileSync(join(first.backupFolder, "b.json"), "utf-8"), "theirs")
    assert.equal(readFileSync(join(second.backupFolder, "a.json"), "utf-8"), "mine")
    assert.equal(recoveryFolders().length, 2)
  })

  it("refuses a request carrying two names that differ only in case", async () => {
    // The renderer could forge this even though no pack can carry it, and on Windows the second write
    // would land on the first file, which is the one with no way back.
    const event = await createTrustedEvent()

    await assert.rejects(
      applyModConfigsHandler()(event, installationPath, [
        { name: "Client/RoomSize.json", ...entry("{}") },
        { name: "client/roomsize.json", ...entry("{}") }
      ]),
      /Invalid mod config request/
    )
    assert.deepEqual(existsDirectory(modConfigFolder()) ? readdirSync(modConfigFolder()) : [], [])
  })
})
