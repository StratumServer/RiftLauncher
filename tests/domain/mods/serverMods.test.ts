import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MAX_SERVER_MOD_ARCHIVES, MAX_SERVER_MOD_FOLDERS, MODS_BY_SERVER_FOLDER_NAME, modsByServerFolder, scanServerMods } from "../../../src/domain/mods/serverMods"
import type { ScanInstalledModsPorts } from "../../../src/domain/mods/scanInstalled"
import type { DirectoryReader, IconStore, ModArchiveResult, PathBuilder } from "../../../src/domain/ports"

const INSTALLATION = "/installations/main"
const FOLDER = `${INSTALLATION}/${MODS_BY_SERVER_FOLDER_NAME}`

const fakePaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }
const fakeIcons: IconStore = { store: async (): Promise<string | undefined> => undefined }

function modinfoText(modid: string): string {
  return JSON.stringify({ modid, name: `${modid} Mod`, version: "1.0.0" })
}

/**
 * Ports over a fake tree: a map of folder path to the entry names it holds, and a map of archive
 * path to the modid it describes (or `null` for an archive that will not read).
 *
 * A folder missing from `tree` throws on listing, which is what the real reader does for a plain
 * file: `readdir` on one rejects with ENOTDIR.
 */
function fakePorts(tree: Record<string, string[]>, archives: Record<string, string | null> = {}): ScanInstalledModsPorts {
  const directories: DirectoryReader = {
    listFileNames: async (path: string): Promise<string[]> => {
      const names = tree[path]
      if (names === undefined) throw new Error(`ENOTDIR: ${path}`)
      return names
    }
  }

  return {
    directories,
    paths: fakePaths,
    icons: fakeIcons,
    archives: {
      read: async (archivePath: string): Promise<ModArchiveResult> => {
        const modid = archives[archivePath]
        if (modid === undefined || modid === null) return { ok: false, problem: "unreadable-archive" }
        return { ok: true, content: { modinfo: modinfoText(modid) } }
      }
    }
  }
}

describe("modsByServerFolder", () => {
  it("names the game's own folder beside the installation's Mods", async () => {
    assert.equal(await modsByServerFolder(fakePaths, INSTALLATION), FOLDER)
  })
})

describe("scanServerMods", () => {
  it("answers nothing for a ModsByServer folder that holds no server folder", async () => {
    const scan = await scanServerMods(fakePorts({ [FOLDER]: [] }), { folder: FOLDER })

    assert.deepEqual(scan, { groups: [], truncated: false })
  })

  it("sorts the servers by name and reads each folder's mods", async () => {
    const scan = await scanServerMods(
      fakePorts(
        {
          [FOLDER]: ["zulu", "alpha", "Mike"],
          [`${FOLDER}/alpha`]: ["one.zip"],
          [`${FOLDER}/Mike`]: ["two.zip"],
          [`${FOLDER}/zulu`]: ["three.zip"]
        },
        { [`${FOLDER}/alpha/one.zip`]: "one", [`${FOLDER}/Mike/two.zip`]: "two", [`${FOLDER}/zulu/three.zip`]: "three" }
      ),
      { folder: FOLDER }
    )

    assert.deepEqual(
      scan.groups.map((group) => group.server),
      ["alpha", "Mike", "zulu"]
    )
    assert.equal(scan.groups[0].path, `${FOLDER}/alpha`)
    assert.deepEqual(
      scan.groups.map((group) => group.mods.map((mod) => mod.modid)),
      [["one"], ["two"], ["three"]]
    )
    assert.equal(scan.truncated, false)
  })

  it("keeps an empty server folder as a group, because an empty folder is still a folder to clear", async () => {
    const scan = await scanServerMods(fakePorts({ [FOLDER]: ["My Test Server"], [`${FOLDER}/My Test Server`]: [] }), { folder: FOLDER })

    assert.deepEqual(scan.groups, [{ server: "My Test Server", path: `${FOLDER}/My Test Server`, mods: [], unreadable: 0 }])
  })

  it("keeps a server folder holding nothing the game would load", async () => {
    const scan = await scanServerMods(fakePorts({ [FOLDER]: ["srv"], [`${FOLDER}/srv`]: ["notes.txt", "cache.dat"] }), { folder: FOLDER })

    assert.deepEqual(scan.groups, [{ server: "srv", path: `${FOLDER}/srv`, mods: [], unreadable: 0 }])
  })

  it("drops an entry that is not a folder at all rather than offering it as a group", async () => {
    const scan = await scanServerMods(fakePorts({ [FOLDER]: ["notes.txt", "srv"], [`${FOLDER}/srv`]: [] }), { folder: FOLDER })

    assert.deepEqual(
      scan.groups.map((group) => group.server),
      ["srv"]
    )
  })

  it("counts the archives it could not read without naming one", async () => {
    const scan = await scanServerMods(fakePorts({ [FOLDER]: ["srv"], [`${FOLDER}/srv`]: ["good.zip", "torn.zip"] }, { [`${FOLDER}/srv/good.zip`]: "good", [`${FOLDER}/srv/torn.zip`]: null }), {
      folder: FOLDER
    })

    assert.equal(scan.groups[0].mods.length, 1)
    assert.equal(scan.groups[0].unreadable, 1)
  })

  it("stops at the folder cap and says there is more on disk", async () => {
    const servers = Array.from({ length: MAX_SERVER_MOD_FOLDERS + 3 }, (_, index) => `server-${String(index).padStart(3, "0")}`)
    const tree: Record<string, string[]> = { [FOLDER]: servers }
    for (const server of servers) tree[`${FOLDER}/${server}`] = []

    const scan = await scanServerMods(fakePorts(tree), { folder: FOLDER })

    assert.equal(scan.groups.length, MAX_SERVER_MOD_FOLDERS)
    assert.equal(scan.truncated, true)
  })

  it("stops once the archives across every folder reach the total cap", async () => {
    const perFolder = MAX_SERVER_MOD_ARCHIVES / 2
    const archiveNames = Array.from({ length: perFolder }, (_, index) => `mod-${index}.zip`)
    const servers = ["a", "b", "c"]

    const tree: Record<string, string[]> = { [FOLDER]: servers }
    const archives: Record<string, string> = {}
    for (const server of servers) {
      tree[`${FOLDER}/${server}`] = archiveNames
      for (const name of archiveNames) archives[`${FOLDER}/${server}/${name}`] = `${server}-${name}`
    }

    const scan = await scanServerMods(fakePorts(tree, archives), { folder: FOLDER })

    // The third folder is never opened: the first two already reached the cap.
    assert.deepEqual(
      scan.groups.map((group) => group.server),
      ["a", "b"]
    )
    assert.equal(scan.truncated, true)
  })

  it("does not claim there is more on disk when the last folder is what reached the cap", async () => {
    const archiveNames = Array.from({ length: MAX_SERVER_MOD_ARCHIVES }, (_, index) => `mod-${index}.zip`)
    const archives: Record<string, string> = {}
    for (const name of archiveNames) archives[`${FOLDER}/only/${name}`] = name

    const scan = await scanServerMods(fakePorts({ [FOLDER]: ["only"], [`${FOLDER}/only`]: archiveNames }, archives), { folder: FOLDER })

    assert.equal(scan.groups.length, 1)
    assert.equal(scan.truncated, false)
  })
})
