import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fse from "fs-extra"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

// netHandlers.ts (via network.ts, ipcSecurity.ts) and catalogCache.ts all import from
// "electron". None of it is available outside a real Electron process, so every entry
// point used transitively must be mocked here. State that the mock factory closes over
// must be created with vi.hoisted, since vi.mock factories run before this file's own
// top-level `let`/`const` bindings are initialized.
const mockState = vi.hoisted(() => ({
  userDataDir: "",
  requestHandler: (options: unknown): FakeRequest => {
    void options
    throw new Error("no fake request handler configured for this test")
  }
}))

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => (name === "userData" ? mockState.userDataDir : tmpdir()),
    isPackaged: true
  },
  ipcMain: { handle: vi.fn() },
  net: { request: (options: unknown): FakeRequest => mockState.requestHandler(options) }
}))

class FakeResponse extends EventEmitter {
  headers: Record<string, string>
  statusCode?: number

  constructor(headers: Record<string, string>, statusCode: number) {
    super()
    this.headers = headers
    this.statusCode = statusCode
  }
}

type RequestScenario =
  | { kind: "success"; body: string; declaredContentLength?: number }
  | { kind: "status-error"; statusCode: number }
  | { kind: "request-error"; message: string }
  | { kind: "oversized-header"; contentLength: number }

class FakeRequest extends EventEmitter {
  aborted = false

  constructor(private readonly scenario: RequestScenario) {
    super()
  }

  setHeader(): void {
    // no-op: headers are irrelevant to these tests
  }

  abort(): void {
    this.aborted = true
  }

  end(): void {
    const scenario = this.scenario

    if (scenario.kind === "request-error") {
      this.emit("error", new Error(scenario.message))
      return
    }

    const declaredContentLength = scenario.kind === "oversized-header" ? scenario.contentLength : scenario.kind === "success" ? scenario.declaredContentLength : undefined
    const headers: Record<string, string> = declaredContentLength === undefined ? {} : { "content-length": String(declaredContentLength) }
    const statusCode = scenario.kind === "status-error" ? scenario.statusCode : 200
    const response = new FakeResponse(headers, statusCode)
    this.emit("response", response)

    if (scenario.kind === "success") {
      response.emit("data", Buffer.from(scenario.body, "utf8"))
      response.emit("end")
    }
  }
}

function respondWith(scenario: RequestScenario): void {
  mockState.requestHandler = (): FakeRequest => new FakeRequest(scenario)
}

const CATALOG_URL = "https://mods.vintagestory.at/api/mods"
const TAGS_URL = "https://mods.vintagestory.at/api/tags"

/** Where catalogCache.ts writes, derived the same way getCacheDirectory() does. */
function cacheDirectory(): string {
  return join(mockState.userDataDir, "Cache", "ModCatalog")
}

describe("mod catalog disk cache and serve-stale (issue #24)", () => {
  beforeEach(() => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-catalog-cache-"))
  })

  afterEach(() => {
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

  /**
   * Backdates the one entry in the cache folder, mtime and atime alike, so a test can
   * reach readCatalogCache with a body that is genuinely old rather than one written a
   * millisecond earlier.
   */
  function ageTheOnlyCacheEntry(ageMs: number): void {
    const [name] = readdirSync(cacheDirectory())
    assert.ok(name, "expected exactly one cache entry to age")
    const aged = new Date(Date.now() - ageMs)
    fse.utimesSync(join(cacheDirectory(), name), aged, aged)
  }

  /** Older than any TTL anyone has proposed for this cache, including the 30 days this branch removed. */
  const A_MONTH_MS = 31 * 24 * 60 * 60 * 1_000

  it("writes the catalog response to disk on a successful fetch and serves it back verbatim", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { readCatalogCache } = await import("@src/ipc/catalogCache")

    respondWith({ kind: "success", body: '{"mods":[{"modid":"a"}]}' })
    const text = await queryUrl(CATALOG_URL)
    assert.equal(text, '{"mods":[{"modid":"a"}]}')

    const cached = await readCatalogCache(new URL(CATALOG_URL))
    assert.equal(cached, '{"mods":[{"modid":"a"}]}')
  })

  it("serves the last good cached catalog response, with a warning, when the fresh fetch fails", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { writeCatalogCache } = await import("@src/ipc/catalogCache")

    await writeCatalogCache(new URL(CATALOG_URL), '{"mods":[{"modid":"stale-but-good"}]}')

    const warnSpy = vi.spyOn(await import("@src/utils/logManager"), "logMessage")
    respondWith({ kind: "request-error", message: "network is down" })

    const text = await queryUrl(CATALOG_URL)
    assert.equal(text, '{"mods":[{"modid":"stale-but-good"}]}')
    assert.ok(warnSpy.mock.calls.some(([level]) => level === "warn"))
  })

  it("serves an entry nobody has re-fetched in a month, because age is what the offline fallback is for", async () => {
    // Every other test on this path reads a body written milliseconds earlier, so an age
    // check bolted onto readCatalogCache would pass all of them. This one holds the read
    // path to what the cache exists for: a player who has not browsed mods since last
    // month, launching with no network, still gets the mod browser.
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { writeCatalogCache } = await import("@src/ipc/catalogCache")

    await writeCatalogCache(new URL(CATALOG_URL), '{"mods":[{"modid":"seeded-a-month-ago"}]}')
    ageTheOnlyCacheEntry(A_MONTH_MS)

    respondWith({ kind: "request-error", message: "network is down" })
    assert.equal(await queryUrl(CATALOG_URL), '{"mods":[{"modid":"seeded-a-month-ago"}]}')
  })

  it("keeps that month-old entry through the startup sweep at the production budget and still serves it", async () => {
    // The real launch order: pruneModCatalogCache() runs from main/index.ts before the
    // player ever opens the mod browser. At the 64 MiB default a folder holding one
    // small entry is nowhere near budget, so the sweep evicts nothing and the read
    // path still has its fallback.
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { pruneModCatalogCache, writeCatalogCache } = await import("@src/ipc/catalogCache")

    await writeCatalogCache(new URL(CATALOG_URL), '{"mods":[{"modid":"seeded-a-month-ago"}]}')
    ageTheOnlyCacheEntry(A_MONTH_MS)

    await pruneModCatalogCache()
    assert.equal(readdirSync(cacheDirectory()).length, 1)

    respondWith({ kind: "request-error", message: "network is down" })
    assert.equal(await queryUrl(CATALOG_URL), '{"mods":[{"modid":"seeded-a-month-ago"}]}')
  })

  it("still throws on a cache miss when the fetch fails", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    respondWith({ kind: "request-error", message: "network is down" })
    await assert.rejects(() => queryUrl(CATALOG_URL), /network is down/)
  })

  it("degrades to the plain failure path when the cache file is corrupt or unreadable", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { writeCatalogCache } = await import("@src/ipc/catalogCache")

    await writeCatalogCache(new URL(CATALOG_URL), '{"mods":[{"modid":"will-be-corrupted"}]}')

    const [cacheFile] = readdirSync(cacheDirectory())
    assert.ok(cacheFile, "expected a cache file to exist before corrupting it")
    writeFileSync(join(cacheDirectory(), cacheFile), "{ not valid json", "utf8")

    respondWith({ kind: "request-error", message: "network is down" })
    await assert.rejects(() => queryUrl(CATALOG_URL), /network is down/)
  })

  it("only caches the mods-catalog endpoint, not other allow-listed API endpoints", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { readCatalogCache } = await import("@src/ipc/catalogCache")

    respondWith({ kind: "success", body: '["tag-a","tag-b"]' })
    await queryUrl(TAGS_URL)

    const cached = await readCatalogCache(new URL(TAGS_URL))
    assert.equal(cached, null)

    respondWith({ kind: "request-error", message: "network is down" })
    await assert.rejects(() => queryUrl(TAGS_URL), /network is down/)
  })

  it("honors the per-endpoint ceiling: the generic 4 MB bound refuses a catalog-sized response on other endpoints", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    // A declared content-length above the generic ceiling (4 MB) but below the catalog's
    // 16 MB ceiling. On a generic endpoint this must be refused outright.
    respondWith({ kind: "oversized-header", contentLength: 5 * 1024 * 1024 })
    await assert.rejects(() => queryUrl(TAGS_URL), /too large/)
  })

  it("honors the per-endpoint ceiling: the mods-catalog endpoint is allowed up to its own bound", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    // Same declared size (5 MB) is within the catalog's raised ceiling, so the request
    // proceeds instead of being refused outright.
    respondWith({ kind: "success", body: "ok", declaredContentLength: 5 * 1024 * 1024 })
    const text = await queryUrl(CATALOG_URL)
    assert.equal(text, "ok")
  })
})

describe("pruneModCatalogCache", () => {
  beforeEach(() => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-catalog-cache-"))
  })

  afterEach(() => {
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
    // The mtime-moved test spies on fse.stat with a persistent implementation. Without
    // this, that spy leaks into whichever test vitest schedules next.
    vi.restoreAllMocks()
  })

  /** Writes a file straight into the cache folder, with a timestamp of its own. */
  function seedEntry(name: string, bytes: number, modifiedAt: number): string {
    fse.ensureDirSync(cacheDirectory())
    const target = join(cacheDirectory(), name)
    writeFileSync(target, Buffer.alloc(bytes, 1))
    fse.utimesSync(target, new Date(modifiedAt), new Date(modifiedAt))
    return name
  }

  /** A content-addressed name of the shape catalogCache.ts writes, seeded from one character. */
  function contentName(seed: string): string {
    return `${seed.repeat(64).slice(0, 64)}.json`
  }

  it("keeps every entry while the folder fits the budget", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const first = seedEntry(contentName("a"), 32, Date.now())
    const second = seedEntry(contentName("b"), 32, Date.now())

    await pruneModCatalogCache()

    assert.deepEqual(new Set(readdirSync(cacheDirectory())), new Set([first, second]))
  })

  it("drops the least recently written entries once the folder is over the byte budget", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const oldest = seedEntry(contentName("a"), 32, Date.now() - 60_000)
    const newest = seedEntry(contentName("b"), 32, Date.now())

    await pruneModCatalogCache(48)

    assert.deepEqual(readdirSync(cacheDirectory()), [newest])
    assert.equal(existsSync(join(cacheDirectory(), oldest)), false)
  })

  it("keeps old entries when the folder is under the byte budget", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const old = seedEntry(contentName("a"), 16, Date.now() - 40 * 24 * 60 * 60 * 1_000)
    const recent = seedEntry(contentName("b"), 16, Date.now())

    await pruneModCatalogCache(64 * 1024 * 1024)

    assert.deepEqual(readdirSync(cacheDirectory()).sort(), [old, recent])
  })

  it("never touches a write-file-atomic temp file, only complete <hash>.json entries", async () => {
    // catalogCache.ts's own writes go through write-file-atomic, which leaves a
    // `<hash>.json.<pid>` sibling while a write is in flight (and behind after a
    // crash). Removing that here would race an in-flight write; it is
    // orphanedTempFiles.ts's job, age-gated at a week, not this sweep's.
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const tempLeftover = seedEntry(`${contentName("a")}.482910`, 16, 1_000)

    await pruneModCatalogCache(0)

    assert.equal(existsSync(join(cacheDirectory(), tempLeftover)), true)
  })

  it("does nothing when the cache folder was never created", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")

    await assert.doesNotReject(async () => pruneModCatalogCache())
    assert.equal(existsSync(cacheDirectory()), false)
  })

  it("never fails the sweep when one removal errors out", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const doomed = seedEntry(contentName("a"), 16, 1_000)

    vi.spyOn(fse, "remove").mockRejectedValueOnce(new Error("locked by another process"))

    await assert.doesNotReject(async () => pruneModCatalogCache(0))
    // The failed removal really did fail: the file is still there, proving this
    // exercised the catch branch rather than the removal quietly working.
    assert.equal(existsSync(join(cacheDirectory(), doomed)), true)
  })

  it("skips removal when mtime moved since the snapshot (a concurrent fetch just rewrote it)", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    const name = seedEntry(contentName("a"), 16, 1_000)

    const originalStat = fse.stat.bind(fse)
    let statCount = 0
    vi.spyOn(fse, "stat").mockImplementation(async (path: unknown) => {
      statCount++
      const result = await originalStat(String(path))
      // On the second stat of the same file (the re-stat right before removal),
      // report a newer mtime to simulate a concurrent fetch rewriting it.
      if (statCount > 1 && String(path).includes(contentName("a"))) {
        return { ...result, mtimeMs: 9_000 }
      }
      return result
    })

    await pruneModCatalogCache(0)

    assert.equal(existsSync(join(cacheDirectory(), name)), true)
  })

  it("skips a directory named like an entry instead of removing it", async () => {
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    // The seed has to be hex. CONTENT_ADDRESSED_NAME is /^[0-9a-f]{64}\.json$/, so a name
    // built from "dir" is rejected by the readdir filter before fse.stat ever runs and the
    // isFile() guard never gets a say. A name of 64 "d"s reaches the guard.
    const dirName = contentName("d")
    const nested = join(cacheDirectory(), dirName, "inner.json")
    fse.ensureDirSync(join(cacheDirectory(), dirName))
    writeFileSync(nested, "a real file, removed along with its parent if the guard goes")
    const doomed = seedEntry(contentName("a"), 16, 1_000)

    await pruneModCatalogCache(0)

    // The sweep ran and evicted what it was allowed to evict.
    assert.equal(existsSync(join(cacheDirectory(), doomed)), false)
    // The directory's name matched and its stat ran, but isFile() is false, so it never
    // entered the candidate list. It is neither counted toward the budget nor named for
    // removal, and the file underneath it survives with it.
    assert.equal(fse.lstatSync(join(cacheDirectory(), dirName)).isDirectory(), true)
    assert.equal(existsSync(nested), true)
  })

  it("never deletes anything outside its own cache folder", async () => {
    const sentinel = join(mockState.userDataDir, "Cache", "sentinel.json")
    fse.ensureDirSync(join(mockState.userDataDir, "Cache"))
    writeFileSync(sentinel, "not a catalog cache entry")
    const { pruneModCatalogCache } = await import("@src/ipc/catalogCache")
    seedEntry(contentName("a"), 16, 1_000)

    await pruneModCatalogCache(0)

    assert.equal(existsSync(sentinel), true)
  })
})
