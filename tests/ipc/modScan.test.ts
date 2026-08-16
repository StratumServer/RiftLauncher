import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

  it("refuses a modicon.png whose declared size already exceeds the 8 MiB cap", async () => {
    // modinfo.json is valid and under its own cap here, so the archive reaches
    // the icon and declaredSizeAllowed() rejects that entry's header instead.
    const { createModArchiveReaderPort } = await import("../../src/ipc/adapters/modScan")
    const readModArchive = createModArchiveReaderPort().read

    const result = await readModArchive(fixturePath("oversized-declared-icon.zip"))

    assert.deepEqual(result, { ok: false, problem: "icon-too-large" })
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
