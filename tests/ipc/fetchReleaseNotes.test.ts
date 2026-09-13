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
 * FETCH_RELEASE_NOTES (src/ipc/handlers/netHandlers.ts, #439): the ipcMain.handle wrapper, the
 * field validation on GitHub's response, and releaseNotesFailureReason's mapping onto the four
 * tokens the "what's new" dialog is allowed to see.
 *
 * Same shape as netHandlersDispatch.test.ts's QUERY_URL coverage and the same reason for its own
 * `electron` mock: this transitively imports `net.request` through network.ts.
 */
const mockState = vi.hoisted(() => ({
  userDataDir: "",
  /** What the last net.request actually asked for, so a test can assert the URL and the headers rather than trust them. */
  lastRequest: { url: "", headers: {} as Record<string, string> },
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
  ipcMain: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
      registerIpcHandler(channel, listener)
    }
  },
  net: {
    request: (options: unknown): FakeRequest => {
      mockState.lastRequest = { url: isRecord(options) && typeof options["url"] === "string" ? options["url"] : "", headers: {} }
      return mockState.requestHandler(options)
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

type RequestScenario =
  | { kind: "success"; body: string; headers?: Record<string, string>; statusCode?: number }
  | { kind: "request-error"; message: string }
  /** Never answers until abort()'d, so the transport's own timeout is what settles it. */
  | { kind: "held" }

class FakeRequest extends EventEmitter {
  aborted = false

  constructor(private readonly scenario: RequestScenario) {
    super()
  }

  setHeader(name: string, value: string): void {
    mockState.lastRequest.headers[name] = value
  }

  abort(): void {
    this.aborted = true
  }

  end(): void {
    const scenario = this.scenario
    if (scenario.kind === "held") return

    if (scenario.kind === "request-error") {
      this.emit("error", new Error(scenario.message))
      return
    }

    const response = new FakeResponse(scenario.headers ?? {}, scenario.statusCode ?? 200)
    this.emit("response", response)
    response.emit("data", Buffer.from(scenario.body, "utf8"))
    response.emit("end")
  }
}

function respondWith(scenario: RequestScenario): void {
  mockState.requestHandler = (): FakeRequest => new FakeRequest(scenario)
}

type FetchReleaseNotesHandler = (event: IpcMainInvokeEvent) => Promise<FetchReleaseNotesResult>

function githubRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: "v1.1.0",
    name: "1.1.0",
    body: "# Highlights\n\n- A fix",
    prerelease: false,
    draft: false,
    published_at: "2026-01-01T00:00:00Z",
    // Fields the API sends that FETCH_RELEASE_NOTES must never carry through unvalidated.
    html_url: "https://github.com/StratumServer/RiftLauncher/releases/tag/v1.1.0",
    author: { login: "someone" },
    ...overrides
  }
}

describe("FETCH_RELEASE_NOTES ipcMain.handle wrapper", () => {
  beforeEach(async () => {
    mockState.userDataDir = mkdtempSync(join(tmpdir(), "riftlauncher-release-notes-"))
    await import("@src/ipc/handlers/netHandlers")
  })

  afterEach(() => {
    rmSync(mockState.userDataDir, { recursive: true, force: true })
    vi.resetModules()
    vi.useRealTimers()
  })

  it("throws Unauthorized IPC sender for an untrusted caller, before ever making a request", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    mockState.requestHandler = (): FakeRequest => {
      throw new Error("net.request should not have been called for an untrusted sender")
    }

    await assert.rejects(() => handler(createUntrustedEvent()), /Unauthorized IPC sender/)
  })

  it("resolves only the validated fields for a trusted caller", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify([githubRelease()]) })

    const result = await handler(await createTrustedEvent())

    assert.deepEqual(result, {
      ok: true,
      releases: [{ tag: "v1.1.0", name: "1.1.0", body: "# Highlights\n\n- A fix", prerelease: false, draft: false, publishedAt: "2026-01-01T00:00:00Z" }]
    })
  })

  it("asks GitHub for ten releases, with the Accept and User-Agent headers its API requires", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "[]" })

    await handler(await createTrustedEvent())

    assert.equal(mockState.lastRequest.url, "https://api.github.com/repos/StratumServer/RiftLauncher/releases?per_page=10")
    assert.equal(new URL(mockState.lastRequest.url).searchParams.get("per_page"), "10")
    assert.equal(mockState.lastRequest.headers["Accept"], "application/vnd.github+json")
    // GitHub's API refuses a request that carries no User-Agent at all.
    assert.equal(mockState.lastRequest.headers["User-Agent"], "RiftLauncher")
  })

  it("carries a prerelease and a draft through as the flags they are", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify([githubRelease({ tag_name: "v1.2.0-beta.1", prerelease: true, draft: true })]) })

    const result = await handler(await createTrustedEvent())

    assert.deepEqual(result, {
      ok: true,
      releases: [{ tag: "v1.2.0-beta.1", name: "1.1.0", body: "# Highlights\n\n- A fix", prerelease: true, draft: true, publishedAt: "2026-01-01T00:00:00Z" }]
    })
  })

  it("caps a release name, body and published date before they cross IPC", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({
      kind: "success",
      body: JSON.stringify([githubRelease({ name: "n".repeat(1_000), body: "b".repeat(100_000), published_at: "p".repeat(1_000) })])
    })

    const result = await handler(await createTrustedEvent())
    const release = result.ok ? result.releases[0] : undefined

    assert.equal(release?.name.length, 256)
    assert.equal(release?.body.length, 64 * 1024)
    assert.equal(release?.publishedAt.length, 64)
  })

  it("drops a release whose tag is longer than a tag can be", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify([githubRelease({ tag_name: "v".repeat(129) }), githubRelease({ tag_name: "v2.0.0" })]) })

    const result = await handler(await createTrustedEvent())

    assert.deepEqual(result.ok && result.releases.map((r) => r.tag), ["v2.0.0"])
  })

  it("defaults name, body and publishedAt for a release entry missing them, rather than dropping it", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify([{ tag_name: "v1.0.0", prerelease: false, draft: false }]) })

    const result = await handler(await createTrustedEvent())

    assert.deepEqual(result, { ok: true, releases: [{ tag: "v1.0.0", name: "v1.0.0", body: "", prerelease: false, draft: false, publishedAt: "" }] })
  })

  it("drops an entry with no usable tag instead of failing the whole list", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify([{ name: "no tag here" }, githubRelease({ tag_name: "v2.0.0" })]) })

    const result = await handler(await createTrustedEvent())

    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.releases.map((r) => r.tag), ["v2.0.0"])
  })

  it("answers bad-response for malformed JSON", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "this is not json" })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers bad-response when the body parses but is not a list", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: JSON.stringify({ message: "Not Found" }) })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers too-large for a response over the byte cap", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "[]", headers: { "content-length": String(300 * 1024) } })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "too-large" })
  })

  it("answers rate-limited for a 403 carrying x-ratelimit-remaining: 0", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "", statusCode: 403, headers: { "x-ratelimit-remaining": "0" } })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "rate-limited" })
  })

  it("answers rate-limited for a 429, GitHub's secondary limit", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "", statusCode: 429 })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "rate-limited" })
  })

  it("answers bad-response when the transport refuses a redirect, rather than calling the machine offline", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "request-error", message: "net::ERR_UNEXPECTED_REDIRECT" })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers bad-response for a 301 that reaches the status check instead", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "", statusCode: 301, headers: { location: "https://api.github.com/repos/StratumServer/Renamed/releases" } })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers bad-response for a 403 that is not the rate limit", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "", statusCode: 403, headers: { "x-ratelimit-remaining": "12" } })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers bad-response for an ordinary server error", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "success", body: "", statusCode: 500 })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "bad-response" })
  })

  it("answers offline for a connection failure", async () => {
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "request-error", message: "getaddrinfo ENOTFOUND api.github.com" })

    assert.deepEqual(await handler(await createTrustedEvent()), { ok: false, reason: "offline" })
  })

  it("answers offline once the request's own timeout trips", async () => {
    vi.useFakeTimers()
    const handler = getIpcHandler<FetchReleaseNotesHandler>(IPC_CHANNELS.NET_MANAGER.FETCH_RELEASE_NOTES)
    respondWith({ kind: "held" })

    const event = await createTrustedEvent()
    const pending = handler(event)

    await vi.advanceTimersByTimeAsync(5_000)

    assert.deepEqual(await pending, { ok: false, reason: "offline" })
  })
})
