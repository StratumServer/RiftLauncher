import assert from "node:assert/strict"
import type { StatsFsBase } from "node:fs"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import * as tar from "tar"

import fse from "fs-extra"

import { assertRoomForArchive, assertSafeCompressionTree, runCompression } from "@src/ipc/workers/compression"
import { MAX_ARCHIVE_TOTAL_BYTES, MAX_BACKUP_TOTAL_BYTES } from "@src/ipc/validation"

/**
 * The backup compression, against real archives.
 *
 * Two separate things are pinned here: the safety walk over the source tree,
 * which runs before tar is handed anything, and what the archive turns out to
 * hold once it is written.
 *
 * The walk is the half worth being fussy about. A symbolic link inside a backup
 * source would otherwise pull files from outside the folder into the archive.
 */

let workspace: string
let source: string
let output: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

/** Every entry name a written archive holds, sorted. */
async function archiveEntryNames(archivePath: string): Promise<string[]> {
  const names: string[] = []
  await tar.list({ file: archivePath, onReadEntry: (entry) => void names.push(entry.path) })
  return names.sort()
}

const FAKE_ROOT = "/fake/root"

type FakeStats = { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; size: number }
type TreeFileSystem = Parameters<typeof assertSafeCompressionTree>[1]

/** A filesystem that answers from the two functions given, for trees too large or too odd to build. */
function fakeTree(lstat: (path: string) => FakeStats, readdir: (path: string) => string[]): TreeFileSystem {
  return { lstatSync: lstat, readdirSync: readdir } as unknown as TreeFileSystem
}

/** A stat answer for a folder, a plain file, or something that is neither. */
function fakeStats(kind: "directory" | "file" | "other"): FakeStats {
  return {
    isSymbolicLink: (): boolean => false,
    isDirectory: (): boolean => kind === "directory",
    isFile: (): boolean => kind === "file",
    size: 0
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-compression-test-"))
  source = workspacePath("installation")
  output = workspacePath("backups")
  mkdirSync(source)
  mkdirSync(output)
  writeFileSync(join(source, "Vintagestory"), "elf")
  mkdirSync(join(source, "assets"))
  writeFileSync(join(source, "assets", "version.txt"), "1.22.6")
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(workspace, { recursive: true, force: true })
})

const GIB = 1024 * 1024 * 1024

/**
 * Makes one file stat at whatever size is asked for, without putting anything
 * like that on disk.
 *
 * The ceilings are read off `stats.size`, so that is the only part of a
 * multi-gigabyte installation a test needs. A sparse file would do the same on
 * Linux and not on Windows, where CI also runs. Every other path keeps the real
 * answer, so the safety walk, the destination checks and tar itself all still
 * see the actual (tiny) tree.
 */
function statFileAs(target: string, sizeBytes: number): void {
  const realLstatSync = fse.lstatSync.bind(fse)
  vi.spyOn(fse, "lstatSync").mockImplementation(((pathValue: Parameters<typeof fse.lstatSync>[0], options: Parameters<typeof fse.lstatSync>[1]) => {
    const stats = realLstatSync(pathValue, options as never)
    if (pathValue === target && stats) stats.size = sizeBytes
    return stats
  }) as typeof fse.lstatSync)
}

/** A statfs answer, or a throw when `bavail` is left out. */
function statfsAnswering(freeBlocks: number | undefined, blockSize = 4096): Pick<typeof fse, "statfsSync"> {
  return {
    statfsSync: ((): StatsFsBase<number> => {
      if (freeBlocks === undefined) throw new Error("ENOTSUP: statfs is not supported on this filesystem")
      return { type: 0, bsize: blockSize, blocks: freeBlocks, bfree: freeBlocks, bavail: freeBlocks, files: 0, ffree: 0 }
    }) as unknown as typeof fse.statfsSync
  }
}

describe("assertSafeCompressionTree", () => {
  it("accepts a tree of plain files and folders and totals their bytes", () => {
    assert.equal(assertSafeCompressionTree(source), "elf".length + "1.22.6".length)
  })

  it("refuses a symbolic link anywhere in the tree", () => {
    symlinkSync(workspacePath("backups"), join(source, "elsewhere"))

    assert.throws(() => assertSafeCompressionTree(source), /unsafe filesystem entry/)
  })

  it("refuses an entry that is neither a file nor a folder", () => {
    const socket = fakeStats("other")

    assert.throws(
      () =>
        assertSafeCompressionTree(
          FAKE_ROOT,
          fakeTree(
            () => socket,
            () => []
          )
        ),
      /unsafe filesystem entry/
    )
  })

  it("refuses a tree with more entries than the cap allows", () => {
    // A real tree of 100 001 entries costs more to build than the whole suite
    // costs to run, so the walk is pointed at a fake one that claims to hold them.
    const directory = fakeStats("directory")
    const file = fakeStats("file")
    const children = Array.from({ length: 100_001 }, (_, index) => `child-${index}`)

    assert.throws(
      () =>
        assertSafeCompressionTree(
          FAKE_ROOT,
          fakeTree(
            (path) => (path === FAKE_ROOT ? directory : file),
            () => children
          )
        ),
      /Too many filesystem entries/
    )
  })
})

describe("runCompression", () => {
  it("archives the source contents, not the source folder itself", async () => {
    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" })

    // No "installation/" prefix anywhere: the wrapping folder is what a restore
    // would otherwise put back one level too deep.
    assert.deepEqual(await archiveEntryNames(join(output, "backup.tar.gz")), ["Vintagestory", "assets/", "assets/version.txt"])
  })

  it("writes a gzip stream, which is what the restore reader expects", async () => {
    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" })

    const bytes = readFileSync(join(output, "backup.tar.gz"))
    assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b])
    assert.equal(gunzipSync(bytes).length % 512, 0)
  })

  it("honours the compression level it is given", async () => {
    const compressible = workspacePath("compressible")
    mkdirSync(compressible)
    writeFileSync(join(compressible, "log.txt"), "the same sentence over and over. ".repeat(4_000))

    await runCompression({ inputPath: compressible, outputPath: output, outputFileName: "fastest.tar.gz", compressionLevel: 1 })
    await runCompression({ inputPath: compressible, outputPath: output, outputFileName: "smallest.tar.gz", compressionLevel: 9 })

    // Level 0 stores rather than deflates, so it is the one that says outright
    // that the number reaches zlib at all instead of being quietly dropped.
    await runCompression({ inputPath: compressible, outputPath: output, outputFileName: "stored.tar.gz", compressionLevel: 0 })

    const stored = statSync(join(output, "stored.tar.gz")).size
    const fastest = statSync(join(output, "fastest.tar.gz")).size
    const smallest = statSync(join(output, "smallest.tar.gz")).size
    assert.equal(smallest <= fastest, true)
    assert.equal(fastest < stored, true)
  })

  it("reports progress and always ends at 100, once", async () => {
    const many = workspacePath("many-files")
    mkdirSync(many)
    for (let index = 0; index < 200; index++) writeFileSync(join(many, `file-${index}.bin`), Buffer.alloc(4_096, index % 251))
    const progress: number[] = []

    await runCompression({ inputPath: many, outputPath: output, outputFileName: "progress.tar.gz", onProgress: (value) => progress.push(value) })

    assert.equal(progress.at(-1), 100)
    assert.equal(progress.filter((value) => value === 100).length, 1)
    assert.equal(new Set(progress).size, progress.length)
    assert.deepEqual(
      [...progress].sort((left, right) => left - right),
      progress
    )
    assert.equal(
      progress.some((value) => value > 0 && value < 100),
      true
    )
  })

  it("reports the terminal 100 even for a source with nothing in it", async () => {
    const empty = workspacePath("empty")
    mkdirSync(empty)
    const progress: number[] = []

    await runCompression({ inputPath: empty, outputPath: output, outputFileName: "empty.tar.gz", onProgress: (value) => progress.push(value) })

    assert.deepEqual(progress, [100])
  })

  it("creates the destination folder when it is missing", async () => {
    const missing = workspacePath("backups", "nested", "deeper")

    await runCompression({ inputPath: source, outputPath: missing, outputFileName: "backup.tar.gz" })

    assert.equal(statSync(join(missing, "backup.tar.gz")).isFile(), true)
  })

  it("refuses a source holding a symbolic link, without writing an archive", async () => {
    symlinkSync(workspacePath("backups"), join(source, "elsewhere"))

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /unsafe filesystem entry/)

    assert.equal(statSync(output).isDirectory(), true)
    assert.throws(() => statSync(join(output, "backup.tar.gz")))
  })

  it("refuses a source that is a file rather than a folder", async () => {
    await assert.rejects(runCompression({ inputPath: join(source, "Vintagestory"), outputPath: output, outputFileName: "backup.tar.gz" }), /must be a directory/)
  })

  it("refuses a source that does not exist", async () => {
    await assert.rejects(runCompression({ inputPath: workspacePath("gone"), outputPath: output, outputFileName: "backup.tar.gz" }))
  })

  it("refuses a destination that is a symbolic link", async () => {
    const linked = workspacePath("linked-backups")
    symlinkSync(output, linked)

    await assert.rejects(runCompression({ inputPath: source, outputPath: linked, outputFileName: "backup.tar.gz" }), /destination is unsafe/)
  })

  it("refuses a destination that is a file", async () => {
    const asFile = workspacePath("not-a-folder")
    writeFileSync(asFile, "")

    await assert.rejects(runCompression({ inputPath: source, outputPath: asFile, outputFileName: "backup.tar.gz" }), /destination is unsafe/)
  })

  it("refuses to write over a folder standing where the archive would go", async () => {
    mkdirSync(join(output, "backup.tar.gz"))

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /archive target is unsafe/)
  })

  it("refuses to write through a symbolic link standing where the archive would go", async () => {
    writeFileSync(workspacePath("someone-elses-file"), "")
    symlinkSync(workspacePath("someone-elses-file"), join(output, "backup.tar.gz"))

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /archive target is unsafe/)
    assert.equal(readFileSync(workspacePath("someone-elses-file"), "utf8"), "")
  })

  // Issue #362: three modded installations, 4 GB, 2.6 GB and 19 GB, every
  // automatic backup refused. The ceiling was MAX_ARCHIVE_TOTAL_BYTES, which is
  // sized against archives arriving over the network and has nothing to say
  // about a folder the player already has.
  it("compresses a source past the old 2 GiB archive ceiling", async () => {
    const world = join(source, "world.vcdbs")
    writeFileSync(world, "a world")
    statFileAs(world, 4 * GIB)

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" })

    assert.deepEqual(await archiveEntryNames(join(output, "backup.tar.gz")), ["Vintagestory", "assets/", "assets/version.txt", "world.vcdbs"])
  })

  it("refuses a source past the total the restore reader will accept", async () => {
    const world = join(source, "world.vcdbs")
    writeFileSync(world, "a world")
    statFileAs(world, 65 * GIB)

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /too large/)

    // Refused before anything was written, rather than after gigabytes of work.
    assert.deepEqual(readdirSync(output), [])
  })

  it("refuses when the destination drive has less room than the source is large", async () => {
    const world = join(source, "world.vcdbs")
    writeFileSync(world, "a world")
    statFileAs(world, 4 * GIB)
    // 1 GiB free against a 4 GiB source.
    vi.spyOn(fse, "statfsSync").mockImplementation(statfsAnswering(GIB / 4096).statfsSync)

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /Not enough free space/)

    assert.deepEqual(readdirSync(output), [])
  })

  it("compresses anyway when the filesystem cannot say how much room is left", async () => {
    const world = join(source, "world.vcdbs")
    writeFileSync(world, "a world")
    statFileAs(world, 4 * GIB)
    vi.spyOn(fse, "statfsSync").mockImplementation(statfsAnswering(undefined).statfsSync)

    // An unreadable free-space figure is not evidence of a full disk, and every
    // backup on an exotic filesystem refusing would be worse than #362 itself.
    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" })

    assert.deepEqual(readdirSync(output), ["backup.tar.gz"])
  })

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("takes the half written archive away when the write fails", async () => {
    // A file the safety walk can stat but tar cannot read, so the failure lands
    // after tar has already created the archive and written the first bytes.
    chmodSync(join(source, "Vintagestory"), 0o000)

    // "Compression failed: <cause>", not the bare string: the tar write failure
    // is the one #337 case where an errno says something, so the catch carries it.
    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" }), /Compression failed: \S/)

    // A failed backup leaves no record behind, and pruning only ever walks the
    // records, so anything left here would stay for good and a retry would add
    // one more beside it.
    assert.deepEqual(readdirSync(output), [])
  })

  it("overwrites a plain archive file already sitting there", async () => {
    writeFileSync(join(output, "backup.tar.gz"), "the previous backup")

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.tar.gz" })

    assert.deepEqual(await archiveEntryNames(join(output, "backup.tar.gz")), ["Vintagestory", "assets/", "assets/version.txt"])
  })
})

describe("assertRoomForArchive", () => {
  it("refuses when the free blocks do not cover the source", () => {
    assert.throws(() => assertRoomForArchive(output, 4 * GIB, statfsAnswering(GIB / 4096)), /Not enough free space for the backup: 3 GB more is needed/)
  })

  it("accepts when they do", () => {
    assertRoomForArchive(output, 4 * GIB, statfsAnswering((8 * GIB) / 4096))
  })

  it("accepts when statfs throws", () => {
    assertRoomForArchive(output, 4 * GIB, statfsAnswering(undefined))
  })

  it("accepts when the block size is a number that means nothing", () => {
    // bsize 0 would multiply out to zero free bytes and refuse every backup on
    // that mount, which is the answer "I do not know" wearing the answer "full".
    assertRoomForArchive(output, 4 * GIB, statfsAnswering(1_000_000, 0))
  })

  it("counts the blocks this process may write into, not the ones reserved for root", () => {
    const reserved = {
      statfsSync: ((): StatsFsBase<number> => ({ type: 0, bsize: 4096, blocks: (16 * GIB) / 4096, bfree: (8 * GIB) / 4096, bavail: 0, files: 0, ffree: 0 })) as unknown as typeof fse.statfsSync
    }
    assert.throws(() => assertRoomForArchive(output, GIB, reserved), /Not enough free space/)
  })
})

describe("the two ceilings stay apart", () => {
  it("keeps the backup ceiling well above the one for archives the launcher did not write", () => {
    assert.equal(MAX_BACKUP_TOTAL_BYTES, 64 * GIB)
    assert.equal(MAX_ARCHIVE_TOTAL_BYTES, 2 * GIB)
  })
})
