import assert from "node:assert/strict"
import { beforeEach, describe, it } from "vitest"

import { MAX_MOD_ARCHIVES, MOD_SCAN_BATCH_SIZE, installedModsTotal, scanInstalledMods } from "../../../src/domain/mods/scanInstalled"
import type { ScanInstalledModsEvents, ScanInstalledModsPorts } from "../../../src/domain/mods/scanInstalled"
import type { DirectoryReader, IconStore, ModArchiveResult, PathBuilder } from "../../../src/domain/ports"

const FOLDER = "/installations/main/Mods"

/** Everything the fakes wrote down, in the order it happened. */
let trace: string[] = []

/** What a fake archive holds. Anything not listed here simply is not in it. */
interface FakeArchive {
  modinfo?: string
  icon?: Uint8Array
  /** Set instead of the contents when the archive itself will not read. */
  problem?: "unreadable-archive" | "modinfo-too-large" | "icon-too-large"
}

const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function modinfoText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ modid: "amod", name: "A Mod", version: "1.0.0", ...overrides })
}

const fakePaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }

function fakeDirectories(names: string[]): DirectoryReader {
  return {
    listFileNames: async (path: string): Promise<string[]> => {
      trace.push(`list:${path}`)
      return names
    }
  }
}

/**
 * An archive reader that remembers how many reads overlapped.
 *
 * Every read takes a real turn of the event loop before it settles, so reads
 * fired together in one batch genuinely overlap and the counters mean
 * something. `maxInFlight` is what the batching bound is judged on, and the
 * start and end entries in the trace are what says whether a batch had truly
 * finished before the next one started.
 */
function recordingArchives(archives: Record<string, FakeArchive>): {
  archives: { read(archivePath: string): Promise<ModArchiveResult> }
  reads: string[]
  maxInFlight: () => number
} {
  const reads: string[] = []
  let inFlight = 0
  let peak = 0

  return {
    reads,
    maxInFlight: (): number => peak,
    archives: {
      read: async (archivePath: string): Promise<ModArchiveResult> => {
        reads.push(archivePath)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        trace.push(`read-start:${archivePath}`)

        await new Promise((settle) => setTimeout(settle, 0))

        const archive = archives[archivePath] ?? {}
        inFlight -= 1
        trace.push(`read-end:${archivePath}`)

        if (archive.problem) return { ok: false, problem: archive.problem }
        return { ok: true, content: { modinfo: archive.modinfo, icon: archive.icon } }
      }
    }
  }
}

function recordingIcons(options: { failing?: boolean } = {}): { icons: IconStore; stored: Uint8Array[] } {
  const stored: Uint8Array[] = []
  let next = 0

  return {
    stored,
    icons: {
      store: async (bytes: Uint8Array): Promise<string | undefined> => {
        trace.push("icon-store")
        if (options.failing) return undefined
        stored.push(bytes)
        next += 1
        return `icon-${next}.png`
      }
    }
  }
}

/** Builds ports over a folder described as file name to archive contents. */
function fakePorts(folder: Record<string, FakeArchive>, overrides: Partial<ScanInstalledModsPorts> = {}): ScanInstalledModsPorts & { readsOf: () => string[]; peak: () => number } {
  const byPath: Record<string, FakeArchive> = {}
  for (const [name, archive] of Object.entries(folder)) byPath[`${FOLDER}/${name}`] = archive

  const recorder = recordingArchives(byPath)

  return {
    directories: fakeDirectories(Object.keys(folder)),
    archives: recorder.archives,
    icons: recordingIcons().icons,
    paths: fakePaths,
    ...overrides,
    readsOf: (): string[] => recorder.reads,
    peak: (): number => recorder.maxInFlight()
  }
}

function recordingEvents(): ScanInstalledModsEvents {
  return {
    onArchivesFound: (count): void => {
      trace.push(`found:${count}`)
    },
    onModIdentified: (mod): void => {
      trace.push(`mod:${mod.modid}`)
    },
    onArchiveUnidentified: (archive): void => {
      trace.push(`problem:${archive.zipname}:${archive.problem}`)
    }
  }
}

beforeEach(() => {
  trace = []
})

describe("scanInstalledMods folder listing", () => {
  it("reads only the archives, whatever else the folder holds", async () => {
    const ports = fakePorts({
      "amod.zip": { modinfo: modinfoText() },
      "notes.txt": {},
      "backup.zip.bak": {},
      "SHOUTED.ZIP": { modinfo: modinfoText({ modid: "shouted" }) }
    })

    const result = await scanInstalledMods(ports, { folder: FOLDER })

    assert.deepEqual(ports.readsOf(), [`${FOLDER}/amod.zip`, `${FOLDER}/SHOUTED.ZIP`])
    assert.deepEqual(
      result.mods.map((mod) => mod.modid),
      ["amod", "shouted"]
    )
  })

  it("returns nothing for a folder with nothing in it", async () => {
    const result = await scanInstalledMods(fakePorts({}), { folder: FOLDER }, recordingEvents())

    assert.deepEqual(result, { mods: [], errors: [] })
    assert.deepEqual(trace, [`list:${FOLDER}`, "found:0"])
  })

  it("stops at the bound rather than opening whatever a folder was pointed at", async () => {
    const folder: Record<string, FakeArchive> = {}
    for (let index = 0; index < MAX_MOD_ARCHIVES + 50; index += 1) folder[`mod-${index}.zip`] = {}

    const ports = fakePorts(folder)
    await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(ports.readsOf().length, MAX_MOD_ARCHIVES)
  })

  it("reads every archive exactly once", async () => {
    const folder: Record<string, FakeArchive> = {}
    for (let index = 0; index < 40; index += 1) folder[`mod-${index}.zip`] = { modinfo: modinfoText({ modid: `mod${index}` }) }

    const ports = fakePorts(folder)
    await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(ports.readsOf().length, 40)
    assert.equal(new Set(ports.readsOf()).size, 40)
  })
})

describe("installedModsTotal", () => {
  it("counts the archives the scan could not read alongside the mods it identified", () => {
    assert.equal(installedModsTotal({ mods: [1, 2, 3], errors: [4] }), 4)
  })

  it("counts nothing for an empty folder", () => {
    assert.equal(installedModsTotal({ mods: [], errors: [] }), 0)
  })

  it("counts a folder of nothing but broken archives", () => {
    assert.equal(installedModsTotal({ mods: [], errors: [1, 2] }), 2)
  })
})

describe("scanInstalledMods batching", () => {
  it("never has more archives open at once than the batch allows", async () => {
    const folder: Record<string, FakeArchive> = {}
    for (let index = 0; index < 50; index += 1) folder[`mod-${index}.zip`] = { modinfo: modinfoText({ modid: `mod${index}` }) }

    const ports = fakePorts(folder)
    await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(ports.peak(), MOD_SCAN_BATCH_SIZE)
  })

  it("fills a whole batch instead of reading one archive at a time", async () => {
    const folder: Record<string, FakeArchive> = {}
    for (let index = 0; index < MOD_SCAN_BATCH_SIZE; index += 1) folder[`mod-${index}.zip`] = { modinfo: modinfoText({ modid: `mod${index}` }) }

    const ports = fakePorts(folder)
    await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(ports.peak(), MOD_SCAN_BATCH_SIZE)
  })

  it("reports mods and problems in folder order however the reads interleaved", async () => {
    const result = await scanInstalledMods(
      fakePorts({
        "first.zip": { modinfo: modinfoText({ modid: "first" }) },
        "broken.zip": { modinfo: "{ not json" },
        "second.zip": { modinfo: modinfoText({ modid: "second" }) },
        "gone.zip": { problem: "unreadable-archive" }
      }),
      { folder: FOLDER }
    )

    assert.deepEqual(
      result.mods.map((mod) => mod.modid),
      ["first", "second"]
    )
    assert.deepEqual(
      result.errors.map((archive) => archive.zipname),
      ["broken.zip", "gone.zip"]
    )
  })
})

/**
 * The defect this slice was extracted to fix.
 *
 * The inline version resolved an archive's promise from the invalid-modinfo
 * branch without closing the archive first, and its `finally` then asked for
 * the next entry anyway. The batch counted that archive as done while it went
 * on reading, so the sixteen-at-a-time bound stopped being true and any icon
 * that read afterwards was written to the cache with no mod left to point at
 * it.
 */
describe("scanInstalledMods archives that fail to parse", () => {
  it("leaves no archive still reading once its batch is over", async () => {
    const folder: Record<string, FakeArchive> = {}
    for (let index = 0; index < MOD_SCAN_BATCH_SIZE * 2; index += 1) folder[`broken-${index}.zip`] = { modinfo: "{ not json", icon: ICON }

    const ports = fakePorts(folder)
    await scanInstalledMods(ports, { folder: FOLDER })

    const firstBatch = new Set(Object.keys(folder).slice(0, MOD_SCAN_BATCH_SIZE))
    const lastEndOfFirstBatch = trace.findLastIndex((entry) => entry.startsWith("read-end:") && firstBatch.has(entry.slice(`read-end:${FOLDER}/`.length)))
    const firstStartOfSecondBatch = trace.findIndex((entry) => entry.startsWith("read-start:") && !firstBatch.has(entry.slice(`read-start:${FOLDER}/`.length)))

    assert.equal(lastEndOfFirstBatch < firstStartOfSecondBatch, true, "a read from the first batch was still running when the second batch started")
    assert.equal(ports.peak(), MOD_SCAN_BATCH_SIZE)
  })

  it("stores no icon for an archive that turned out not to describe a mod", async () => {
    const { icons, stored } = recordingIcons()
    const ports = fakePorts({ "broken.zip": { modinfo: "{ not json", icon: ICON }, "incomplete.zip": { modinfo: modinfoText({ modid: undefined }), icon: ICON } }, { icons })

    const result = await scanInstalledMods(ports, { folder: FOLDER }, recordingEvents())

    assert.deepEqual(result.mods, [])
    assert.deepEqual(stored, [])
    assert.equal(trace.includes("icon-store"), false)
    assert.deepEqual(
      result.errors.map((archive) => archive.problem),
      ["modinfo-invalid", "modinfo-incomplete"]
    )
  })

  it("counts a failed archive exactly once in the errors", async () => {
    const result = await scanInstalledMods(fakePorts({ "broken.zip": { modinfo: "{ not json", icon: ICON } }), { folder: FOLDER })

    assert.equal(result.errors.length, 1)
    assert.deepEqual(result.errors[0], { zipname: "broken.zip", path: `${FOLDER}/broken.zip`, problem: "modinfo-invalid" })
  })
})

describe("scanInstalledMods problem kinds", () => {
  it("names each way an archive can fail apart from the others", async () => {
    const result = await scanInstalledMods(
      fakePorts({
        "gone.zip": { problem: "unreadable-archive" },
        "huge-info.zip": { problem: "modinfo-too-large" },
        "resources.zip": {},
        "broken.zip": { modinfo: "{ not json" },
        "nameless.zip": { modinfo: JSON.stringify({ version: "1.0.0" }) }
      }),
      { folder: FOLDER }
    )

    assert.deepEqual(
      result.errors.map((archive) => `${archive.zipname}:${archive.problem}`),
      ["gone.zip:unreadable-archive", "huge-info.zip:modinfo-too-large", "resources.zip:modinfo-missing", "broken.zip:modinfo-invalid", "nameless.zip:modinfo-incomplete"]
    )
  })

  it("lists a mod with an oversized declared icon without an icon, not as an error", async () => {
    const result = await scanInstalledMods(
      fakePorts({
        "huge-icon.zip": { modinfo: modinfoText({ modid: "hugeicon" }) },
        "normal.zip": { modinfo: modinfoText({ modid: "normal" }), icon: ICON }
      }),
      { folder: FOLDER }
    )

    assert.deepEqual(
      result.errors.map((e) => e.zipname),
      []
    )
    assert.deepEqual(
      result.mods.map((m) => ({ id: m.modid, hasIcon: m.image !== undefined })),
      [
        { id: "hugeicon", hasIcon: false },
        { id: "normal", hasIcon: true }
      ]
    )
  })

  it("tells an archive with no metadata apart from one whose metadata is broken", async () => {
    const result = await scanInstalledMods(fakePorts({ "resources.zip": { icon: ICON }, "broken.zip": { modinfo: "nope" } }), { folder: FOLDER })

    assert.equal(result.errors[0]?.problem, "modinfo-missing")
    assert.equal(result.errors[1]?.problem, "modinfo-invalid")
  })
})

describe("scanInstalledMods icons", () => {
  it("stores the icon of an identified mod and keeps the name it was given", async () => {
    const { icons, stored } = recordingIcons()
    const ports = fakePorts({ "amod.zip": { modinfo: modinfoText(), icon: ICON } }, { icons })

    const result = await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(result.mods[0]?.image, "icon-1.png")
    assert.deepEqual(stored, [ICON])
  })

  it("lists a mod whose archive carries no icon", async () => {
    const result = await scanInstalledMods(fakePorts({ "amod.zip": { modinfo: modinfoText() } }), { folder: FOLDER })

    assert.equal(result.mods.length, 1)
    assert.equal(result.mods[0]?.image, undefined)
  })

  it("still lists a mod whose icon could not be stored", async () => {
    const { icons } = recordingIcons({ failing: true })
    const ports = fakePorts({ "amod.zip": { modinfo: modinfoText(), icon: ICON } }, { icons })

    const result = await scanInstalledMods(ports, { folder: FOLDER })

    assert.equal(result.mods.length, 1)
    assert.equal(result.mods[0]?.image, undefined)
    assert.deepEqual(result.errors, [])
  })
})

describe("scanInstalledMods results", () => {
  it("carries the metadata and the archive path through to the mod", async () => {
    const result = await scanInstalledMods(fakePorts({ "amod.zip": { modinfo: modinfoText({ description: "Does things", side: "universal", authors: ["Alice"], type: "code" }) } }), { folder: FOLDER })

    assert.deepEqual(result.mods[0], {
      modid: "amod",
      name: "A Mod",
      version: "1.0.0",
      path: `${FOLDER}/amod.zip`,
      description: "Does things",
      side: "universal",
      authors: ["Alice"],
      contributors: undefined,
      type: "code"
    })
  })

  it("keeps the good archives when the folder also holds bad ones", async () => {
    const result = await scanInstalledMods(
      fakePorts({
        "good-1.zip": { modinfo: modinfoText({ modid: "good1" }) },
        "gone.zip": { problem: "unreadable-archive" },
        "good-2.zip": { modinfo: modinfoText({ modid: "good2" }) }
      }),
      { folder: FOLDER }
    )

    assert.equal(result.mods.length, 2)
    assert.equal(result.errors.length, 1)
  })

  it("tells the caller what it found, in the order it settled it", async () => {
    await scanInstalledMods(fakePorts({ "amod.zip": { modinfo: modinfoText() }, "gone.zip": { problem: "unreadable-archive" } }), { folder: FOLDER }, recordingEvents())

    assert.deepEqual(trace.slice(-2), ["mod:amod", "problem:gone.zip:unreadable-archive"])
    assert.equal(trace[1], "found:2")
  })
})
