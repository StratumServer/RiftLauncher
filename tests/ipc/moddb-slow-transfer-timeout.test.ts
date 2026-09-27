import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

/**
 * The pre-release sweep found the mods/authors catalog endpoints cut mid-transfer by the
 * generic 15s wall clock whenever ModDB serves them at ordinary slow speed: both are several
 * megabytes, uncompressed, with no Content-Length, so the transfer itself can outlast 15s even
 * though bytes are still arriving throughout.
 *
 * requestBoundedBuffer (src/ipc/network.ts) now resets a 15s inactivity window on every chunk
 * received, and the mods/authors rule (src/ipc/validation.ts's API_URL_RULES) carries a wider
 * 90s overall ceiling on top of that. This file drives queryUrl (src/ipc/handlers/netHandlers.ts)
 * with a fake `net.request` that trickles its body on a schedule vi's fake timers control, so a
 * multi-second transfer is exercised without the suite actually waiting on one.
 *
 * Same `electron` mock shape as mod-catalog-cache.test.ts and netHandlersDispatch.test.ts, for
 * the same reason: netHandlers.ts imports `net.request` transitively through network.ts, and
 * tests/ipc/helpers/electronMock has no `net` member.
 */
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
    isPackaged: true,
    on: (): void => {}
  },
  ipcMain: { handle: vi.fn() },
  net: { request: (options: unknown): FakeRequest => mockState.requestHandler(options) }
}))

class FakeResponse extends EventEmitter {
  headers: Record<string, string> = {}
  statusCode = 200
}

/**
 * Sends `chunkBodies` one at a time, `gapMs` apart, starting `gapMs` after `end()` is called.
 * With `stallAfterChunks` set, it stops after that many chunks and never ends, so the request
 * is left open exactly the way a connection gone quiet mid-transfer would.
 */
class FakeRequest extends EventEmitter {
  aborted = false

  constructor(
    private readonly chunkBodies: string[],
    private readonly gapMs: number,
    private readonly stallAfterChunks?: number
  ) {
    super()
  }

  setHeader(): void {
    // no-op: headers are irrelevant to these tests
  }

  abort(): void {
    this.aborted = true
  }

  end(): void {
    const response = new FakeResponse()
    this.emit("response", response)

    let sent = 0
    const sendNext = (): void => {
      if (this.aborted) return
      if (this.stallAfterChunks !== undefined && sent >= this.stallAfterChunks) return
      const body = this.chunkBodies[sent]
      if (body === undefined) {
        response.emit("end")
        return
      }
      response.emit("data", Buffer.from(body, "utf8"))
      sent++
      setTimeout(sendNext, this.gapMs)
    }
    setTimeout(sendNext, this.gapMs)
  }
}

function respondWithTrickle(chunkBodies: string[], gapMs: number, stallAfterChunks?: number): void {
  mockState.requestHandler = (): FakeRequest => new FakeRequest(chunkBodies, gapMs, stallAfterChunks)
}

const AUTHORS_URL = "https://mods.vintagestory.at/api/authors"
const TAGS_URL = "https://mods.vintagestory.at/api/tags"

describe("the mods/authors catalog survives a slow, steady transfer (pre-release sweep, beta.11)", () => {
  beforeEach(() => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-slow-transfer-"))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it("resolves /api/authors when the body trickles slower than 15s total but each gap stays under the inactivity window", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    // Six chunks, 10s apart: 60s total (past the old 15s wall clock, under the new 90s
    // ceiling), no gap wider than the 15s inactivity window.
    const chunks = ["a", "b", "c", "d", "e", "f"]
    respondWithTrickle(chunks, 10_000)

    const pending = queryUrl(AUTHORS_URL)
    await vi.advanceTimersByTimeAsync(70_000)

    assert.equal(await pending, chunks.join(""))
  })

  it("rejects /api/authors once the inactivity window elapses with no bytes, before the 90s ceiling", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    // Two chunks 10s apart (bytes flowing, nothing wrong yet), then silence: no third chunk
    // ever comes, so only the inactivity timer can end this, at t=20s+15s=35s, well inside
    // the 90s overall ceiling.
    respondWithTrickle(["a", "b"], 10_000, 2)

    const pending = queryUrl(AUTHORS_URL)
    pending.catch(() => {
      // Rejection is asserted below via assert.rejects; this only keeps Node from reporting
      // an unhandled rejection for the tick between the throw and that await.
    })
    await vi.advanceTimersByTimeAsync(40_000)

    await assert.rejects(pending, /timed out/)
  })

  it("keeps the generic 15s ceiling for an ordinary endpoint even though each gap alone is under the inactivity window", async () => {
    const { queryUrl } = await import("@src/ipc/handlers/netHandlers")

    // Two chunks 10s apart: the second lands at t=20s, past the unwidened 15s overall
    // ceiling /api/tags still gets, so this must fail even though no single gap reached 15s.
    respondWithTrickle(["a", "b"], 10_000)

    const pending = queryUrl(TAGS_URL)
    pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(20_000)

    await assert.rejects(pending, /timed out/)
  })
})
