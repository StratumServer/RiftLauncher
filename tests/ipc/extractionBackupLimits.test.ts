import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as tar from "tar"
import fse from "fs-extra"

/**
 * The restore half of issue #362: an archive over 2 GiB has to come back out,
 * or raising the compress ceiling only moves the failure to the day someone
 * needs their backup.
 *
 * Which pair of ceilings an extraction runs under is decided in the main
 * process, from where the archive sits (EXTRACT_ON_PATH in
 * handlers/pathsHandlers.ts, covered in pathsHandlers.test.ts). This file
 * covers what the worker does with that decision once it has it.
 *
 * Sizes are stubbed rather than written: the ceilings read `stats.size`, so
 * that is the only part of a multi-gigabyte tree these need, and a sparse file
 * would only work on the Linux half of the CI matrix.
 *
 * archiveValidation is wrapped rather than replaced, so the real table-of-
 * contents reader still runs and the limits it was handed can be read off the
 * call.
 */
vi.mock("@src/ipc/archiveValidation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/ipc/archiveValidation")>()
  return { ...actual, validateArchive: vi.fn(actual.validateArchive) }
})

const GIB = 1024 * 1024 * 1024
const STRICT_LIMITS = { entryBytes: 512 * 1024 * 1024, totalBytes: 2 * GIB }
const BACKUP_LIMITS = { entryBytes: 16 * GIB, totalBytes: 64 * GIB }

let workspace: string

/**
 * Makes every file named `fileName` stat at `sizeBytes`, wherever it turns up.
 *
 * The extraction stages into a generated folder name, so the file cannot be
 * matched by full path; its base name is enough here, and every other path
 * keeps the real answer.
 */
function statFilesNamedAs(fileName: string, sizeBytes: number): void {
  const realLstatSync = fse.lstatSync.bind(fse)
  vi.spyOn(fse, "lstatSync").mockImplementation(((pathValue: Parameters<typeof fse.lstatSync>[0], options: Parameters<typeof fse.lstatSync>[1]) => {
    const stats = realLstatSync(pathValue, options as never)
    if (typeof pathValue === "string" && pathValue.endsWith(fileName) && stats?.isFile()) stats.size = sizeBytes
    return stats
  }) as typeof fse.lstatSync)
}

/** A one-file tar.gz standing in for a backup of an installation. */
async function makeArchive(name: string): Promise<string> {
  const contents = join(workspace, `${name}-contents`)
  mkdirSync(contents, { recursive: true })
  writeFileSync(join(contents, "world.vcdbs"), "a world")
  const archivePath = join(workspace, `${name}.tar.gz`)
  await tar.create({ file: archivePath, gzip: true, cwd: contents, portable: true }, ["world.vcdbs"])
  return archivePath
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-backup-limits-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  rmSync(workspace, { recursive: true, force: true })
})

describe("runExtraction under the backup ceilings", () => {
  it("unpacks a backup whose tree is past the 2 GiB archive ceiling", async () => {
    const { runExtraction } = await import("@src/ipc/workers/extraction")
    const archivePath = await makeArchive("backup")
    const outputPath = join(workspace, "installation")
    statFilesNamedAs("world.vcdbs", 4 * GIB)

    await runExtraction({ filePath: archivePath, outputPath, deleteArchive: false, isBackupArchive: true })

    assert.equal(fse.existsSync(join(outputPath, "world.vcdbs")), true)
  })

  it("refuses the same tree when the archive is not a backup, so the strict ceiling did not leak", async () => {
    const { runExtraction } = await import("@src/ipc/workers/extraction")
    const archivePath = await makeArchive("mod")
    const outputPath = join(workspace, "mods")
    statFilesNamedAs("world.vcdbs", 4 * GIB)

    await assert.rejects(runExtraction({ filePath: archivePath, outputPath, deleteArchive: false }), /Archive is too large/)
    assert.equal(fse.existsSync(join(outputPath, "world.vcdbs")), false)
  })

  it("still refuses a backup past the backup ceiling, so 64 GiB is a bound and not none", async () => {
    const { runExtraction } = await import("@src/ipc/workers/extraction")
    const archivePath = await makeArchive("enormous")
    const outputPath = join(workspace, "installation")
    statFilesNamedAs("world.vcdbs", 65 * GIB)

    await assert.rejects(runExtraction({ filePath: archivePath, outputPath, deleteArchive: false, isBackupArchive: true }), /Archive is too large/)
  })

  it("hands the same pair to the table-of-contents gate that the extracted tree is held to", async () => {
    const { runExtraction } = await import("@src/ipc/workers/extraction")
    const { validateArchive } = await import("@src/ipc/archiveValidation")
    const archivePath = await makeArchive("both-gates")

    await runExtraction({ filePath: archivePath, outputPath: join(workspace, "strict"), deleteArchive: false })
    expect(validateArchive).toHaveBeenLastCalledWith(archivePath, STRICT_LIMITS)

    await runExtraction({ filePath: archivePath, outputPath: join(workspace, "loose"), deleteArchive: false, isBackupArchive: true })
    expect(validateArchive).toHaveBeenLastCalledWith(archivePath, BACKUP_LIMITS)
  })
})

describe("validateArchive under an explicit pair", () => {
  it("refuses a tar.gz whose entries bust the pair it was handed", async () => {
    const { validateTarGzArchive } = await import("@src/ipc/archiveValidation")
    const archivePath = await makeArchive("tiny-limits")

    await assert.rejects(validateTarGzArchive(archivePath, { entryBytes: 1, totalBytes: 1 }), /unsafe entry/)
    await validateTarGzArchive(archivePath, BACKUP_LIMITS)
  })

  it("refuses a zip whose entries bust the pair it was handed", async () => {
    const { validateZipArchive } = await import("@src/ipc/archiveValidation")
    const archivePath = join(__dirname, "..", "fixtures", "valid-mod.zip")

    await assert.rejects(validateZipArchive(archivePath, { entryBytes: 1, totalBytes: 1 }), /unsafe entry/)
    await validateZipArchive(archivePath, BACKUP_LIMITS)
  })
})
