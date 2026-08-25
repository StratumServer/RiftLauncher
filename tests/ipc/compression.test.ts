import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { assertSafeCompressionTree, runCompression, type ArchiveAdd } from "@src/ipc/workers/compression"

/**
 * The backup compression, driven without spawning 7-Zip.
 *
 * `runCompression` takes the `Seven.add` call as a parameter, so these pin two
 * separate things: the safety walk over the real source tree, which runs before
 * 7-Zip is handed anything, and the invocation and message protocol, which is
 * asserted on the recorded arguments instead of on an archive.
 *
 * The walk is the half worth being fussy about. 7-Zip follows a symbolic link
 * into whatever it points at, so a link inside a backup source would quietly
 * pull files from outside the folder into the archive.
 */

let workspace: string
let source: string
let output: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

interface Invocation {
  archivePath: string
  source: string
  options: Record<string, unknown>
}

/** A stand-in for `Seven.add` that records its call and replays a scripted event sequence. */
function fakeAdd(script: (stream: EventEmitter) => void): { add: ArchiveAdd; invocations: Invocation[] } {
  const invocations: Invocation[] = []

  const add: ArchiveAdd = (archivePath, sourceGlob, options) => {
    invocations.push({ archivePath, source: sourceGlob, options: options as unknown as Record<string, unknown> })
    const stream = new EventEmitter()
    setImmediate(() => script(stream))
    return stream
  }

  return { add, invocations }
}

const FAKE_ROOT = "/fake/root"

type FakeStats = { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }
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
    isFile: (): boolean => kind === "file"
  }
}

/** Scripts a run that reports the given percentages and then ends. */
function succeedsAt(...percentages: unknown[]): (stream: EventEmitter) => void {
  return (stream) => {
    for (const percent of percentages) stream.emit("progress", { percent })
    stream.emit("end")
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
  rmSync(workspace, { recursive: true, force: true })
})

describe("assertSafeCompressionTree", () => {
  it("accepts a tree of plain files and folders", () => {
    assert.doesNotThrow(() => assertSafeCompressionTree(source))
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
    const seven = fakeAdd(succeedsAt(30, 80))

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add })

    assert.equal(seven.invocations.length, 1)
    assert.equal(seven.invocations[0]?.archivePath, join(output, "backup.zip"))
    // The trailing glob is what keeps the wrapping folder out of the archive,
    // so a restore puts the files back where they came from.
    assert.equal(seven.invocations[0]?.source, join(source, "*"))
  })

  it("passes the compression level and the binary 7-Zip is asked for", async () => {
    const seven = fakeAdd(succeedsAt())

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", compressionLevel: 4, sevenZipBin: "/opt/7za", addArchive: seven.add })

    assert.deepEqual(seven.invocations[0]?.options, { $bin: "/opt/7za", $progress: true, recursive: true, method: ["x=4", "mt=on"] })
  })

  it("defaults to level 6 when the caller names none", async () => {
    const seven = fakeAdd(succeedsAt())

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add })

    assert.deepEqual(seven.invocations[0]?.options.method, ["x=6", "mt=on"])
  })

  it("reports progress and always ends at 100", async () => {
    const progress: number[] = []
    const seven = fakeAdd(succeedsAt(10, 55, 90))

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add, onProgress: (value) => progress.push(value) })

    assert.deepEqual(progress, [10, 55, 90, 100])
  })

  it("coalesces repeated percentages and reports completion once", async () => {
    const progress: number[] = []
    const seven = fakeAdd(succeedsAt(0, 0, 10, 10, 50, 50, 100, 100))

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add, onProgress: (value) => progress.push(value) })

    assert.deepEqual(progress, [10, 50, 100])
  })

  it("ignores a progress report that goes backwards, past 100, or is not a number", async () => {
    const progress: number[] = []
    const seven = fakeAdd(succeedsAt(40, 20, 140, "not a number", undefined, 60))

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add, onProgress: (value) => progress.push(value) })

    assert.deepEqual(progress, [40, 60, 100])
  })

  it("fails when 7-Zip errors", async () => {
    const seven = fakeAdd((stream) => stream.emit("error", new Error("7-Zip exited with code 2")))

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }), /Compression failed/)
  })

  it("creates the destination folder when it is missing", async () => {
    const seven = fakeAdd(succeedsAt())
    const missing = workspacePath("backups", "nested", "deeper")

    await runCompression({ inputPath: source, outputPath: missing, outputFileName: "backup.zip", addArchive: seven.add })

    assert.equal(seven.invocations[0]?.archivePath, join(missing, "backup.zip"))
  })

  it("refuses a source holding a symbolic link, without invoking 7-Zip", async () => {
    symlinkSync(workspacePath("backups"), join(source, "elsewhere"))
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }), /unsafe filesystem entry/)

    assert.deepEqual(seven.invocations, [])
  })

  it("refuses a source that is a file rather than a folder", async () => {
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: join(source, "Vintagestory"), outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }), /must be a directory/)

    assert.deepEqual(seven.invocations, [])
  })

  it("refuses a source that does not exist", async () => {
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: workspacePath("gone"), outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }))

    assert.deepEqual(seven.invocations, [])
  })

  it("refuses a destination that is a symbolic link", async () => {
    const linked = workspacePath("linked-backups")
    symlinkSync(output, linked)
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: source, outputPath: linked, outputFileName: "backup.zip", addArchive: seven.add }), /destination is unsafe/)

    assert.deepEqual(seven.invocations, [])
  })

  it("refuses a destination that is a file", async () => {
    const asFile = workspacePath("not-a-folder")
    writeFileSync(asFile, "")
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: source, outputPath: asFile, outputFileName: "backup.zip", addArchive: seven.add }), /destination is unsafe/)
  })

  it("refuses to write over a folder standing where the archive would go", async () => {
    mkdirSync(join(output, "backup.zip"))
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }), /archive target is unsafe/)

    assert.deepEqual(seven.invocations, [])
  })

  it("refuses to write through a symbolic link standing where the archive would go", async () => {
    writeFileSync(workspacePath("someone-elses-file"), "")
    symlinkSync(workspacePath("someone-elses-file"), join(output, "backup.zip"))
    const seven = fakeAdd(succeedsAt())

    await assert.rejects(runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add }), /archive target is unsafe/)

    assert.deepEqual(seven.invocations, [])
  })

  it("overwrites a plain archive file already sitting there", async () => {
    writeFileSync(join(output, "backup.zip"), "the previous backup")
    const seven = fakeAdd(succeedsAt())

    await runCompression({ inputPath: source, outputPath: output, outputFileName: "backup.zip", addArchive: seven.add })

    assert.equal(seven.invocations.length, 1)
  })
})
