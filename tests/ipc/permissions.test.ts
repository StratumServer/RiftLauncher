import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { changePermissions, type PermissionsFileSystem } from "@src/ipc/workers/permissions"

/**
 * The Linux permission pass, run against a real temporary tree.
 *
 * This is what gives the game executable its execute bit after an extraction,
 * so the assertions read the mode back off the disk rather than trusting a
 * mock. The cases a real tree cannot produce cheaply, an oversized tree and an
 * entry that is neither a file nor a folder, go through the injected
 * filesystem instead.
 *
 * The symbolic link rule is the one with teeth: `chmod` resolves links, so
 * following one would apply the launcher's bits to a file outside the folder
 * the user picked.
 */

let workspace: string
let installation: string

function workspacePath(...parts: string[]): string {
  return join(workspace, ...parts)
}

function modeOf(...parts: string[]): number {
  return statSync(join(...parts)).mode & 0o777
}

type FakeStats = { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }

interface RecordedFileSystem extends PermissionsFileSystem {
  readonly chmodCalls: { path: string; mode: number }[]
}

/** A filesystem that answers from the functions given and records every chmod, for trees too large or too odd to build. */
function fakeTree(lstat: (path: string) => FakeStats, readdir: (path: string) => string[]): RecordedFileSystem {
  const chmodCalls: { path: string; mode: number }[] = []

  return {
    chmodCalls,
    existsSync: (): boolean => true,
    lstatSync: lstat,
    readdirSync: readdir,
    chmodSync: (path, mode): void => {
      chmodCalls.push({ path, mode })
    }
  }
}

/** A stat answer for a folder, a plain file, or something that is neither. */
function fakeStats(kind: "directory" | "file" | "other"): FakeStats {
  return {
    isSymbolicLink: (): boolean => false,
    isDirectory: (): boolean => kind === "directory",
    isFile: (): boolean => kind === "file"
  }
}

const FAKE_ROOT = "/fake/root"
const FAKE_DIRECTORY = fakeStats("directory")
const FAKE_FILE = fakeStats("file")

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-permissions-test-"))
  installation = workspacePath("installation")
  mkdirSync(installation)
  writeFileSync(join(installation, "Vintagestory"), "elf", { mode: 0o600 })
  mkdirSync(join(installation, "assets"), { mode: 0o700 })
  writeFileSync(join(installation, "assets", "version.txt"), "1.22.6", { mode: 0o600 })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("changePermissions", () => {
  // chmod on Windows only toggles the read-only attribute; it cannot produce
  // POSIX mode bits like 0o755 or 0o600, so the mode a real tree ends up with
  // has nothing to do with what changePermissions asked for. These read the
  // mode back off disk, so they only mean anything on a POSIX filesystem.
  it.skipIf(process.platform === "win32")("applies the mode to the root, its files and everything nested under it", () => {
    changePermissions({ paths: [installation], perms: 0o755 })

    assert.equal(modeOf(installation), 0o755)
    assert.equal(modeOf(installation, "Vintagestory"), 0o755)
    assert.equal(modeOf(installation, "assets"), 0o755)
    assert.equal(modeOf(installation, "assets", "version.txt"), 0o755)
  })

  it.skipIf(process.platform === "win32")("applies the mode to a single file given directly", () => {
    changePermissions({ paths: [join(installation, "Vintagestory")], perms: 0o750 })

    assert.equal(modeOf(installation, "Vintagestory"), 0o750)
    assert.equal(modeOf(installation, "assets", "version.txt"), 0o600)
  })

  it.skipIf(process.platform === "win32")("walks every root it is given", () => {
    const second = workspacePath("data")
    mkdirSync(second)
    writeFileSync(join(second, "clientsettings.json"), "{}", { mode: 0o600 })

    changePermissions({ paths: [installation, second], perms: 0o755 })

    assert.equal(modeOf(installation, "Vintagestory"), 0o755)
    assert.equal(modeOf(second, "clientsettings.json"), 0o755)
  })

  it.skipIf(process.platform === "win32")("skips a path that is not there", () => {
    assert.doesNotThrow(() => changePermissions({ paths: [workspacePath("never-installed"), installation], perms: 0o755 }))

    assert.equal(modeOf(installation, "Vintagestory"), 0o755)
  })

  it.skipIf(process.platform === "win32")("does nothing at all when given no paths", () => {
    changePermissions({ paths: [], perms: 0o755 })

    assert.equal(modeOf(installation, "Vintagestory"), 0o600)
  })

  it.skipIf(process.platform === "win32")("refuses a symbolic link rather than applying the mode to what it points at", () => {
    const outsider = workspacePath("outsider.txt")
    writeFileSync(outsider, "not the launcher's file", { mode: 0o600 })
    symlinkSync(outsider, join(installation, "shortcut"))

    assert.throws(() => changePermissions({ paths: [installation], perms: 0o777 }), /Symbolic links are not allowed/)

    assert.equal(modeOf(outsider), 0o600)
  })

  it("refuses an entry that is neither a file nor a folder", () => {
    const socket = fakeStats("other")
    const fileSystem = fakeTree(
      () => socket,
      () => []
    )

    assert.throws(() => changePermissions({ paths: [FAKE_ROOT], perms: 0o755, fileSystem }), /Unsupported filesystem entry/)

    assert.deepEqual(fileSystem.chmodCalls, [])
  })

  it("refuses a tree with more entries than the cap allows", () => {
    // A real tree of 100 001 entries costs more to build than the whole suite
    // costs to run, so the walk is pointed at a fake one that claims to hold them.
    const children = Array.from({ length: 100_001 }, (_, index) => `child-${index}`)
    const fileSystem = fakeTree(
      (path) => (path === FAKE_ROOT ? FAKE_DIRECTORY : FAKE_FILE),
      () => children
    )

    assert.throws(() => changePermissions({ paths: [FAKE_ROOT], perms: 0o755, fileSystem }), /Too many filesystem entries/)
  })

  it("descends before it touches the folder it descended into", () => {
    // The order matters on a folder whose current mode would stop the walk: the
    // children are reached with the permissions the extraction left behind.
    const fileSystem = fakeTree(
      (path) => (path === FAKE_ROOT ? FAKE_DIRECTORY : FAKE_FILE),
      () => ["Vintagestory"]
    )

    changePermissions({ paths: [FAKE_ROOT], perms: 0o755, fileSystem })

    assert.deepEqual(fileSystem.chmodCalls, [
      { path: join(FAKE_ROOT, "Vintagestory"), mode: 0o755 },
      { path: FAKE_ROOT, mode: 0o755 }
    ])
  })
})
