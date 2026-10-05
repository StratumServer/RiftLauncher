import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
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

/**
 * A ModConfig folder with links in it, and a folder outside the Installation for them to point at.
 *
 * The links are the four places one can sit: at a name a pack carries and pointing at a file, at a
 * name a pack carries and pointing at a folder, as a folder a pack's names sit under, and inside a
 * real folder. What is outside holds bytes the launcher has no business reading, and `real.json` is
 * the one plain config that is there.
 */
function makeLinkedModConfigFolder(): { outside: string } {
  const outside = join(temporaryRoot, "outside")
  mkdirSync(join(outside, "folder"), { recursive: true })
  writeFileSync(join(outside, "theirs.json"), "theirs", "utf-8")
  writeFileSync(join(outside, "folder", "inner.json"), "inner", "utf-8")
  mkdirSync(join(modConfigFolder(), "Client"), { recursive: true })
  writeFileSync(join(modConfigFolder(), "real.json"), "{}", "utf-8")
  symlinkSync(join(outside, "theirs.json"), join(modConfigFolder(), "file-link.json"))
  symlinkSync(join(outside, "folder"), join(modConfigFolder(), "folder-link.json"))
  symlinkSync(join(outside, "folder"), join(modConfigFolder(), "Shared"))
  symlinkSync(join(outside, "theirs.json"), join(modConfigFolder(), "Client", "nested-link.json"))
  return { outside }
}

/** Enables NTFS's per-directory case-sensitive mode or probes case-sensitivity on non-Windows volumes. */
function enableCaseSensitiveDirectory(path: string): boolean {
  if (process.platform === "win32") {
    return spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", path, "enable"], { encoding: "utf-8" }).status === 0
  }
  const probeUpper = join(path, ".probe-case.tmp")
  const probeLower = join(path, ".probe-CASE.tmp")
  try {
    writeFileSync(probeUpper, "a")
    writeFileSync(probeLower, "b")
    const isSensitive = existsSync(probeUpper) && existsSync(probeLower) && readFileSync(probeUpper, "utf8") === "a"
    rmSync(probeUpper, { force: true })
    rmSync(probeLower, { force: true })
    return isSensitive
  } catch {
    return false
  }
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

  it("refuses bidi controls and zero-width characters that disguise a name", async () => {
    const { assertModConfigKey } = await import("@src/ipc/handlers/modConfigs")

    // Right-to-left override and bidi controls:
    assert.throws(() => assertModConfigKey("safe\u202Egnp.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("\u202Eevil.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("folder\u202A/config.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("bidi\u061C.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("isolate\u2066.json"), /Invalid mod config key/)

    // Zero-width space and invisible format characters:
    assert.throws(() => assertModConfigKey("zero\u200Bwidth.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("non\u200Cjoiner.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("joiner\u200D.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("word\u2060joiner.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("bom\uFEFF.json"), /Invalid mod config key/)
    assert.throws(() => assertModConfigKey("mongolian\u180Espace.json"), /Invalid mod config key/)
  })

  it("refuses representative default-ignorable characters in file and folder segments", async () => {
    const { assertModConfigKey } = await import("@src/ipc/handlers/modConfigs")
    const hiddenCharacters = ["\u034F", "\u115F", "\u17B4", "\u180B", "\u180F", "\u2065", "\u3164", "\uFE0F", "\uFFA0", "\uFFF0", "\u{E0000}", "\u{E0080}", "\u{E0100}", "\u{E0FFF}"]

    for (const hidden of hiddenCharacters) {
      assert.throws(() => assertModConfigKey(`Client/config${hidden}.json`), /Invalid mod config key/)
      assert.throws(() => assertModConfigKey(`Client/Sub${hidden}/config.json`), /Invalid mod config key/)
    }
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

  it("refuses a pack carrying bidi controls or zero-width characters in a key and names it", async () => {
    const { parseModpackSettings } = await import("@src/ipc/handlers/modConfigs")

    const bidiRefused = parseModpackSettings({ "safe\u202Egnp.json": entry("{}") })
    assert.equal(bidiRefused.ok, false)
    assert.deepEqual(bidiRefused.ok === false && bidiRefused.refused, { reason: "bad-key", name: "safe\u202Egnp.json" })

    const zeroWidthRefused = parseModpackSettings({ "zero\u200Bwidth.json": entry("{}") })
    assert.equal(zeroWidthRefused.ok, false)
    assert.deepEqual(zeroWidthRefused.ok === false && zeroWidthRefused.refused, { reason: "bad-key", name: "zero\u200Bwidth.json" })
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

  it("refuses bytes that decode to something other than what was read", async () => {
    // `F0 9F 98` is a four byte sequence cut short. A length comparison cannot see it: the decoder
    // answers one U+FFFD, and re-encoding that gives three bytes, so the file passed, the pack
    // carried `EF BF BD`, and the digest was over text that was never in the file.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "cut.json"), Buffer.from([0x7b, 0xf0, 0x9f, 0x98, 0x7d]))

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "not-utf8", name: "cut.json" })
  })

  it("refuses a file holding a NUL, which the importer would drop every config for", async () => {
    // A zero filled file after a crash is the usual way this arrives. The bytes are valid UTF-8, so
    // only the NUL rule catches it, and without that rule the pack exports and then fails to import:
    // the importer's string guard refuses the value and takes the whole settings block with it, so
    // one unreadable file costs the pack every config it carries.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "zeroed.json"), '{"a":"\u0000"}', "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "not-utf8", name: "zeroed.json" })
  })

  it("skips a link rather than carrying what it points at", async () => {
    // The walk reads with `lstat`, so a link is not a file and is left out. Following one would let
    // anything on the disk into somebody else's pack under a name inside the folder.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    const outside = join(temporaryRoot, "outside")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "secret.json"), '{"token":"x"}', "utf-8")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "real.json"), "{}", "utf-8")
    symlinkSync(join(outside, "secret.json"), join(modConfigFolder(), "linked.json"))

    const collected = await collectModConfigs(installationPath)

    assert.equal(collected.ok, true)
    assert.deepEqual(Object.keys(collected.ok ? collected.settings : {}), ["real.json"])
  })

  it("refuses a ModConfig that is a file rather than a folder", async () => {
    // `ensureDir` would fail on it later with an ENOTDIR that names nothing, and a walk that read it
    // as an empty folder would report an installation with no configs to export.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    writeFileSync(modConfigFolder(), "not a folder", "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "unreadable-config" })
  })

  it("refuses a ModConfig folder reached through a linked parent rather than the folder itself", async () => {
    // The root goes through `assertManagedPath` before the walk, and a link anywhere in its existing
    // ancestors is refused there. `lstat` alone cannot see this case: it resolves the components in
    // front of the last one, so a real folder behind a linked parent stats as a directory and the
    // walk reads a folder that is not this Installation's.
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    const outside = join(temporaryRoot, "outside")
    mkdirSync(join(outside, "ModConfig"), { recursive: true })
    writeFileSync(join(outside, "ModConfig", "carried.json"), '{"token":"x"}', "utf-8")
    rmSync(installationPath, { recursive: true, force: true })
    symlinkSync(outside, installationPath)

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "unreadable-config" })
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

  it("shows default-ignorable code points in the export refusal", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "config\u034F.json"), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath)

    assert.deepEqual(collected, { ok: false, reason: "hidden-character", name: "config<U+034F>.json" })
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

  it("carries only the names it was given, so a file it cannot carry stops being the export's problem", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(join(modConfigFolder(), "ConfigureEverything"), { recursive: true })
    writeFileSync(join(modConfigFolder(), "ConfigureEverything", "RoomSize.json"), '{"blocksize":8}', "utf-8")
    writeFileSync(join(modConfigFolder(), "Spacing.json"), '{"gap":2}', "utf-8")
    // Left out below, and the reason the parameter exists: before it, this one file refused the
    // whole export and the only way past it was to go and rename the file on disk.
    writeFileSync(join(modConfigFolder(), "latin1.json"), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe7, 0x22, 0x7d]))

    const narrowed = await collectModConfigs(installationPath, ["ConfigureEverything/RoomSize.json"])
    assert.equal(narrowed.ok, true)
    assert.deepEqual(Object.keys(narrowed.ok ? narrowed.settings : {}), ["ConfigureEverything/RoomSize.json"])

    // And the file is only out of the way because it was left out: asked for by name, it is still
    // refused, which is what keeps this a filter rather than a hole in the check.
    const asked = await collectModConfigs(installationPath, ["latin1.json"])
    assert.deepEqual(asked, { ok: false, reason: "not-utf8", name: "latin1.json" })
  })

  it("carries nothing when it is given nothing, rather than falling back to everything", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath, [])

    // `[]` and `undefined` mean opposite things and only one of them is "all of them".
    assert.equal(collected.ok, true)
    assert.deepEqual(collected.ok ? collected.settings : null, {})
  })

  it("reads every file when it is given no list at all", async () => {
    const { collectModConfigs } = await import("@src/ipc/handlers/modConfigs")
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "{}", "utf-8")

    const collected = await collectModConfigs(installationPath, undefined)

    assert.equal(collected.ok, true)
    assert.deepEqual(Object.keys(collected.ok ? collected.settings : {}), ["a.json"])
  })
})

describe("parseChosenConfigNames", () => {
  it("takes a list of names, and an empty list, as they were sent", async () => {
    const { parseChosenConfigNames } = await import("@src/ipc/handlers/modConfigs")

    assert.deepEqual(parseChosenConfigNames(["a.json", "b/c.json"]), ["a.json", "b/c.json"])
    assert.deepEqual(parseChosenConfigNames([]), [])
  })

  it("returns undefined for an omitted list and for null", async () => {
    const { parseChosenConfigNames } = await import("@src/ipc/handlers/modConfigs")

    assert.equal(parseChosenConfigNames(undefined), undefined)
    assert.equal(parseChosenConfigNames(null), undefined)
  })

  it("refuses anything that is not a list of strings rather than guessing what was meant", async () => {
    const { parseChosenConfigNames } = await import("@src/ipc/handlers/modConfigs")

    for (const bad of ["a.json", 7, { 0: "a.json" }, ["a.json", 7], [null], [undefined]]) {
      assert.throws(() => parseChosenConfigNames(bad), { name: "TypeError" })
    }
  })
})

describe("GET_MOD_CONFIGS", () => {
  it("lists names and sizes, and nothing while the Installation is playing", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "{}", "utf-8")
    const event = await createTrustedEvent()

    const listed = await getModConfigsHandler()(event, installationPath)
    assert.deepEqual(listed, { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] })

    // Imported here and not at the top of the file: beforeEach resets the module registry, and a
    // top-level import would be a second, unrelated copy of the playing set the handler never sees.
    const { markInstallationPlaying } = await import("@src/ipc/installationActivity")
    markInstallationPlaying("inst-1")
    const playing = await getModConfigsHandler()(event, installationPath)
    assert.deepEqual(playing, { ok: false, reason: "playing" })
  })

  it("answers two listings at once, because reading a folder does not exclude reading it", async () => {
    // Manage Mods mounts the action bar and the import dialog together and both ask for this. While
    // the read took the exclusive operation lease the second was told `busy`, so the dialog opened on
    // "the folder could not be read" with no rows and a disabled button, on every page load. A read
    // that excludes a read is the whole of that bug.
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "{}", "utf-8")
    const event = await createTrustedEvent()

    const [first, second] = await Promise.all([getModConfigsHandler()(event, installationPath), getModConfigsHandler()(event, installationPath)])

    assert.deepEqual(first, { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] })
    assert.deepEqual(second, { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] })
  })

  it("names the links in the folder, to a file or to a folder, without reading or following any of them (#621)", async () => {
    // The walk left a link out altogether, so the import dialog was told nothing about the name and
    // called it one this Installation has no file at: it ticked the row, and the apply then refused it.
    // A link is not a config and the listing must not offer it as one, since the export builds its
    // rows from the same list; it is a name the dialog has to be told about, and told only by name.
    const { outside } = makeLinkedModConfigFolder()
    const event = await createTrustedEvent()
    const fse = (await import("fs-extra")).default
    const readFile = vi.spyOn(fse, "readFile")
    const stat = vi.spyOn(fse, "stat")

    try {
      const listed = await getModConfigsHandler()(event, installationPath)

      assert.equal(listed.ok, true)
      if (!listed.ok) return
      assert.deepEqual(listed.configs, [{ name: "real.json", bytes: 2 }])
      // `Shared` is a folder that is a link: it is named, and nothing under it is listed.
      assert.deepEqual([...listed.linked].sort(), ["Client/nested-link.json", "Shared", "file-link.json", "folder-link.json"])
      // Names are all the listing is for. Neither a read nor a `stat` (which follows) may have been
      // asked about a link, or about anything outside the Installation.
      assert.deepEqual(
        readFile.mock.calls.filter(([path]) => String(path).startsWith(outside) || String(path).startsWith(modConfigFolder())),
        []
      )
      assert.deepEqual(
        stat.mock.calls.filter(([path]) => String(path).startsWith(outside) || String(path).startsWith(modConfigFolder())),
        []
      )
    } finally {
      readFile.mockRestore()
      stat.mockRestore()
    }
  })
})

describe("APPLY_MOD_CONFIGS", () => {
  it("replaces a differently-cased config on a case-sensitive filesystem and backs it up", async (context) => {
    mkdirSync(modConfigFolder(), { recursive: true })
    if (!enableCaseSensitiveDirectory(modConfigFolder())) {
      context.skip()
      return
    }
    writeFileSync(join(modConfigFolder(), "Config.json"), "old", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "config.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "config.json", kind: "replace" }])
    assert.deepEqual(applied.failed, [])
    assert.deepEqual(readdirSync(modConfigFolder()), ["Config.json"])
    assert.equal(readFileSync(join(modConfigFolder(), "Config.json"), "utf-8"), "new")
    assert.notEqual(applied.backupFolder, "")
    assert.equal(readFileSync(join(applied.backupFolder, "Config.json"), "utf-8"), "old")
    assert.match(readFileSync(join(applied.backupFolder, "applied.txt"), "utf-8"), /^Config\.json$/m)
  })

  it("resolves case differences in parent folders as well as the config filename", async (context) => {
    mkdirSync(modConfigFolder(), { recursive: true })
    if (!enableCaseSensitiveDirectory(modConfigFolder())) {
      context.skip()
      return
    }
    const clientFolder = join(modConfigFolder(), "Client")
    mkdirSync(clientFolder)
    if (!enableCaseSensitiveDirectory(clientFolder)) {
      context.skip()
      return
    }
    writeFileSync(join(clientFolder, "Config.json"), "old", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "client/config.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "client/config.json", kind: "replace" }])
    assert.deepEqual(readdirSync(clientFolder), ["Config.json"])
    assert.equal(readFileSync(join(clientFolder, "Config.json"), "utf-8"), "new")
    assert.equal(readFileSync(join(applied.backupFolder, "Client", "Config.json"), "utf-8"), "old")
    assert.match(readFileSync(join(applied.backupFolder, "applied.txt"), "utf-8"), /^Client\/Config\.json$/m)
  })

  it("imports configs into an Installation that has no ModConfig folder yet", async () => {
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [
      { name: "Client/a.json", ...entry("alpha") },
      { name: "b.json", ...entry("beta") }
    ])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [
      { name: "Client/a.json", kind: "new" },
      { name: "b.json", kind: "new" }
    ])
    assert.deepEqual(applied.failed, [])
    assert.equal(readFileSync(join(modConfigFolder(), "Client", "a.json"), "utf-8"), "alpha")
    assert.equal(readFileSync(join(modConfigFolder(), "b.json"), "utf-8"), "beta")
    assert.equal(applied.backupFolder, "")
  })

  it("prefers the exact case match when multiple case variants already exist on disk", async (context) => {
    mkdirSync(modConfigFolder(), { recursive: true })
    if (!enableCaseSensitiveDirectory(modConfigFolder())) {
      context.skip()
      return
    }
    writeFileSync(join(modConfigFolder(), "Config.json"), "capital", "utf-8")
    writeFileSync(join(modConfigFolder(), "config.json"), "lower", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "config.json", ...entry("new-lower") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "config.json", kind: "replace" }])
    assert.deepEqual(applied.failed, [])
    assert.equal(readFileSync(join(modConfigFolder(), "Config.json"), "utf-8"), "capital")
    assert.equal(readFileSync(join(modConfigFolder(), "config.json"), "utf-8"), "new-lower")
    assert.equal(readFileSync(join(applied.backupFolder, "config.json"), "utf-8"), "lower")
  })

  it("refuses an ambiguous case-folded match on disk without changing either file", async (context) => {
    mkdirSync(modConfigFolder(), { recursive: true })
    if (!enableCaseSensitiveDirectory(modConfigFolder())) {
      context.skip()
      return
    }
    writeFileSync(join(modConfigFolder(), "Config.json"), "first", "utf-8")
    writeFileSync(join(modConfigFolder(), "CONFIG.json"), "second", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "config.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.failed, [{ name: "config.json", reason: "write-failed" }])
    assert.deepEqual(applied.applied, [])
    assert.equal(applied.backupFolder, "")
    assert.deepEqual(readdirSync(modConfigFolder()).sort(), ["CONFIG.json", "Config.json"])
    assert.equal(readFileSync(join(modConfigFolder(), "Config.json"), "utf-8"), "first")
    assert.equal(readFileSync(join(modConfigFolder(), "CONFIG.json"), "utf-8"), "second")
    assert.deepEqual(recoveryFolders(), [])
  })

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

  it("writes a config the Installation has never had, and makes no recovery folder for it", async () => {
    // The branch that records a file as `new` had no test: every other apply case replaces something,
    // so a name the pack brought and the Installation did not have was only ever exercised by hand.
    // Nothing is displaced here, so there is no recovery folder and no applied.txt either.
    mkdirSync(modConfigFolder(), { recursive: true })
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "fresh.json", ...entry("mine") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "fresh.json", kind: "new" }])
    assert.deepEqual(applied.failed, [])
    assert.deepEqual(applied.skipped, [])
    assert.equal(applied.backupFolder, "")
    assert.equal(readFileSync(join(modConfigFolder(), "fresh.json"), "utf-8"), "mine")
    assert.deepEqual(recoveryFolders(), [])
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

  it("refuses a destination under a linked folder before it reads or creates anything there", async () => {
    // The link is the whole attack: `ModConfig/link` points out of the Installation, so the `lstat`,
    // the `readFile` and the `copy` for `link/secret.json` all ran on a file outside it and put a
    // copy in the recovery folder, and `ensureDir` created `deep/er/` out there. `assertManagedPath`
    // was asked only afterwards, which is why it never stopped any of it.
    const outside = join(temporaryRoot, "outside")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "secret.json"), "theirs", "utf-8")
    mkdirSync(modConfigFolder(), { recursive: true })
    symlinkSync(outside, join(modConfigFolder(), "link"))
    writeFileSync(join(modConfigFolder(), "regular.json"), "old-regular", "utf-8")
    const event = await createTrustedEvent()

    // Mixed pack: regular.json lands and displaces an existing file, so a recovery folder is retained.
    // The link destinations are refused, so no file or bytes from outside may appear in that backup.
    const applied = await applyModConfigsHandler()(event, installationPath, [
      { name: "link/secret.json", ...entry("mine") },
      { name: "link/deep/er/x.json", ...entry("mine") },
      { name: "regular.json", ...entry("new-regular") }
    ])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.failed, [
      { name: "link/secret.json", reason: "write-failed" },
      { name: "link/deep/er/x.json", reason: "write-failed" }
    ])
    assert.deepEqual(applied.applied, [{ name: "regular.json", kind: "replace" }])
    assert.equal(readFileSync(join(outside, "secret.json"), "utf-8"), "theirs")
    assert.equal(existsSync(join(outside, "deep")), false)
    assert.equal(readFileSync(join(modConfigFolder(), "regular.json"), "utf-8"), "new-regular")

    assert.notEqual(applied.backupFolder, "")
    assert.equal(existsSync(applied.backupFolder), true)
    assert.equal(readFileSync(join(applied.backupFolder, "regular.json"), "utf-8"), "old-regular")
    assert.equal(existsSync(join(applied.backupFolder, "link")), false)
    assert.equal(existsSync(join(applied.backupFolder, "secret.json")), false)

    const walkFiles = (dir: string): string[] => {
      const paths: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) paths.push(...walkFiles(full))
        else paths.push(full)
      }
      return paths
    }
    const backupFiles = walkFiles(applied.backupFolder)
    for (const file of backupFiles) {
      assert.ok(!readFileSync(file).includes(Buffer.from("theirs")), `file ${file} must not contain outside bytes`)
    }
  })

  it("refuses a ModConfig that is a file rather than a folder", async () => {
    writeFileSync(modConfigFolder(), "not a folder", "utf-8")
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("{}") }])

    assert.deepEqual(applied, { ok: false, reason: "mod-config-unreadable" })
    assert.equal(readFileSync(modConfigFolder(), "utf-8"), "not a folder")
  })

  it("refuses a destination that is a link rather than a file", async () => {
    // `fse.copy` copies a link rather than what it points at, so a backup taken without this check is
    // a link to the very file being replaced, and writing through the destination edits a file
    // outside the Installation.
    const outside = join(temporaryRoot, "outside")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "theirs.json"), "theirs", "utf-8")
    mkdirSync(modConfigFolder(), { recursive: true })
    symlinkSync(join(outside, "theirs.json"), join(modConfigFolder(), "pointed.json"))
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "pointed.json", ...entry("mine") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.failed, [{ name: "pointed.json", reason: "write-failed" }])
    assert.deepEqual(applied.applied, [])
    assert.equal(applied.backupFolder, "")
    assert.equal(readFileSync(join(outside, "theirs.json"), "utf-8"), "theirs")
    assert.deepEqual(recoveryFolders(), [])
  })

  it("still refuses every name the listing calls a link, at the name or below it, and reads, copies and writes nothing through one (#621)", async () => {
    // The import dialog now leaves these names unticked, but a request can name anything, so the apply
    // is the one that holds the line and this is the test that it still does, for a link to a file, a
    // link to a folder, a name below a folder that is a link and a link inside a real folder. The
    // plain name beside them is there to show the refusal is per name.
    const { outside } = makeLinkedModConfigFolder()
    const event = await createTrustedEvent()
    const fse = (await import("fs-extra")).default
    const readFile = vi.spyOn(fse, "readFile")
    const copy = vi.spyOn(fse, "copy")

    try {
      const applied = await applyModConfigsHandler()(event, installationPath, [
        { name: "file-link.json", ...entry("mine") },
        { name: "folder-link.json", ...entry("mine") },
        { name: "Shared/inner.json", ...entry("mine") },
        { name: "Client/nested-link.json", ...entry("mine") },
        { name: "fresh.json", ...entry("mine") }
      ])

      assert.equal(applied.ok, true)
      if (applied.ok !== true) return
      assert.deepEqual(applied.failed.map((failure) => failure.name).sort(), ["Client/nested-link.json", "Shared/inner.json", "file-link.json", "folder-link.json"])
      assert.ok(
        applied.failed.every((failure) => failure.reason === "write-failed"),
        "a link is refused as a file that could not be written"
      )
      assert.deepEqual(applied.applied, [{ name: "fresh.json", kind: "new" }])
      assert.equal(applied.backupFolder, "")
      assert.deepEqual(recoveryFolders(), [])

      // Nothing was opened for reading or copied, so nothing outside can have reached a backup.
      assert.deepEqual(
        readFile.mock.calls.filter(([path]) => String(path).startsWith(outside) || String(path).startsWith(modConfigFolder())),
        []
      )
      assert.deepEqual(copy.mock.calls, [])

      // And nothing was written: the outside is as it was, the links are still links, and no
      // temporary file was left beside one.
      assert.equal(readFileSync(join(outside, "theirs.json"), "utf-8"), "theirs")
      assert.deepEqual(readdirSync(join(outside, "folder")), ["inner.json"])
      assert.equal(readFileSync(join(outside, "folder", "inner.json"), "utf-8"), "inner")
      for (const link of ["file-link.json", "folder-link.json", "Shared", join("Client", "nested-link.json")]) {
        assert.equal(lstatSync(join(modConfigFolder(), link)).isSymbolicLink(), true, `${link} is no longer a link`)
      }
      assert.deepEqual(readdirSync(join(modConfigFolder(), "Client")), ["nested-link.json"])
      assert.deepEqual(readdirSync(outside).sort(), ["folder", "theirs.json"])
      assert.equal(readFileSync(join(modConfigFolder(), "fresh.json"), "utf-8"), "mine")
    } finally {
      readFile.mockRestore()
      copy.mockRestore()
    }
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

  it("keeps the recovery folder this run just filled, whatever the limit says", async () => {
    // A folder whose mtime is later than now sorts ahead of everything, which a clock that stepped
    // back or an archive restored with its own date is enough to produce. Sorting by mtime alone
    // then pushes this run's own folder past a limit of one and deletes it, so the answer names a
    // path that is not there and the config that was replaced has no copy anywhere.
    writeConfig({ backupsLimit: 1 })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "old", "utf-8")
    const stale = join(backupsFolder, "Settings", "test-inst-1", "settings_20200101-000000")
    mkdirSync(stale, { recursive: true })
    const ahead = new Date(Date.now() + 60_000)
    utimesSync(stale, ahead, ahead)
    const event = await createTrustedEvent()

    const applied = await applyModConfigsHandler()(event, installationPath, [{ name: "a.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.equal(existsSync(applied.backupFolder), true)
    assert.equal(readFileSync(join(applied.backupFolder, "a.json"), "utf-8"), "old")
    assert.deepEqual(recoveryFolders(), [basename(applied.backupFolder)])
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), "new")
  })

  // Zero is not "keep none": the one folder that must survive is the copy of what this run just
  // displaced, so the floor is one and everything older goes. Two older folders rather than one,
  // because a prune that removes only the oldest of them is a prune that still leaks folders.
  it("keeps this run's folder at a limit of zero, and prunes everything older", async () => {
    writeConfig({ backupsLimit: 0 })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "old", "utf-8")
    const parent = join(backupsFolder, "Settings", "test-inst-1")
    const older = join(parent, "settings_20200101-000000")
    const newer = join(parent, "settings_20200601-000000")
    for (const folder of [older, newer]) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, "a.json"), "stale", "utf-8")
    }
    utimesSync(older, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"))
    utimesSync(newer, new Date("2020-06-01T00:00:00Z"), new Date("2020-06-01T00:00:00Z"))

    const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: "a.json", ...entry("new") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(recoveryFolders(), [basename(applied.backupFolder)])
    assert.equal(existsSync(older), false)
    assert.equal(existsSync(newer), false)
    assert.equal(readFileSync(join(applied.backupFolder, "a.json"), "utf-8"), "old")
  })

  // The check runs before anything is read, copied or created, so a disk that cannot hold the
  // backups is a refusal and not a half-applied set of configs with no way back.
  it("refuses before it copies anything when the disk cannot hold the backups", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), '{"n":1}', "utf-8")
    const fse = (await import("fs-extra")).default
    const statfs = vi.spyOn(fse, "statfsSync").mockReturnValue({ bsize: 1, bavail: 0 } as unknown as ReturnType<typeof fse.statfsSync>)

    try {
      const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: "a.json", ...entry('{"n":2}') }])

      assert.deepEqual(applied, { ok: false, reason: "insufficient-space" })
      assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), '{"n":1}')
      assert.deepEqual(recoveryFolders(), [])
    } finally {
      statfs.mockRestore()
    }
  })

  // The backup limit is spent by what a run actually displaced. A run that copied a file and then
  // could not write it left the player where they were, so it must not delete the recovery folder
  // they were relying on, and it must not hand back a folder of copies that are of no use.
  it.skipIf(process.platform === "win32")("spends no backup limit on a run that displaced nothing, and names no folder that is gone", async () => {
    writeConfig({ backupsLimit: 1 })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), "old", "utf-8")
    const older = join(backupsFolder, "Settings", "test-inst-1", "settings_20200101-000000")
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, "a.json"), "stale", "utf-8")
    utimesSync(older, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"))
    // The destination folder is both where the copy is read from and where the write lands, so it is
    // closed to the run: the copy lands in the backups folder, the write cannot.
    chmodSync(modConfigFolder(), 0o500)

    try {
      const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: "a.json", ...entry("new") }])

      assert.equal(applied.ok, true)
      if (applied.ok !== true) return
      assert.deepEqual(applied.applied, [])
      assert.deepEqual(applied.failed, [{ name: "a.json", reason: "write-failed" }])
      assert.equal(applied.backupFolder, "")
      assert.deepEqual(recoveryFolders(), ["settings_20200101-000000"])
      assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), "old")
    } finally {
      chmodSync(modConfigFolder(), 0o700)
    }
  })

  it("does not prune older recovery folders when a partial import displaces no file", async () => {
    writeConfig({ backupsLimit: 1 })
    const parent = join(backupsFolder, "Settings", "test-inst-1")
    const older = join(parent, "settings_20200101-000000")
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, "old.json"), "older-content", "utf-8")
    utimesSync(older, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"))

    mkdirSync(modConfigFolder(), { recursive: true })
    const lockedDir = join(modConfigFolder(), "Locked")
    mkdirSync(lockedDir, { recursive: true })
    const lockedFile = join(lockedDir, "a.json")
    writeFileSync(lockedFile, "theirs", "utf-8")

    // On Windows, the read-only attribute prevents atomic rename/write.
    // On POSIX, directory permissions prevent writing.
    if (process.platform === "win32") {
      chmodSync(lockedFile, 0o444)
    } else {
      chmodSync(lockedDir, 0o555)
    }

    let applied: Awaited<ReturnType<ReturnType<typeof applyModConfigsHandler>>>
    try {
      applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [
        { name: "Locked/a.json", ...entry("new-locked") },
        { name: "fresh.json", ...entry("new-fresh") }
      ])
    } finally {
      if (process.platform === "win32") {
        chmodSync(lockedFile, 0o666)
      } else {
        chmodSync(lockedDir, 0o777)
      }
    }

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.applied, [{ name: "fresh.json", kind: "new" }])
    assert.deepEqual(applied.failed, [{ name: "Locked/a.json", reason: "write-failed" }])
    assert.equal(readFileSync(join(modConfigFolder(), "fresh.json"), "utf-8"), "new-fresh")
    assert.equal(readFileSync(lockedFile, "utf-8"), "theirs")

    // Nothing was displaced, so no recovery folder is offered and the older backup is not pruned.
    assert.equal(applied.backupFolder, "")
    assert.equal(existsSync(older), true)
    assert.equal(readFileSync(join(older, "old.json"), "utf-8"), "older-content")
    assert.deepEqual(recoveryFolders(), ["settings_20200101-000000"])
  })

  // One config in a directory the player can no longer read is a failure of that file, not of the
  // other forty-nine in the pack. Before this, the `readFile` that backs it up rejected the whole
  // invoke, so nothing was written and the player was told nothing at all.
  it.skipIf(process.platform === "win32")("writes the rest of the pack when one config cannot be read to back it up", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "locked.json"), '{"n":1}', "utf-8")
    writeFileSync(join(modConfigFolder(), "open.json"), '{"n":1}', "utf-8")
    chmodSync(join(modConfigFolder(), "locked.json"), 0o000)

    let applied: Awaited<ReturnType<ReturnType<typeof applyModConfigsHandler>>>
    try {
      applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [
        { name: "locked.json", ...entry('{"n":2}') },
        { name: "open.json", ...entry('{"n":2}') }
      ])
    } finally {
      chmodSync(join(modConfigFolder(), "locked.json"), 0o600)
    }

    try {
      assert.equal(applied.ok, true)
      if (applied.ok !== true) return
      assert.deepEqual(applied.applied, [{ name: "open.json", kind: "replace" }])
      assert.deepEqual(applied.failed, [{ name: "locked.json", reason: "write-failed" }])
      assert.equal(readFileSync(join(modConfigFolder(), "open.json"), "utf-8"), '{"n":2}')
      assert.equal(readFileSync(join(modConfigFolder(), "locked.json"), "utf-8"), '{"n":1}')
    } catch (err) {
      assert.fail(err instanceof Error ? err.message : String(err))
    }
  })

  // Windows takes 260 characters for the whole path, and the rule used to count the folder alone, so
  // a long file name under a short folder passed every check and failed on the write. The name here
  // is a folder plus a short file for that reason: the whole path has to be past what Windows takes
  // while the folder holding it is not, or both rules refuse it and the test cannot tell them apart.
  // The name is also spread over two components, because one component of this length is refused by
  // the file system itself, on Linux and Windows alike, which is a different failure carrying the
  // same reason string.
  it("refuses a destination past what Windows can open, counting the whole path", async () => {
    writeConfig()
    mkdirSync(modConfigFolder(), { recursive: true })
    const room = 255 - modConfigFolder().length - 1
    const name = `${"d".repeat(room)}/x.json`
    assert.ok(join(modConfigFolder(), name).length > 260, "the whole path has to be the long part")
    assert.ok(room > 0, "there has to be room for a folder of its own")
    assert.ok(join(modConfigFolder(), dirname(name)).length <= 260, "and the folder under it the short one")

    const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name, ...entry("{}") }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.failed, [{ name, reason: "write-failed" }])
    assert.deepEqual(applied.applied, [])
    assert.equal(existsSync(join(modConfigFolder(), name)), false)
  })

  /**
   * A destination is written through a temp name beside it, and that temp name is what opens first,
   * so a destination that fits while the temp name does not is the same failure one step later. The
   * boundary is therefore the whole path plus the longest temp name, not the path on its own: the
   * last writable destination here is 249 characters, not 260.
   */
  it("charges the temp name beside a destination to the destination, at the exact boundary", async () => {
    writeConfig()
    mkdirSync(modConfigFolder(), { recursive: true })
    const { ATOMIC_WRITE_TEMP_SUFFIX_MAX } = await import("@src/ipc/atomicJsonFile")
    const wfa = (await import("write-file-atomic")) as unknown as { _getTmpname?: (filename: string) => string }
    const _getTmpname = wfa._getTmpname
    assert.equal(typeof _getTmpname, "function", "write-file-atomic must expose _getTmpname for temp name validation")
    let maxSuffix = 0
    for (let i = 0; i < 500; i++) {
      const tmp = _getTmpname!("x")
      const suffixLen = tmp.length - 1
      if (suffixLen > maxSuffix) maxSuffix = suffixLen
    }
    assert.ok(maxSuffix <= ATOMIC_WRITE_TEMP_SUFFIX_MAX, "write-file-atomic suffix must not exceed ATOMIC_WRITE_TEMP_SUFFIX_MAX")
    assert.equal(ATOMIC_WRITE_TEMP_SUFFIX_MAX, 11)
    const longest = 260 - ATOMIC_WRITE_TEMP_SUFFIX_MAX
    const ofLength = (total: number): string => {
      const room = total - modConfigFolder().length - 1 - "/x.json".length
      assert.ok(room > 0, "there has to be room for a folder of its own")
      const name = `${"d".repeat(room)}/x.json`
      assert.equal(join(modConfigFolder(), name).length, total)
      return name
    }
    const writable = ofLength(longest)
    const refused = ofLength(longest + 1)

    const first = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: writable, ...entry('{"n":1}') }])
    const second = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: refused, ...entry('{"n":1}') }])

    assert.equal(first.ok, true)
    if (first.ok !== true || second.ok !== true) return
    assert.deepEqual(first.applied, [{ name: writable, kind: "new" }])
    assert.deepEqual(second.failed, [{ name: refused, reason: "write-failed" }])
    assert.equal(readFileSync(join(modConfigFolder(), writable), "utf-8"), '{"n":1}')
    assert.equal(existsSync(join(modConfigFolder(), refused)), false)
  })

  /**
   * The recovery copy is opened before the destination and under a different root: the backups
   * folder, the Installation's backup folder and the recovery folder itself, which together are
   * usually the longer path. Measuring only the destination let a file land a copy the writer could
   * not have opened, so the failure arrived as `copy-failed` instead of the refusal the pack was
   * promised.
   */
  it("refuses a file whose backup path is past what Windows can open, and leaves its config alone", async () => {
    const customBackups = join(temporaryRoot, "Backups", "B".repeat(200))
    writeConfig({ backupsFolder: customBackups })
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), '{"n":1}', "utf-8")

    const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: "a.json", ...entry('{"n":2}') }])

    assert.equal(applied.ok, true)
    if (applied.ok !== true) return
    assert.deepEqual(applied.failed, [{ name: "a.json", reason: "write-failed" }])
    assert.deepEqual(applied.applied, [])
    assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), '{"n":1}')
    assert.equal(applied.backupFolder, "", "nothing was displaced, so nothing may be offered as a way back")
    const settings = join(customBackups, "Settings")
    const instFolder = join(settings, "test-inst-1")
    assert.ok(!existsSync(instFolder) || readdirSync(instFolder).length === 0, "no recovery folder may be retained for a copy that was refused before it opened")
  })

  /**
   * A copy that threw part way leaves a file in the recovery folder that is not the file the player
   * had, at the same name. That is worse than an empty recovery folder: it looks like a way back and
   * is not one. Another file of the same pack is what keeps the folder alive to be checked, because
   * a run that wrote nothing drops the whole folder at the end and would hide the leftover behind
   * that instead.
   */
  it("removes what a copy left behind when the copy threw, and keeps the copy that did land", async () => {
    writeConfig()
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), '{"n":1}', "utf-8")
    writeFileSync(join(modConfigFolder(), "b.json"), '{"n":1}', "utf-8")
    const fse = (await import("fs-extra")).default
    const copy = vi.spyOn(fse, "copy").mockImplementation(async (from, to) => {
      copyFileSync(String(from), String(to))
      if (String(to).endsWith("a.json")) {
        writeFileSync(String(to), '{"n":1', "utf-8")
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      }
    })

    try {
      const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [
        { name: "a.json", ...entry('{"n":2}') },
        { name: "b.json", ...entry('{"n":2}') }
      ])

      assert.equal(applied.ok, true)
      if (applied.ok !== true) return
      assert.deepEqual(applied.failed, [{ name: "a.json", reason: "copy-failed" }])
      assert.deepEqual(applied.applied, [{ name: "b.json", kind: "replace" }])
      assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), '{"n":1}')
      assert.equal(readFileSync(join(modConfigFolder(), "b.json"), "utf-8"), '{"n":2}')
      assert.notEqual(applied.backupFolder, "", "the file that did land is still a way back")
      assert.deepEqual(
        readdirSync(applied.backupFolder).filter((name: string) => name !== "applied.txt"),
        ["b.json"]
      )
    } finally {
      copy.mockRestore()
    }
  })

  // A copy of the right length and the wrong bytes is the one failure a recovery folder must not
  // hold: it looks like a way back and is not one. The corruption is written to land on the same
  // number of bytes, because a check that only compared sizes would take this as a good copy.
  it("refuses a copy that landed the right number of wrong bytes, and leaves the file it could not back up alone", async () => {
    mkdirSync(modConfigFolder(), { recursive: true })
    writeFileSync(join(modConfigFolder(), "a.json"), '{"n":1}', "utf-8")
    const fse = (await import("fs-extra")).default
    const copy = vi.spyOn(fse, "copy").mockImplementation(async (from, to) => {
      copyFileSync(String(from), String(to))
      writeFileSync(String(to), '{"n":9}', "utf-8")
    })

    try {
      const applied = await applyModConfigsHandler()(await createTrustedEvent(), installationPath, [{ name: "a.json", ...entry('{"n":2}') }])

      assert.equal(applied.ok, true)
      if (applied.ok !== true) return
      assert.deepEqual(applied.failed, [{ name: "a.json", reason: "not-landed" }])
      assert.deepEqual(applied.applied, [])
      assert.equal(readFileSync(join(modConfigFolder(), "a.json"), "utf-8"), '{"n":1}')
    } finally {
      copy.mockRestore()
    }
  })

  it("refuses a request past the entry ceiling, before it looks at any of it", async () => {
    const { MAX_MODPACK_ENTRIES } = await import("@src/ipc/handlers/modConfigs")
    const files = Array.from({ length: MAX_MODPACK_ENTRIES + 1 }, (_, index) => ({ name: `c${index}.json`, ...entry("{}") }))

    await assert.rejects(applyModConfigsHandler()(await createTrustedEvent(), installationPath, files), { name: "TypeError" })
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
