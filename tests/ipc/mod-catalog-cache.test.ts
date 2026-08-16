import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe("mod catalog disk cache and serve-stale (issue #24)", () => {
  beforeEach(() => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-catalog-cache-"))
  })

  afterEach(() => {
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

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

  it("still throws on a cache miss when the fetch fails", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    respondWith({ kind: "request-error", message: "network is down" })
    await assert.rejects(() => queryUrl(CATALOG_URL), /network is down/)
  })

  it("degrades to the plain failure path when the cache file is corrupt or unreadable", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")
    const { writeCatalogCache } = await import("@src/ipc/catalogCache")

    await writeCatalogCache(new URL(CATALOG_URL), '{"mods":[{"modid":"will-be-corrupted"}]}')

    const cacheDir = join(mockState.userDataDir, "Cache", "ModCatalog")
    const [cacheFile] = readdirSync(cacheDir)
    assert.ok(cacheFile, "expected a cache file to exist before corrupting it")
    writeFileSync(join(cacheDir, cacheFile), "{ not valid json", "utf8")

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
