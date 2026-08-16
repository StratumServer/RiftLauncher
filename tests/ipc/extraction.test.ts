import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import * as tar from "tar"
import { path7za } from "7zip-bin"

import { contentRoot, runExtraction, validateTree } from "../../src/ipc/workers/extraction"

/**
 * These build their own archives, so they run anywhere without a network.
 *
 * The one test that needs a real Vintage Story archive is opt in: point
 * RIFT_E2E_ARCHIVE at a downloaded game tar.gz to run it. CI never does.
 */

const sevenZipBin = path7za

let workspace: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

/** A folder tree of arbitrary depth: a string is a file body, an object is a folder. */
interface FileTree {
  [name: string]: string | FileTree
}

/** Writes a folder tree, where a string is a file body and an object is a folder. */
function writeTree(root: string, tree: FileTree): void {
  mkdirSync(root, { recursive: true })
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === "string") writeFileSync(join(root, name), value)
    else writeTree(join(root, name), value)
  }
}

async function makeTarGz(archiveName: string, sourceRoot: string): Promise<string> {
  const archivePath = workspacePath(archiveName)
  await tar.create({ file: archivePath, gzip: true, cwd: sourceRoot, portable: true }, readdirSync(sourceRoot))
  return archivePath
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-extraction-test-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("contentRoot", () => {
  it("steps into the single wrapping folder an archive carries", () => {
    writeTree(workspacePath("payload"), { vintagestory: { Vintagestory: "elf" } })

    assert.equal(contentRoot(workspacePath("payload")), workspacePath("payload", "vintagestory"))
  })

  it("leaves an already flat tree alone", () => {
    writeTree(workspacePath("payload"), { VintagestoryServer: "elf", assets: { "version-1.22.6.txt": "" } })

    assert.equal(contentRoot(workspacePath("payload")), workspacePath("payload"))
  })

  it("never flattens past one level", () => {
    writeTree(workspacePath("payload"), { outer: { inner: { Vintagestory: "elf" } } })

    assert.equal(contentRoot(workspacePath("payload")), workspacePath("payload", "outer"))
  })

  it("leaves a lone file where it is, because a file is not a folder to step into", () => {
    writeTree(workspacePath("payload"), { "readme.txt": "hello" })

    assert.equal(contentRoot(workspacePath("payload")), workspacePath("payload"))
  })

  it("leaves an empty extraction alone", () => {
    mkdirSync(workspacePath("payload"), { recursive: true })

    assert.equal(contentRoot(workspacePath("payload")), workspacePath("payload"))
  })
})

describe("validateTree", () => {
  it("counts files and bytes, zero byte files included", () => {
    writeTree(workspacePath("payload"), { assets: { "version-1.22.6.txt": "", "seed.json": "12345" } })

    const stats = validateTree(workspacePath("payload"))

    assert.equal(stats.entries, 4)
    assert.equal(stats.bytes, 5)
  })

  it("refuses a symbolic link", () => {
    writeTree(workspacePath("payload"), { "real.txt": "body" })
    symlinkSync("/etc/passwd", workspacePath("payload", "escape.txt"))

    assert.throws(() => validateTree(workspacePath("payload")), /unsafe filesystem entry/)
  })
})

describe("runExtraction on a gzipped tar", () => {
  it("unpacks a wrapped archive straight into the target folder", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf", assets: { "version-1.22.6.txt": "", "seed.json": "{}" } } })
    const archivePath = await makeTarGz("vs_client_linux-x64_1.22.6.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["Vintagestory", "assets"])
    assert.equal(readFileSync(workspacePath("target", "Vintagestory"), "utf8"), "elf")
    assert.equal(existsSync(workspacePath("target", "vintagestory")), false)
  })

  it("keeps a zero byte marker as a zero byte file", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf", assets: { "version-1.22.6.txt": "" } } })
    const archivePath = await makeTarGz("wrapped.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    const marker = workspacePath("target", "assets", "version-1.22.6.txt")
    assert.equal(existsSync(marker), true)
    assert.equal(statSync(marker).size, 0)
  })

  it("leaves a flat archive flat", async () => {
    writeTree(workspacePath("source"), { VintagestoryServer: "elf", assets: { "version-1.22.6.txt": "" } })
    const archivePath = await makeTarGz("vs_server_linux-x64_1.22.6.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["VintagestoryServer", "assets"])
    assert.equal(existsSync(workspacePath("target", "assets", "version-1.22.6.txt")), true)
  })

  it("reports progress and finishes at 100", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf".repeat(200_000) } })
    const archivePath = await makeTarGz("progress.tar.gz", workspacePath("source"))
    const reported: number[] = []

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin, onProgress: (progress) => reported.push(progress) })

    assert.equal(reported.at(-1), 100)
    assert.equal(
      reported.every((progress) => progress >= 0 && progress <= 100),
      true
    )
  })

  it("deletes the archive when asked, and only then", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    const keptPath = await makeTarGz("kept.tar.gz", workspacePath("source"))
    const consumedPath = await makeTarGz("consumed.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: keptPath, outputPath: workspacePath("kept"), deleteArchive: false, sevenZipBin })
    await runExtraction({ filePath: consumedPath, outputPath: workspacePath("consumed"), deleteArchive: true, sevenZipBin })

    assert.equal(existsSync(keptPath), true)
    assert.equal(existsSync(consumedPath), false)
  })

  it("refuses an archive carrying a symbolic link instead of unpacking it", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    symlinkSync("/etc/passwd", workspacePath("source", "vintagestory", "escape.txt"))
    const archivePath = await makeTarGz("hostile.tar.gz", workspacePath("source"))

    await assert.rejects(runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin }), /unsafe entry/)
    assert.equal(existsSync(workspacePath("target", "escape.txt")), false)
    assert.equal(existsSync(workspacePath("target", "Vintagestory")), false)
  })

  it("writes nothing into the target when the archive cannot be read", async () => {
    writeFileSync(workspacePath("broken.tar.gz"), "not a gzip stream at all")

    await assert.rejects(runExtraction({ filePath: workspacePath("broken.tar.gz"), outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin }), /Extraction failed/)
    assert.deepEqual(readdirSync(workspacePath("target")), [])
  })

  it("leaves no temporary workspace behind", async () => {
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("vs-launcher-extract-")).length
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    const archivePath = await makeTarGz("clean.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    assert.equal(readdirSync(tmpdir()).filter((entry) => entry.startsWith("vs-launcher-extract-")).length, before)
  })
})

describe("runExtraction on a zip", () => {
  it("keeps a zip's own shape, because those are the backups a restore puts back", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf", assets: { "version-1.22.6.txt": "" } } })
    const archivePath = workspacePath("backup.zip")
    execFileSync(sevenZipBin, ["a", "-tzip", archivePath, join(workspacePath("source"), "vintagestory")], { stdio: "ignore" })

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    assert.deepEqual(readdirSync(workspacePath("target")), ["vintagestory"])
    assert.equal(statSync(workspacePath("target", "vintagestory", "assets", "version-1.22.6.txt")).size, 0)
  })
})

/**
 * The real thing. Set RIFT_E2E_ARCHIVE to a downloaded game archive and
 * RIFT_E2E_VERSION to its version to run it:
 *
 * RIFT_E2E_ARCHIVE=/tmp/vs_client_linux-x64_1.22.6.tar.gz RIFT_E2E_VERSION=1.22.6 npm test
 */
const realArchive = process.env.RIFT_E2E_ARCHIVE
describe.skipIf(!realArchive)("runExtraction on a real Vintage Story archive", () => {
  it("puts the game executable and the version marker straight in the target folder", { timeout: 600_000 }, async () => {
    const version = process.env.RIFT_E2E_VERSION ?? ""

    await runExtraction({ filePath: realArchive as string, outputPath: workspacePath("target"), deleteArchive: false, sevenZipBin })

    const landed = readdirSync(workspacePath("target"))
    assert.equal(landed.includes("vintagestory"), false)
    assert.equal(landed.includes("Vintagestory") || landed.includes("VintagestoryServer"), true)
    assert.equal(lstatSync(workspacePath("target", "assets")).isDirectory(), true)
    if (version) assert.equal(statSync(workspacePath("target", "assets", `version-${version}.txt`)).size, 0)
  })
})
