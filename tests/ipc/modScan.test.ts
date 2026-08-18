import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import fse from "fs-extra"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { setElectronUserDataPath } from "./helpers/electronMock"

import type { ModArchiveResult } from "../../src/domain/ports"

/**
 * Exercises src/ipc/adapters/modScan.ts against real zip bytes, per issue #27:
 * both `readModArchive` and `createIconStorePort` import `electron` at module
 * load, so nothing here could previously run outside a live main process, and
 * the yauzl edge cases (fixture order, a lying declared size, zip64) were only
 * covered indirectly through the domain's fakes.
 *
 * Fixtures are hand-built by tests/fixtures/build-fixtures.ts and committed as
 * binary; that script is the record of what each one contains.
 */

function fixturePath(name: string): string {
  return resolve(__dirname, "../fixtures", name)
}

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rift-modscan-"))
  setElectronUserDataPath(workspace)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("readModArchive", () => {
  it("reads a well formed mod: modinfo.json and modicon.png both under their caps", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("valid-mod.zip"))

    assert.equal(result.ok, true)
    const content = (result as Extract<ModArchiveResult, { ok: true }>).content
    assert.equal(content.modinfo, JSON.stringify({ modid: "riftfixture", name: "Rift Fixture Mod", version: "1.0.0" }))
    assert.deepEqual(content.icon, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-icon-not-a-real-png")]))
  })

  it("leaves content.icon undefined when the archive carries no modicon.png", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("modinfo-only.zip"))

    assert.deepEqual(result, {
      ok: true,
      content: { modinfo: JSON.stringify({ modid: "riftfixture", name: "Rift Fixture Mod", version: "1.0.0" }) }
    })
  })

  it("reads the same result regardless of which entry the archive lists first", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const inOrder = await readModArchive(fixturePath("valid-mod.zip"))
    const reordered = await readModArchive(fixturePath("icon-before-modinfo.zip"))

    assert.deepEqual(reordered, inOrder)
  })

  it("carries modinfo.json's text through even when it is not valid JSON", async () => {
    // readModArchive only pulls bytes out of the archive; parsing modinfo.json is
    // src/domain/mods/modinfo.ts's job, not this adapter's. A malformed file here
    // still has to come back as `ok: true` with the malformed text intact.
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("invalid-json-modinfo.zip"))

    assert.deepEqual(result, { ok: true, content: { modinfo: "not valid json {{{" } })
  })

  it("refuses a modinfo.json whose declared size already exceeds the 1 MiB cap", async () => {
    // declaredSizeAllowed() rejects this from the entry's header alone, before a
    // stream is ever opened onto the archive.
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("oversized-declared-modinfo.zip"))

    assert.deepEqual(result, { ok: false, problem: "modinfo-too-large" })
  })

  it("skips the icon when its declared size exceeds the 512 KiB cap", async () => {
    // modinfo.json is valid and under its own cap here, so the archive reaches
    // the icon. The declared size exceeds the limit, so the icon is skipped and
    // the mod appears without a picture rather than failing the archive.
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("oversized-declared-icon.zip"))

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.notEqual(result.content.modinfo, undefined)
      assert.equal(result.content.icon, undefined)
    }
  })

  it("refuses a file with no zip structure in it at all", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("not-a-zip.bin"))

    assert.deepEqual(result, { ok: false, problem: "unreadable-archive" })
  })

  it("reads a mod located through a Zip64 End of Central Directory Record", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("zip64.zip"))

    assert.deepEqual(result, {
      ok: true,
      content: { modinfo: JSON.stringify({ modid: "riftfixture", name: "Rift Fixture Mod", version: "1.0.0" }) }
    })
  })

  /**
   * The regression PR #25 fixed: the pre-fix code's oversize guard called
   * `stream.destroy()` without going through the archive's single settle
   * point, and a destroyed stream emits neither `end` nor `error`, so an
   * archive that lied about a declared size hung the whole scan on that one
   * archive.
   *
   * understated-size-modinfo.zip's modinfo.json declares an uncompressedSize
   * of 10 bytes but actually decompresses to far more (see
   * tests/fixtures/build-fixtures.ts for why this needs DEFLATE and cannot be
   * built as a STORE entry). This does not wait on the test runner's own
   * default timeout to prove the point: `vi.waitFor` polls for the promise to
   * have settled inside an explicit, short bound, so a regression here fails
   * fast with a clear reason instead of a generic multi-second timeout.
   */
  it("settles instead of hanging when a DEFLATE entry's declared size understates its real one", async () => {
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    let result: ModArchiveResult | undefined
    let rejection: unknown
    readModArchive(fixturePath("understated-size-modinfo.zip"))
      .then((settled) => (result = settled))
      .catch((err: unknown) => (rejection = err))

    await vi.waitFor(
      () => {
        if (result === undefined && rejection === undefined) throw new Error("readModArchive has not settled yet")
      },
      { timeout: 2000, interval: 25 }
    )

    assert.equal(rejection, undefined)
    assert.deepEqual(result, { ok: false, problem: "unreadable-archive" })
  })
})

describe("createIconStorePort", () => {
  it("writes the icon under the mocked userData path and hands back its name", async () => {
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()
    const bytes = new Uint8Array([1, 2, 3, 4])

    const name = await store.store(bytes)

    assert.ok(name?.endsWith(".png"))
    const written = readFileSync(join(workspace, "Cache", "Images", "Mods", name as string))
    assert.deepEqual(written, Buffer.from(bytes))
  })

  it("names each stored icon apart from the others", async () => {
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()

    const first = await store.store(new Uint8Array([1]))
    const second = await store.store(new Uint8Array([2]))

    assert.notEqual(first, second)
  })

  it("names an icon by the sha256 of its own bytes", async () => {
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()
    const bytes = new Uint8Array([5, 6, 7, 8])

    const name = await store.store(bytes)

    assert.equal(name, `${createHash("sha256").update(bytes).digest("hex")}.png`)
  })

  it("stores the same bytes once no matter how many times they are scanned", async () => {
    // Per issue #26: content-addressed names are what makes a rescan idempotent
    // instead of writing a fresh uuid-named copy every time it runs.
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()
    const bytes = new Uint8Array([1, 1, 2, 3, 5, 8])

    const first = await store.store(bytes)
    const second = await store.store(bytes)
    const third = await store.store(bytes)

    assert.equal(first, second)
    assert.equal(second, third)
    assert.deepEqual(readdirSync(join(workspace, "Cache", "Images", "Mods")), [first])
  })

  it("touches an icon it already holds instead of rewriting it", async () => {
    // The timestamp is what the startup sweep sorts on, so an icon a scan still
    // points at has to look freshly used even though nothing was written.
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()
    const bytes = new Uint8Array([2, 3, 5, 7])

    const name = await store.store(bytes)
    const target = join(workspace, "Cache", "Images", "Mods", name as string)
    fse.utimesSync(target, new Date(1_000), new Date(1_000))

    await store.store(bytes)

    assert.ok(statSync(target).mtimeMs > 1_000)
    assert.deepEqual(readFileSync(target), Buffer.from(bytes))
  })

  it("tolerates a write failure by resolving undefined instead of throwing", async () => {
    // fse.ensureDir("<userData>/Cache/Images/Mods") fails when "Cache" already
    // exists as a plain file: there is nowhere to create a directory under a
    // path component that is not a directory. This reaches the store()
    // function's own catch branch without touching its source.
    writeFileSync(join(workspace, "Cache"), "not a directory")
    const { createIconStorePort } = await import("../../src/ipc/adapters/modScan")
    const store = createIconStorePort()

    const name = await store.store(new Uint8Array([1, 2, 3]))

    assert.equal(name, undefined)
    assert.equal(existsSync(join(workspace, "Cache", "Images")), false)
  })
})

describe("pruneModIconCache", () => {
  function iconsFolder(): string {
    return join(workspace, "Cache", "Images", "Mods")
  }

  /** Writes a file straight into the cache folder, with a timestamp of its own. */
  function seedIcon(name: string, bytes: number, modifiedAt: number): string {
    fse.ensureDirSync(iconsFolder())
    const target = join(iconsFolder(), name)
    writeFileSync(target, Buffer.alloc(bytes, 1))
    fse.utimesSync(target, new Date(modifiedAt), new Date(modifiedAt))
    return name
  }

  /** A content-addressed name of the shape the store writes, seeded from one character. */
  function contentName(seed: string): string {
    return `${seed.repeat(64).slice(0, 64)}.png`
  }

  it("removes the uuid-named files an older build left behind", async () => {
    // Per issue #117: this is the one deletion rule that cannot take an icon
    // another installation is still pointing at, since no write can produce a
    // uuid name any more.
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")
    const legacy = seedIcon("2f8a6d3c-7b1e-4a55-9d20-0c5f4e6b8a91.png", 16, 1_000)
    const kept = seedIcon(contentName("a"), 16, 1_000)

    await pruneModIconCache()

    assert.deepEqual(readdirSync(iconsFolder()), [kept])
    assert.equal(existsSync(join(iconsFolder(), legacy)), false)
  })

  it("keeps every content-named icon while the folder fits the budget", async () => {
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")
    const first = seedIcon(contentName("a"), 32, 1_000)
    const second = seedIcon(contentName("b"), 32, 2_000)

    await pruneModIconCache()

    assert.deepEqual(new Set(readdirSync(iconsFolder())), new Set([first, second]))
  })

  it("drops the least recently scanned icons once the folder is over budget", async () => {
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")
    const oldest = seedIcon(contentName("a"), 32, 1_000)
    const newest = seedIcon(contentName("b"), 32, 9_000)

    await pruneModIconCache(48)

    assert.deepEqual(readdirSync(iconsFolder()), [newest])
    assert.equal(existsSync(join(iconsFolder(), oldest)), false)
  })

  it("does nothing when the cache folder was never created", async () => {
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")

    await assert.doesNotReject(async () => pruneModIconCache())
    assert.equal(existsSync(iconsFolder()), false)
  })

  it("never fails the sweep when one removal errors out", async () => {
    // Stands in for a concurrent delete racing this sweep: whatever the reason
    // one removal rejects, the sweep is best effort and must not let that reach
    // the startup path that fired it.
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")
    const legacy = seedIcon("legacy-icon.png", 16, 1_000)

    vi.spyOn(fse, "remove").mockRejectedValueOnce(new Error("locked by another process"))

    await assert.doesNotReject(async () => pruneModIconCache())
    // The failed removal really did fail: the file is still there, proving this
    // exercised the catch branch rather than the removal quietly working.
    assert.equal(existsSync(join(iconsFolder(), legacy)), true)
  })

  it("never deletes anything outside its own cache folder", async () => {
    // A sibling file next to the cache folder, same tree depth as a would-be
    // "../escape.png" entry, proves the sweep only ever acts on names readdir
    // handed back for modImagesFolder() itself.
    const sentinel = join(workspace, "Cache", "Images", "sentinel.png")
    fse.ensureDirSync(join(workspace, "Cache", "Images"))
    writeFileSync(sentinel, "not a mod icon")
    const { pruneModIconCache } = await import("../../src/ipc/adapters/modScan")
    seedIcon("legacy-icon.png", 16, 1_000)

    await pruneModIconCache(0)

    assert.equal(existsSync(sentinel), true)
  })
})
