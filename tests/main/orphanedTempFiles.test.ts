import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { DOWNLOAD_TEMP_FILE_NAMESPACE } from "@src/ipc/workers/download"
import { ATOMIC_JSON_TEMP_FILE_PATTERN, DOWNLOAD_PART_FILE_PATTERN, EXTRACTION_STAGING_PATTERN, getOrphanedTempFileSweepTargets, sweepOrphanedTempFiles } from "@src/main/orphanedTempFiles"

let workspace: string

function pathInWorkspace(...parts: string[]): string {
  return join(workspace, ...parts)
}

function writeOldFile(path: string, contents = "temporary"): void {
  writeFileSync(path, contents)
  const oldDate = new Date(Date.now() - 10_000)
  utimesSync(path, oldDate, oldDate)
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-orphaned-temp-test-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("temporary file patterns", () => {
  it("matches only the atomic JSON targets the launcher writes", () => {
    assert.equal(ATOMIC_JSON_TEMP_FILE_PATTERN.test("config.json.123"), true)
    assert.equal(ATOMIC_JSON_TEMP_FILE_PATTERN.test("account-secrets.unreadable.v2.bak.json.456"), true)
    assert.equal(ATOMIC_JSON_TEMP_FILE_PATTERN.test(`${"a".repeat(64)}.json.789`), true)
    assert.equal(ATOMIC_JSON_TEMP_FILE_PATTERN.test("player.json.123"), false)
    assert.equal(ATOMIC_JSON_TEMP_FILE_PATTERN.test("config.json"), false)
  })

  it("matches only the namespaced download worker's pid and timestamp shape", () => {
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test(`game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`), true)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.123.456.part"), false)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.part"), false)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.123.part"), false)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test(`legacy\n game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`), false)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test(`game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part.bak`), false)
  })

  it("matches extraction staging folder names", () => {
    assert.equal(EXTRACTION_STAGING_PATTERN.test(".riftlauncher-extract-Ab12Cd"), true)
    assert.equal(EXTRACTION_STAGING_PATTERN.test("riftlauncher-extract-Ab12Cd"), false)
    assert.equal(EXTRACTION_STAGING_PATTERN.test(".riftlauncher-extract-"), true)
  })
})

describe("sweepOrphanedTempFiles", () => {
  it("removes old files from the user-data, catalog, and download areas", async () => {
    const userData = pathInWorkspace("user-data")
    const catalog = pathInWorkspace("catalog")
    const downloads = pathInWorkspace("downloads", "1.22.6", "Mods")
    mkdirSync(userData, { recursive: true })
    mkdirSync(catalog, { recursive: true })
    mkdirSync(downloads, { recursive: true })

    const atomicTemp = join(userData, "config.json.123")
    const catalogTemp = join(catalog, `${"b".repeat(64)}.json.456`)
    const partTemp = join(downloads, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`)
    const genericPart = join(downloads, "old-tool.123.456.part")
    writeOldFile(atomicTemp)
    writeOldFile(catalogTemp)
    writeOldFile(partTemp)
    writeOldFile(genericPart)

    const logs: { level: ErrorTypes; message: string }[] = []
    const removed = await sweepOrphanedTempFiles(
      [
        { path: userData, kinds: ["atomic-json"] },
        { path: catalog, kinds: ["atomic-json"] },
        { path: pathInWorkspace("downloads"), kinds: ["download-part"], recursive: true }
      ],
      { nowMs: Date.now(), maxAgeMs: 1_000, log: (level, message) => logs.push({ level, message }) }
    )

    assert.equal(removed, 3)
    assert.equal(lstatSync(atomicTemp, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(catalogTemp, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(partTemp, { throwIfNoEntry: false }), undefined)
    assert.notEqual(lstatSync(genericPart, { throwIfNoEntry: false }), undefined)
    assert.equal(logs.length, 3)
    assert.equal(
      logs.every(({ level }) => level === "debug"),
      true
    )
    assert.equal(
      logs.every(({ message }) => message.includes("Removed orphaned temporary file")),
      true
    )
  })

  it("keeps recent, unrelated, live, and symlinked files", async () => {
    const root = pathInWorkspace("downloads")
    const elsewhere = pathInWorkspace("elsewhere.txt")
    mkdirSync(root, { recursive: true })
    writeFileSync(elsewhere, "keep me")

    const recent = join(root, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`)
    const unrelated = join(root, "notes.txt")
    const liveTarget = join(root, "config.json")
    const linkedTemp = join(root, `linked.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`)
    writeFileSync(recent, "recent")
    writeFileSync(unrelated, "unrelated")
    writeFileSync(liveTarget, "live config")
    symlinkSync(elsewhere, linkedTemp)

    const removed = await sweepOrphanedTempFiles([{ path: root, kinds: ["atomic-json", "download-part"], recursive: true }], { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 0)
    assert.equal(readFileSync(recent, "utf8"), "recent")
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated")
    assert.equal(readFileSync(liveTarget, "utf8"), "live config")
    assert.equal(readFileSync(linkedTemp, "utf8"), "keep me")
  })

  it("does not follow symlinked directories while walking download roots", async () => {
    const root = pathInWorkspace("downloads")
    const outside = pathInWorkspace("outside")
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const outsideTemp = join(outside, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.123.456.part`)
    writeOldFile(outsideTemp)
    symlinkSync(outside, join(root, "linked-folder"), "junction")

    const removed = await sweepOrphanedTempFiles([{ path: root, kinds: ["download-part"], recursive: true }], { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 0)
    assert.equal(readFileSync(outsideTemp, "utf8"), "temporary")
  })

  it("removes old extraction staging folders", async () => {
    const parent = pathInWorkspace("versions")
    mkdirSync(parent, { recursive: true })
    const stagingFolder = join(parent, ".riftlauncher-extract-Ab12Cd")
    const payload = join(stagingFolder, "payload", "Vintagestory")
    mkdirSync(payload, { recursive: true })
    writeFileSync(join(payload, "elf"), "binary")
    // Age the folder past the sweep threshold.
    const oldDate = new Date(Date.now() - 10_000)
    utimesSync(stagingFolder, oldDate, oldDate)
    utimesSync(join(stagingFolder, "payload"), oldDate, oldDate)
    utimesSync(join(stagingFolder, "payload", "Vintagestory"), oldDate, oldDate)
    utimesSync(join(payload, "elf"), oldDate, oldDate)

    const removed = await sweepOrphanedTempFiles([{ path: parent, kinds: ["extraction-staging"] }], { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 1)
    assert.equal(lstatSync(stagingFolder, { throwIfNoEntry: false }), undefined)
  })

  it("keeps recent extraction staging folders", async () => {
    const parent = pathInWorkspace("versions")
    mkdirSync(parent, { recursive: true })
    const stagingFolder = join(parent, ".riftlauncher-extract-Ab12Cd")
    mkdirSync(stagingFolder, { recursive: true })

    const removed = await sweepOrphanedTempFiles([{ path: parent, kinds: ["extraction-staging"] }], { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 0)
    assert.notEqual(lstatSync(stagingFolder, { throwIfNoEntry: false }), undefined)
  })

  it("ignores missing directories", async () => {
    assert.equal(await sweepOrphanedTempFiles([{ path: pathInWorkspace("missing"), kinds: ["atomic-json"] }]), 0)
  })
})

describe("getOrphanedTempFileSweepTargets", () => {
  it("covers the user-data root, catalog cache, and known download roots", () => {
    const config = {
      defaultInstallationsFolder: pathInWorkspace("installations"),
      defaultVersionsFolder: pathInWorkspace("versions"),
      installations: [{ path: pathInWorkspace("custom-installation") }],
      gameVersions: [{ path: pathInWorkspace("custom-version") }]
    } as ConfigType

    const targets = getOrphanedTempFileSweepTargets(pathInWorkspace("user-data"), config)

    assert.deepEqual(
      targets.map((target) => target.path),
      [
        pathInWorkspace("user-data"),
        pathInWorkspace("user-data", "Cache", "ModCatalog"),
        pathInWorkspace("installations"),
        pathInWorkspace("versions"),
        pathInWorkspace("custom-installation"),
        pathInWorkspace("custom-version")
      ]
    )
    assert.deepEqual(targets[0]?.kinds, ["atomic-json"])
    assert.deepEqual(targets[2]?.kinds, ["atomic-json", "download-part", "extraction-staging"])
    assert.equal(targets[2]?.recursive, true)
    // A custom version path is pinned too, not only a default folder.
    assert.deepEqual(targets[5]?.kinds, ["atomic-json", "download-part", "extraction-staging"])
    assert.equal(targets[5]?.recursive, true)
    // The staging kind rides on the recursive download-root targets, which is
    // what reaches a staging folder inside a version or installation folder.
  })

  it("removes a staging folder left inside a version folder under the default versions root", async () => {
    const config = {
      defaultInstallationsFolder: pathInWorkspace("installations"),
      defaultVersionsFolder: pathInWorkspace("versions"),
      installations: [],
      gameVersions: []
    } as unknown as ConfigType

    const staging = pathInWorkspace("versions", "1.22.6", ".riftlauncher-extract-Ab12Cd")
    mkdirSync(join(staging, "payload", "Vintagestory"), { recursive: true })
    writeFileSync(join(staging, "payload", "Vintagestory", "elf"), "binary")
    const oldDate = new Date(Date.now() - 10_000)
    utimesSync(staging, oldDate, oldDate)

    const removed = await sweepOrphanedTempFiles(getOrphanedTempFileSweepTargets(pathInWorkspace("user-data"), config), { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 1)
    assert.equal(lstatSync(staging, { throwIfNoEntry: false }), undefined)
    assert.notEqual(lstatSync(pathInWorkspace("versions", "1.22.6"), { throwIfNoEntry: false }), undefined)
  })

  it("removes a staging folder left in a version folder outside the default roots", async () => {
    const config = {
      defaultInstallationsFolder: pathInWorkspace("installations"),
      defaultVersionsFolder: pathInWorkspace("versions"),
      installations: [],
      gameVersions: [{ path: pathInWorkspace("custom-version") }]
    } as unknown as ConfigType

    const staging = pathInWorkspace("custom-version", ".riftlauncher-extract-ZzZzZz")
    mkdirSync(join(staging, "payload"), { recursive: true })
    const oldDate = new Date(Date.now() - 10_000)
    utimesSync(staging, oldDate, oldDate)

    const removed = await sweepOrphanedTempFiles(getOrphanedTempFileSweepTargets(pathInWorkspace("user-data"), config), { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 1)
    assert.equal(lstatSync(staging, { throwIfNoEntry: false }), undefined)
  })

  it("removes a staging folder without walking into it first", async () => {
    const root = pathInWorkspace("versions")
    const staging = join(root, ".riftlauncher-extract-Cd34Ef")
    mkdirSync(staging, { recursive: true })
    writeOldFile(join(staging, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.1.2.part`))
    const oldDate = new Date(Date.now() - 10_000)
    utimesSync(staging, oldDate, oldDate)

    const removed = await sweepOrphanedTempFiles([{ path: root, kinds: ["atomic-json", "download-part", "extraction-staging"], recursive: true }], {
      nowMs: Date.now(),
      maxAgeMs: 1_000,
      log: () => undefined
    })

    // Under the old order the recursion claimed the folder and the count was
    // still 1 from the inner .part file, but the folder survived. The existence
    // check is what pins the reorder.
    assert.equal(removed, 1)
    assert.equal(lstatSync(staging, { throwIfNoEntry: false }), undefined)
  })

  it("leaves a staging folder that is still in flight untouched, files inside it included", async () => {
    const root = pathInWorkspace("versions")
    const staging = join(root, ".riftlauncher-extract-Ef56Gh")
    mkdirSync(staging, { recursive: true })
    writeOldFile(join(staging, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.1.2.part`))

    const removed = await sweepOrphanedTempFiles([{ path: root, kinds: ["atomic-json", "download-part", "extraction-staging"], recursive: true }], {
      nowMs: Date.now(),
      maxAgeMs: 1_000,
      log: () => undefined
    })

    assert.equal(removed, 0)
    assert.notEqual(lstatSync(staging, { throwIfNoEntry: false }), undefined)
    assert.notEqual(lstatSync(join(staging, `game.tar.gz.${DOWNLOAD_TEMP_FILE_NAMESPACE}.1.2.part`), { throwIfNoEntry: false }), undefined)
  })
})
