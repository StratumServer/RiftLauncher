import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import { getIpcHandler, registerIpcHandler } from "./helpers/ipcHandlerRegistry"
import { createTrustedEvent, createUntrustedEvent } from "./helpers/trustedEvent"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"

/**
 * Covers the QUERY_URL `ipcMain.handle` wrapper itself (src/ipc/handlers/netHandlers.ts,
 * lines 49-59): `queryUrl` (the exported function it delegates to) already has thorough
 * coverage from api-url-ceiling.test.ts and mod-catalog-cache.test.ts (PR #94's tests for
 * the disallowed-URL throw, the per-endpoint ceiling refusal, and the catalog stale-serve
 * arms), but nothing previously invoked the wrapper that assertTrustedIpcSender-guards it
 * and logs+rethrows on failure -- that path was 0% function coverage.
 *
 * This file gets its own `electron` mock (not tests/ipc/helpers/electronMock, which has no
 * `net`) because netHandlers.ts imports `net.request` transitively through network.ts, the
 * same reason mod-catalog-cache.test.ts mocks it locally. `ipcHandlerRegistry`/`trustedEvent`
 * are the mock-free halves of that shared helper, safe to import from a file with its own
 * differently-shaped `electron` mock (see ipcHandlerRegistry.ts for why the split exists).
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
    // netHandlers.ts registers its limiter shutdown on before-quit; nothing here quits.
    on: (): void => {}
  },
  ipcMain: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
      registerIpcHandler(channel, listener)
    }
  },
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
  | { kind: "success"; body: string }
  | { kind: "request-error"; message: string }
  /** Answers nothing until the test calls back the `finish` it is handed, so requests can be held open and overlap. */
  | { kind: "held"; body: string; onStart: (finish: () => void) => void }

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

    if (scenario.kind === "held") {
      scenario.onStart(() => {
        const response = new FakeResponse({}, 200)
        this.emit("response", response)
        response.emit("data", Buffer.from(scenario.body, "utf8"))
        response.emit("end")
      })
      return
    }

    if (scenario.kind === "request-error") {
      this.emit("error", new Error(scenario.message))
      return
    }

    const response = new FakeResponse({}, 200)
    this.emit("response", response)
    response.emit("data", Buffer.from(scenario.body, "utf8"))
    response.emit("end")
  }
}

function respondWith(scenario: RequestScenario): void {
  mockState.requestHandler = (): FakeRequest => new FakeRequest(scenario)
}

const TAGS_URL = "https://mods.vintagestory.at/api/tags"

type QueryUrlHandler = (event: IpcMainInvokeEvent, url: unknown) => Promise<string>

describe("QUERY_URL ipcMain.handle wrapper", () => {
  beforeEach(async () => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-net-dispatch-"))
    // Importing netHandlers.ts calls ipcMain.handle at module load, which the
    // mock above wires straight into ipcHandlerRegistry.
    await import("@src/ipc/handlers/netHandlers")
  })

  afterEach(() => {
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it("throws Unauthorized IPC sender for an untrusted caller, before ever making a request", async () => {
    const handler = getIpcHandler<QueryUrlHandler>(IPC_CHANNELS.NET_MANAGER.QUERY_URL)
    await assert.rejects(() => handler(createUntrustedEvent(), TAGS_URL), /Unauthorized IPC sender/)
  })

  it("resolves the response text for a trusted caller", async () => {
    const handler = getIpcHandler<QueryUrlHandler>(IPC_CHANNELS.NET_MANAGER.QUERY_URL)
    respondWith({ kind: "success", body: '["tag-a"]' })

    const event = await createTrustedEvent()
    const text = await handler(event, TAGS_URL)
    assert.equal(text, '["tag-a"]')
  })

  it("logs and rethrows when the underlying request fails", async () => {
    const handler = getIpcHandler<QueryUrlHandler>(IPC_CHANNELS.NET_MANAGER.QUERY_URL)
    respondWith({ kind: "request-error", message: "network is down" })

    const event = await createTrustedEvent()
    await assert.rejects(() => handler(event, TAGS_URL), /network is down/)
  })

  it("rejects a URL that is not on the allow-list without ever calling net.request", async () => {
    const handler = getIpcHandler<QueryUrlHandler>(IPC_CHANNELS.NET_MANAGER.QUERY_URL)
    mockState.requestHandler = (): FakeRequest => {
      throw new Error("net.request should not have been called for a disallowed URL")
    }

    const event = await createTrustedEvent()
    await assert.rejects(() => handler(event, "https://example.com/api/mods"), /URL is not allowed/)
  })
})

/**
 * The bound on how many requests QUERY_URL lets out at once (#384).
 *
 * The modpack import resolves one mod-detail lookup per entry the folder does not already
 * satisfy, and since #384 it does that when the manifest loads rather than when Import is
 * clicked, so a 200-mod pack used to fire 200 requests at the mod database off a file
 * chooser. Manage Mods fans out the same way over installed mods.
 *
 * This drives the real handler with the transport stubbed, holding every request open until
 * the peak has been observed, so what it measures is the handler's own ceiling and not a
 * timing accident. The expected peak is written out as a literal on purpose: reading
 * QUERY_URL_CONCURRENCY_LIMIT back out of the module would make the test agree with whatever
 * the constant happened to say.
 */
describe("QUERY_URL concurrency bound", () => {
  it("never has more than 6 requests in flight, and still answers all 40", async () => {
    const handler = getIpcHandler<QueryUrlHandler>(IPC_CHANNELS.NET_MANAGER.QUERY_URL)

    let inFlight = 0
    let peak = 0
    const finishers: Array<() => void> = []

    mockState.requestHandler = (): FakeRequest =>
      new FakeRequest({
        kind: "held",
        body: '["tag-a"]',
        onStart: (finish) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          finishers.push(() => {
            inFlight--
            finish()
          })
        }
      })

    const event = await createTrustedEvent()
    const pending = Array.from({ length: 40 }, () => handler(event, TAGS_URL))

    // Let every call that can start, start. Each held request parks after onStart, so once
    // the queue stops growing the number parked is exactly the ceiling under test.
    while (finishers.length < 6) await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(peak, 6)

    // Release them one at a time, so a limiter that handed out extra slots on a release would
    // show up as a peak above the bound rather than as a slower run.
    while (finishers.length > 0) {
      finishers.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }

    const answers = await Promise.all(pending)
    assert.equal(answers.length, 40)
    assert.ok(answers.every((text) => text === '["tag-a"]'))
    assert.equal(peak, 6)
    assert.equal(inFlight, 0)
  })
})
