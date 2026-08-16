import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import * as tar from "tar"
import { path7za } from "7zip-bin"

import { validateArchive } from "../../src/ipc/archiveValidation"

const sevenZipBin = path7za

let workspace: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

async function makeTarGz(archiveName: string, entries: string[]): Promise<string> {
  const archivePath = workspacePath(archiveName)
  await tar.create({ file: archivePath, gzip: true, cwd: workspacePath("source"), portable: true }, entries)
  return archivePath
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-archive-validation-"))
  mkdirSync(workspacePath("source", "vintagestory", "assets"), { recursive: true })
  writeFileSync(workspacePath("source", "vintagestory", "Vintagestory"), "elf")
  writeFileSync(workspacePath("source", "vintagestory", "assets", "version-1.22.6.txt"), "")
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("validateArchive", () => {
  it("accepts a gzipped tar, which is what the Linux game builds ship as", async () => {
    const archivePath = await makeTarGz("vs_client_linux-x64_1.22.6.tar.gz", ["vintagestory"])

    await validateArchive(archivePath, sevenZipBin)
  })

  it("accepts the same archive under the .tgz spelling", async () => {
    const archivePath = await makeTarGz("build.tgz", ["vintagestory"])

    await validateArchive(archivePath, sevenZipBin)
  })

  it("refuses a gzipped tar carrying a symbolic link", async () => {
    symlinkSync("/etc/passwd", workspacePath("source", "vintagestory", "escape.txt"))
    const archivePath = await makeTarGz("hostile.tar.gz", ["vintagestory"])

    await assert.rejects(validateArchive(archivePath, sevenZipBin), /unsafe entry/)
  })

  it("refuses a gzipped tar naming an entry outside its root", async () => {
    const archivePath = workspacePath("escaping.tar.gz")
    await tar.create({ file: archivePath, gzip: true, cwd: workspacePath("source"), portable: true, preservePaths: true }, ["../source/vintagestory/Vintagestory"])

    await assert.rejects(validateArchive(archivePath, sevenZipBin), /unsafe entry/)
  })

  it("refuses a file that only claims to be a gzipped tar", async () => {
    writeFileSync(workspacePath("liar.tar.gz"), "definitely not gzip")

    await assert.rejects(validateArchive(workspacePath("liar.tar.gz"), sevenZipBin), /could not be read/)
  })

  it("still reads a zip with the zip reader", async () => {
    const archivePath = workspacePath("backup.zip")
    execFileSync(sevenZipBin, ["a", "-tzip", archivePath, workspacePath("source", "vintagestory")], { stdio: "ignore" })

    await validateArchive(archivePath, sevenZipBin)
  })

  it("refuses a zip that cannot be parsed", async () => {
    writeFileSync(workspacePath("broken.zip"), "PK not really")

    await assert.rejects(validateArchive(workspacePath("broken.zip"), sevenZipBin), /could not be read/)
  })

  it("falls back to 7-Zip for anything else", async () => {
    const archivePath = workspacePath("backup.7z")
    execFileSync(sevenZipBin, ["a", "-t7z", archivePath, workspacePath("source", "vintagestory")], { stdio: "ignore" })

    await validateArchive(archivePath, sevenZipBin)
    await assert.rejects(validateArchive(workspacePath("source", "vintagestory", "Vintagestory"), sevenZipBin), /could not be listed/)
  })
})
