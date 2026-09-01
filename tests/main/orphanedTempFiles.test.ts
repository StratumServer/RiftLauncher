import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { ATOMIC_JSON_TEMP_FILE_PATTERN, DOWNLOAD_PART_FILE_PATTERN, getOrphanedTempFileSweepTargets, sweepOrphanedTempFiles } from "@src/main/orphanedTempFiles"

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

  it("matches only the download worker's pid and timestamp shape", () => {
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.123.456.part"), true)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.part"), false)
    assert.equal(DOWNLOAD_PART_FILE_PATTERN.test("game.tar.gz.123.part"), false)
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
    const partTemp = join(downloads, "game.tar.gz.123.456.part")
    writeOldFile(atomicTemp)
    writeOldFile(catalogTemp)
    writeOldFile(partTemp)

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

    const recent = join(root, "game.tar.gz.123.456.part")
    const unrelated = join(root, "notes.txt")
    const liveTarget = join(root, "config.json")
    const linkedTemp = join(root, "linked.tar.gz.123.456.part")
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
    const outsideTemp = join(outside, "game.tar.gz.123.456.part")
    writeOldFile(outsideTemp)
    symlinkSync(outside, join(root, "linked-folder"), "junction")

    const removed = await sweepOrphanedTempFiles([{ path: root, kinds: ["download-part"], recursive: true }], { nowMs: Date.now(), maxAgeMs: 1_000, log: () => undefined })

    assert.equal(removed, 0)
    assert.equal(readFileSync(outsideTemp, "utf8"), "temporary")
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
    assert.deepEqual(targets[2]?.kinds, ["atomic-json", "download-part"])
    assert.equal(targets[2]?.recursive, true)
  })
})
