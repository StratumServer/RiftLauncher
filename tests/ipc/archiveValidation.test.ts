import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import * as tar from "tar"

import { validateArchive } from "../../src/ipc/archiveValidation"

/** Committed zips, built by tests/fixtures/build-fixtures.ts. */
const FIXTURES = join(__dirname, "..", "fixtures")

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

    await assert.doesNotReject(async () => validateArchive(archivePath))
  })

  it("accepts the same archive under the .tgz spelling", async () => {
    const archivePath = await makeTarGz("build.tgz", ["vintagestory"])

    await assert.doesNotReject(async () => validateArchive(archivePath))
  })

  it("refuses a gzipped tar carrying a symbolic link", async () => {
    symlinkSync("/etc/passwd", workspacePath("source", "vintagestory", "escape.txt"))
    const archivePath = await makeTarGz("hostile.tar.gz", ["vintagestory"])

    await assert.rejects(validateArchive(archivePath), /unsafe entry/)
  })

  it("refuses a gzipped tar naming an entry outside its root", async () => {
    const archivePath = workspacePath("escaping.tar.gz")
    await tar.create({ file: archivePath, gzip: true, cwd: workspacePath("source"), portable: true, preservePaths: true }, ["../source/vintagestory/Vintagestory"])

    await assert.rejects(validateArchive(archivePath), /unsafe entry/)
  })

  it("refuses a file that only claims to be a gzipped tar", async () => {
    writeFileSync(workspacePath("liar.tar.gz"), "definitely not gzip")

    await assert.rejects(validateArchive(workspacePath("liar.tar.gz")), /could not be read/)
  })

  it("still reads a zip with the zip reader, which is what an old backup is", async () => {
    await assert.doesNotReject(async () => validateArchive(join(FIXTURES, "legacy-backup.zip")))
  })

  it("refuses a zip whose entries name places outside its root", async () => {
    await assert.rejects(validateArchive(join(FIXTURES, "hostile-backup.zip")), /could not be read/)
  })

  it("refuses a zip that cannot be parsed", async () => {
    writeFileSync(workspacePath("broken.zip"), "PK not really")

    await assert.rejects(validateArchive(workspacePath("broken.zip")), /could not be read/)
  })

  it("refuses anything that is neither a zip nor a gzipped tar", async () => {
    // Two formats reach the launcher and no others, so a third is refused by
    // name rather than handed to a reader that would have to guess at it.
    await assert.rejects(validateArchive(workspacePath("source", "vintagestory", "Vintagestory")), /not supported/)
    await assert.rejects(validateArchive(join(FIXTURES, "not-a-zip.bin")), /not supported/)
  })
})
