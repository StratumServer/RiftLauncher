import assert from "node:assert/strict"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"
import * as tar from "tar"

import { contentRoot, extractTarGz, extractZip, resolveEntryDestination, runExtraction, validateTree } from "../../src/ipc/workers/extraction"
import { runCompression } from "../../src/ipc/workers/compression"
import { restoreInstallationBackup } from "../../src/domain/installations/restore"
import type { Extractor, FileSystem } from "../../src/domain/ports"

/**
 * These build their own archives, so they run anywhere without a network. The
 * two zip fixtures are the exception, and they are committed rather than built:
 * the whole point of keeping a zip reader is that backups written by a version
 * of the launcher nobody runs any more still restore. See
 * tests/fixtures/build-fixtures.ts for what is in them.
 *
 * The one test that needs a real Vintage Story archive is opt in: point
 * RIFT_E2E_ARCHIVE at a downloaded game tar.gz to run it. CI never does.
 */

const FIXTURES = join(__dirname, "..", "fixtures")

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

  it("refuses a real hard link, by nlink rather than by a reused dev:ino pair", () => {
    writeTree(workspacePath("payload"), { "real.txt": "body" })
    linkSync(workspacePath("payload", "real.txt"), workspacePath("payload", "linked.txt"))

    assert.throws(() => validateTree(workspacePath("payload")), /hard links/)
  })

  it("passes distinct zero-byte files, which platform quirks can report under a reused dev:ino pair without being hard links", () => {
    writeTree(workspacePath("payload"), { "empty-a.txt": "", "empty-b.txt": "", "empty-c.txt": "" })

    const stats = validateTree(workspacePath("payload"))

    assert.equal(stats.entries, 4)
  })
})

describe("runExtraction on a gzipped tar", () => {
  it("unpacks a wrapped archive straight into the target folder", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf", assets: { "version-1.22.6.txt": "", "seed.json": "{}" } } })
    const archivePath = await makeTarGz("vs_client_linux-x64_1.22.6.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true })

    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["Vintagestory", "assets"])
    assert.equal(readFileSync(workspacePath("target", "Vintagestory"), "utf8"), "elf")
    assert.equal(existsSync(workspacePath("target", "vintagestory")), false)
  })

  it("keeps a zero byte marker as a zero byte file", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf", assets: { "version-1.22.6.txt": "" } } })
    const archivePath = await makeTarGz("wrapped.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true })

    const marker = workspacePath("target", "assets", "version-1.22.6.txt")
    assert.equal(existsSync(marker), true)
    assert.equal(statSync(marker).size, 0)
  })

  it("leaves a flat archive flat", async () => {
    writeTree(workspacePath("source"), { VintagestoryServer: "elf", assets: { "version-1.22.6.txt": "" } })
    const archivePath = await makeTarGz("vs_server_linux-x64_1.22.6.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true })

    assert.deepEqual(readdirSync(workspacePath("target")).sort(), ["VintagestoryServer", "assets"])
    assert.equal(existsSync(workspacePath("target", "assets", "version-1.22.6.txt")), true)
  })

  it("reports progress and finishes at 100", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf".repeat(200_000) } })
    const archivePath = await makeTarGz("progress.tar.gz", workspacePath("source"))
    const reported: number[] = []

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true, onProgress: (progress) => reported.push(progress) })

    assert.equal(reported.at(-1), 100)
    assert.equal(reported.filter((progress) => progress === 100).length, 1)
    assert.equal(new Set(reported).size, reported.length)
    assert.equal(
      reported.every((progress) => progress >= 0 && progress <= 100),
      true
    )
  })

  it("deletes the archive when asked, and only then", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    const keptPath = await makeTarGz("kept.tar.gz", workspacePath("source"))
    const consumedPath = await makeTarGz("consumed.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: keptPath, outputPath: workspacePath("kept"), deleteArchive: false, unwrapSingleRootFolder: true })
    await runExtraction({ filePath: consumedPath, outputPath: workspacePath("consumed"), deleteArchive: true, unwrapSingleRootFolder: true })

    assert.equal(existsSync(keptPath), true)
    assert.equal(existsSync(consumedPath), false)
  })

  it("refuses an archive carrying a symbolic link instead of unpacking it", async () => {
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    symlinkSync("/etc/passwd", workspacePath("source", "vintagestory", "escape.txt"))
    const archivePath = await makeTarGz("hostile.tar.gz", workspacePath("source"))

    await assert.rejects(runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true }), /unsafe entry/)
    assert.equal(existsSync(workspacePath("target", "escape.txt")), false)
    assert.equal(existsSync(workspacePath("target", "Vintagestory")), false)
  })

  it("writes nothing into the target when the archive cannot be read", async () => {
    writeFileSync(workspacePath("broken.tar.gz"), "not a gzip stream at all")

    // Caught by runExtraction's own pre-extraction validateArchive call, before it even
    // creates the target directory, let alone extracts (and its generic "Extraction failed")
    // is ever reached.
    await assert.rejects(
      runExtraction({ filePath: workspacePath("broken.tar.gz"), outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true }),
      /Archive could not be read/
    )
    assert.equal(existsSync(workspacePath("target")), false)
  })

  it("leaves no temporary workspace behind", async () => {
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("vs-launcher-extract-")).length
    writeTree(workspacePath("source"), { vintagestory: { Vintagestory: "elf" } })
    const archivePath = await makeTarGz("clean.tar.gz", workspacePath("source"))

    await runExtraction({ filePath: archivePath, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true })

    assert.equal(readdirSync(tmpdir()).filter((entry) => entry.startsWith("vs-launcher-extract-")).length, before)
  })
})

/** Every file in a tree, as a relative path to its bytes, so two trees can be compared outright. */
function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const entry = join(current, name)
      if (lstatSync(entry).isDirectory()) visit(entry)
      else files[relative(root, entry).replaceAll("\\", "/")] = readFileSync(entry, "base64")
    }
  }
  visit(root)
  return files
}

describe("backup round trip", () => {
  it("puts a freshly written backup back exactly as it was", async () => {
    writeTree(workspacePath("installation"), {
      Mods: { "carrycapacity.zip": "not really a mod", "notes.txt": "" },
      "clientsettings.json": "{}",
      Saves: { "world.vcdbs": "  binary-ish" }
    })
    const before = readTree(workspacePath("installation"))

    await runCompression({ inputPath: workspacePath("installation"), outputPath: workspacePath("backups"), outputFileName: "backup.tar.gz" })
    await runExtraction({ filePath: workspacePath("backups", "backup.tar.gz"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readTree(workspacePath("restored")), before)
    assert.deepEqual(readdirSync(workspacePath("restored")).sort(), readdirSync(workspacePath("installation")).sort())
  })

  it("puts two names for one inode back as two ordinary files", async () => {
    // A player does not have to have made a hard link to have one: a
    // deduplicating filesystem hands them out on its own, and a mod copied twice
    // can end up as two names over one inode. Left alone, tar writes the second
    // name as a Link entry, the restore reader refuses Link, and the backup
    // reports success while being impossible to put back.
    writeTree(workspacePath("installation"), { Mods: { "carrycapacity.zip": "not really a mod" }, "clientsettings.json": "{}" })
    const firstName = workspacePath("installation", "Mods", "carrycapacity.zip")
    const secondName = workspacePath("installation", "Mods", "carrycapacity-1.0.0.zip")
    linkSync(firstName, secondName)
    // The fixture is only worth anything if the two names really are one file.
    assert.equal(lstatSync(firstName).ino, lstatSync(secondName).ino)
    assert.equal(lstatSync(firstName).nlink, 2)
    const before = readTree(workspacePath("installation"))

    await runCompression({ inputPath: workspacePath("installation"), outputPath: workspacePath("backups"), outputFileName: "backup.tar.gz" })

    // Nothing in the archive asks the reader to link one name to another: the
    // second name carries its own bytes, which is what makes the backup
    // self-contained and the restore below possible at all.
    const archived: { path: string; type: string; size: number }[] = []
    await tar.list({ file: workspacePath("backups", "backup.tar.gz"), onReadEntry: (entry) => void archived.push({ path: entry.path, type: entry.type, size: entry.size }) })
    assert.deepEqual(
      archived.filter((entry) => entry.type !== "File" && entry.type !== "Directory"),
      []
    )
    assert.deepEqual(
      archived.filter((entry) => entry.path.startsWith("Mods/carrycapacity")).map((entry) => entry.size),
      [16, 16]
    )

    await runExtraction({ filePath: workspacePath("backups", "backup.tar.gz"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readTree(workspacePath("restored")), before)
    // Independent copies, not the sharing put back: the launcher only promises
    // the bytes, and the extraction's own tree check refuses a hard link anyway.
    const restoredFirst = lstatSync(workspacePath("restored", "Mods", "carrycapacity.zip"))
    const restoredSecond = lstatSync(workspacePath("restored", "Mods", "carrycapacity-1.0.0.zip"))
    assert.equal(restoredFirst.nlink, 1)
    assert.equal(restoredSecond.nlink, 1)
    assert.notEqual(restoredFirst.ino, restoredSecond.ino)
  })

  it("puts a backup of an empty installation back as an empty folder", async () => {
    mkdirSync(workspacePath("installation"), { recursive: true })

    await runCompression({ inputPath: workspacePath("installation"), outputPath: workspacePath("backups"), outputFileName: "backup.tar.gz" })
    await runExtraction({ filePath: workspacePath("backups", "backup.tar.gz"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readdirSync(workspacePath("restored")), [])
  })

  it("never steps into a single folder a backup happens to hold, the way a game archive is stepped into", async () => {
    // An installation whose only entry is a folder is not a wrapped archive: it
    // is an installation with one folder in it, and a restore has to put that
    // folder back rather than spill its contents over the installation root.
    writeTree(workspacePath("installation"), { Mods: { "notes.txt": "one folder, nothing else" } })

    await runCompression({ inputPath: workspacePath("installation"), outputPath: workspacePath("backups"), outputFileName: "backup.tar.gz" })
    await runExtraction({ filePath: workspacePath("backups", "backup.tar.gz"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readdirSync(workspacePath("restored")), ["Mods"])
    assert.equal(readFileSync(workspacePath("restored", "Mods", "notes.txt"), "utf8"), "one folder, nothing else")
  })
})

/**
 * An archive whose second entry cannot be written, without needing a full disk
 * or a permission the test runner may not be able to drop: "a" is a plain file,
 * and "a/b" then asks for "a" to be a folder. The unpacker fails that one entry
 * and carries on to the next, which is how a disk that fills partway through a
 * multi-GB restore fails too, one entry at a time.
 */
async function makeConflictingTarGz(archiveName: string): Promise<string> {
  writeTree(workspacePath("conflict"), { a: "the file standing in the way", elsewhere: { b: "never lands" } })
  const archivePath = workspacePath(archiveName)
  await tar.create(
    {
      file: archivePath,
      cwd: workspacePath("conflict"),
      gzip: true,
      portable: true,
      onWriteEntry: (entry) => {
        if (entry.path === "elsewhere/b") entry.path = "a/b"
      }
    },
    ["a", "elsewhere/b"]
  )
  return archivePath
}

describe("a gzipped tar whose entries fail to land", () => {
  it("fails the extraction rather than reporting a truncated tree as a whole one", async () => {
    const archivePath = await makeConflictingTarGz("half-lands.tar.gz")

    await assert.rejects(runExtraction({ filePath: archivePath, outputPath: workspacePath("restored"), deleteArchive: false }), /Extraction failed/)

    // Nothing was copied out of the temporary folder, so the destination is as
    // empty as it was: a partial tree is not a restore.
    assert.deepEqual(readdirSync(workspacePath("restored")), [])
  })

  it("leaves the installation where it is, because the swap only happens once the extraction succeeded", async () => {
    const archivePath = await makeConflictingTarGz("half-lands.tar.gz")
    writeTree(workspacePath("my-install"), { "clientsettings.json": "the only copy of this" })

    const fileSystem: FileSystem = {
      exists: async (path: string): Promise<boolean> => existsSync(path),
      remove: async (path: string): Promise<boolean> => {
        rmSync(path, { recursive: true, force: true })
        return true
      },
      move: async (from: string, to: string): Promise<boolean> => {
        renameSync(from, to)
        return true
      }
    }
    // The same shape extractWorker.ts gives the port: a rejection becomes a
    // reported failure, anything else is a success.
    const extractor: Extractor = {
      extract: async (request, onComplete): Promise<void> => {
        try {
          await runExtraction({ filePath: request.archivePath, outputPath: request.outputFolder, deleteArchive: false })
          onComplete({ ok: true })
        } catch (error) {
          onComplete({ ok: false, error: (error as Error).message })
        }
      }
    }

    const result = await restoreInstallationBackup(
      { fileSystem, extractor, ids: { newId: (): string => "token" }, closeGuard: { acquire: () => (): void => {} } },
      {
        installation: {
          id: "install-1",
          name: "My install",
          path: workspacePath("my-install"),
          backupsLimit: 3,
          compressionLevel: 6,
          backups: [],
          isBackingUp: false,
          isPlaying: false,
          isRestoringBackup: false
        },
        backup: { id: "backup-1", date: 0, path: archivePath }
      }
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, "extract-failed")
    assert.equal(readFileSync(workspacePath("my-install", "clientsettings.json"), "utf8"), "the only copy of this")
    assert.deepEqual(readdirSync(workspacePath("my-install")), ["clientsettings.json"])
  })
})

describe("runExtraction on a legacy zip backup", () => {
  it("restores a backup written before the launcher moved off zip", async () => {
    await runExtraction({ filePath: join(FIXTURES, "legacy-backup.zip"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readTree(workspacePath("restored")), {
      Vintagestory: Buffer.from("elf").toString("base64"),
      "assets/version-1.22.6.txt": "",
      "Mods/notes.txt": Buffer.from("a mod list worth keeping\n").toString("base64")
    })
    // A folder entry lands as a folder, and the zero byte marker inside it stays zero bytes.
    assert.equal(lstatSync(workspacePath("restored", "assets")).isDirectory(), true)
    assert.equal(statSync(workspacePath("restored", "assets", "version-1.22.6.txt")).size, 0)
  })

  it("keeps a zip's own shape, because those are the backups a restore puts back", async () => {
    await runExtraction({ filePath: join(FIXTURES, "legacy-backup.zip"), outputPath: workspacePath("restored"), deleteArchive: false })

    assert.deepEqual(readdirSync(workspacePath("restored")).sort(), ["Mods", "Vintagestory", "assets"])
  })

  it("coalesces progress and emits one terminal 100", async () => {
    const reported: number[] = []

    await runExtraction({ filePath: join(FIXTURES, "legacy-backup.zip"), outputPath: workspacePath("restored"), deleteArchive: false, onProgress: (progress) => reported.push(progress) })

    assert.equal(reported.at(-1), 100)
    assert.equal(reported.filter((progress) => progress === 100).length, 1)
    assert.equal(new Set(reported).size, reported.length)
    assert.deepEqual(
      [...reported].sort((left, right) => left - right),
      reported
    )
    assert.equal(
      reported.some((progress) => progress > 0 && progress < 100),
      true
    )
  })

  it("deletes the archive when asked", async () => {
    const consumedPath = workspacePath("consumed.zip")
    writeFileSync(consumedPath, readFileSync(join(FIXTURES, "legacy-backup.zip")))

    await runExtraction({ filePath: consumedPath, outputPath: workspacePath("restored"), deleteArchive: true })

    assert.equal(existsSync(consumedPath), false)
  })

  it("refuses a zip naming entries outside the folder it unpacks into", async () => {
    // The refusal comes from yauzl's own name validation, which stops the read
    // at the first entry that names a drive, a "/" root or a ".." segment, so
    // the launcher's table-of-contents pass reports an unreadable archive
    // rather than an unsafe entry. Either way nothing is written, which is the
    // property worth holding: the archive is refused before the output folder
    // is even created.
    await assert.rejects(runExtraction({ filePath: join(FIXTURES, "hostile-backup.zip"), outputPath: workspacePath("restored"), deleteArchive: false }), /could not be read/)

    assert.equal(existsSync(workspacePath("escaped.txt")), false)
    assert.equal(existsSync(workspacePath("escaped-drive.txt")), false)
    assert.equal(existsSync("/etc/escaped-absolute.txt"), false)
    assert.equal(existsSync(workspacePath("restored")), false)
  })

  it("refuses an entry name yauzl accepts but the launcher does not", async () => {
    // The other hostile fixture is stopped by yauzl's own name validation, so
    // the launcher's isSafeArchiveEntry never gets a say on it. A NUL byte in
    // the middle of a name is one yauzl has nothing to say about, which makes
    // this the archive that pins that gate against real bytes.
    await assert.rejects(runExtraction({ filePath: join(FIXTURES, "unsafe-name-backup.zip"), outputPath: workspacePath("restored"), deleteArchive: false }), /unsafe entry/)

    assert.equal(existsSync(workspacePath("restored")), false)
  })

  it("refuses an archive whose name says neither zip nor tar.gz", async () => {
    await assert.rejects(runExtraction({ filePath: join(FIXTURES, "not-a-zip.bin"), outputPath: workspacePath("restored"), deleteArchive: false }), /not supported/)
  })
})

/**
 * The unpackers' own look at an entry name, past the table-of-contents check
 * that normally refuses these archives before either unpacker is reached. What
 * is inside an archive is not something the launcher wrote, so both gates get
 * pinned rather than only the first.
 */
describe("hostile entry names, straight at the unpackers", () => {
  it("refuses to place a zip entry that climbs out, is absolute, or names a drive", () => {
    const destination = workspacePath("destination", "inside")

    assert.throws(() => resolveEntryDestination(destination, "../escaped.txt"), /escaped its root/)
    assert.throws(() => resolveEntryDestination(destination, "assets/../../escaped.txt"), /escaped its root/)
    assert.throws(() => resolveEntryDestination(destination, "/etc/escaped-absolute.txt"), /escaped its root/)
    // A backslash separator is a Windows path inside a zip, and is normalised
    // before the comparison rather than taken as part of a file name.
    assert.throws(() => resolveEntryDestination(destination, "..\\escaped.txt"), /escaped its root/)
    assert.throws(() => resolveEntryDestination(destination, "."), /escaped its root/)
  })

  it("places an ordinary zip entry under the destination", () => {
    const destination = workspacePath("destination", "inside")

    assert.equal(resolveEntryDestination(destination, "assets/version-1.22.6.txt"), join(destination, "assets", "version-1.22.6.txt"))
    assert.equal(resolveEntryDestination(destination, "Mods\\notes.txt"), join(destination, "Mods", "notes.txt"))
  })

  it("writes nothing outside the destination for a zip full of escaping names", async () => {
    const destination = workspacePath("destination", "inside")
    mkdirSync(destination, { recursive: true })

    await assert.rejects(extractZip(join(FIXTURES, "hostile-backup.zip"), destination))

    assert.equal(existsSync(workspacePath("destination", "escaped.txt")), false)
    assert.equal(existsSync(workspacePath("escaped.txt")), false)
    assert.equal(existsSync("/etc/escaped-absolute.txt"), false)
    assert.deepEqual(readdirSync(destination), [])
  })

  it("writes nothing outside the destination for a tar.gz climbing out with .. or an absolute path", async () => {
    writeTree(workspacePath("source"), { "escaped.txt": "climbed out" })
    const archivePath = workspacePath("hostile-names.tar.gz")
    await tar.create({ file: archivePath, gzip: true, cwd: workspacePath("source"), portable: true, preservePaths: true }, ["../source/escaped.txt", resolve(workspacePath("source", "escaped.txt"))])
    const destination = workspacePath("destination", "inside")
    mkdirSync(destination, { recursive: true })

    // The names are refused rather than quietly dropped: an entry the unpacker
    // will not place is a failed extraction, not a smaller one.
    await assert.rejects(extractTarGz(archivePath, destination), /Extraction failed/)

    assert.equal(existsSync(workspacePath("destination", "escaped.txt")), false)
    assert.equal(existsSync(workspacePath("escaped.txt")), false)
    // Whatever did land is under the destination, nowhere else.
    for (const landed of readdirSync(destination, { recursive: true }) as string[]) {
      assert.equal(resolve(destination, landed).startsWith(`${resolve(destination)}/`), true)
    }
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

    await runExtraction({ filePath: realArchive as string, outputPath: workspacePath("target"), deleteArchive: false, unwrapSingleRootFolder: true })

    const landed = readdirSync(workspacePath("target"))
    assert.equal(landed.includes("vintagestory"), false)
    assert.equal(landed.includes("Vintagestory") || landed.includes("VintagestoryServer"), true)
    assert.equal(lstatSync(workspacePath("target", "assets")).isDirectory(), true)
    if (version) assert.equal(statSync(workspacePath("target", "assets", `version-${version}.txt`)).size, 0)
  })
})
