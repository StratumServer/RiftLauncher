import assert from "node:assert/strict"
import { beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"

import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron"

/**
 * Regression coverage for #67: registerTrustedWebContents/isTrustedIpcSender
 * used to pin the main frame's routingId once, so any legitimate reload
 * (renderer crash recovery, `location.reload()`) minted a new main frame and
 * permanently killed every IPC channel on that window. The fix drops the
 * pinned routingId and instead compares the sender's frame against
 * `webContents.mainFrame` read live, at call time.
 *
 * `src/ipc/ipcSecurity.ts` only imports `electron` for `app.isPackaged`
 * (there is no `ipcMain.handle` call at module load), so it is importable
 * directly, as long as "./helpers/electronMock" has installed the `electron`
 * mock first -- the same ordering modScan.test.ts relies on.
 */

/** Everything isTrustedIpcSender reads off a frame: just its `url`. */
interface FakeFrame {
  url: string
}

type Listener = () => void

/**
 * Minimal stand-in for a WebContents. `mainFrame` is a mutable property so a
 * test can simulate a reload by swapping in a new frame object, exactly as
 * Electron replaces the main frame under the hood; simulateSubframeCall
 * builds a frame that is never the current mainFrame, standing in for an
 * `<iframe>`'s WebFrameMain.
 */
class FakeWebContents {
  readonly id: number
  mainFrame: FakeFrame
  private destroyed = false
  private readonly destroyedListeners = new Set<Listener>()

  constructor(id: number, frameUrl = "app://renderer/index.html") {
    this.id = id
    this.mainFrame = { url: frameUrl }
  }

  /** Simulates a full main-frame reload: a brand new frame object, same webContents. */
  reload(frameUrl: string = this.mainFrame.url): FakeFrame {
    this.mainFrame = { url: frameUrl }
    return this.mainFrame
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(event: "destroyed", listener: Listener): this {
    if (event === "destroyed") this.destroyedListeners.add(listener)
    return this
  }

  destroy(): void {
    this.destroyed = true
    for (const listener of this.destroyedListeners) listener()
  }
}

function eventFrom(sender: FakeWebContents, senderFrame: WebFrameMain | null): IpcMainInvokeEvent {
  return { sender: sender as unknown as WebContents, senderFrame } as unknown as IpcMainInvokeEvent
}

let registerTrustedWebContents: (webContents: WebContents) => void
let isTrustedIpcSender: (event: IpcMainInvokeEvent) => boolean
let assertTrustedIpcSender: (event: IpcMainInvokeEvent) => void

beforeEach(async () => {
  // ipcSecurity.ts keeps its trusted-webContents pin in module-level state,
  // by design (it is a single process-wide guard, not something callers
  // pass around). resetModules forces a fresh copy per test so one test's
  // registerTrustedWebContents call cannot leak into the next.
  vi.resetModules()
  const mod = await import("../../src/ipc/ipcSecurity")
  registerTrustedWebContents = mod.registerTrustedWebContents
  isTrustedIpcSender = mod.isTrustedIpcSender
  assertTrustedIpcSender = mod.assertTrustedIpcSender
})

describe("isTrustedIpcSender", () => {
  it("trusts a call from the registered webContents' current main frame", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)

    const event = eventFrom(webContents, webContents.mainFrame as unknown as WebFrameMain)

    assert.equal(isTrustedIpcSender(event), true)
  })

  it("survives a same-webContents reload: the new main frame is trusted, the old frame reference is not", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)
    const originalFrame = webContents.mainFrame as unknown as WebFrameMain

    const newFrame = webContents.reload() as unknown as WebFrameMain

    assert.equal(isTrustedIpcSender(eventFrom(webContents, newFrame)), true, "the reloaded main frame must be trusted")
    assert.equal(isTrustedIpcSender(eventFrom(webContents, originalFrame)), false, "a stale frame reference must not be trusted")
  })

  it("rejects a call from a different webContents, even with a matching frame shape", () => {
    const trusted = new FakeWebContents(1)
    registerTrustedWebContents(trusted as unknown as WebContents)

    const foreign = new FakeWebContents(2)
    const event = eventFrom(foreign, foreign.mainFrame as unknown as WebFrameMain)

    assert.equal(isTrustedIpcSender(event), false)
  })

  it("rejects a subframe of the trusted webContents", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)

    const subframe: WebFrameMain = { url: webContents.mainFrame.url } as unknown as WebFrameMain
    const event = eventFrom(webContents, subframe)

    assert.equal(isTrustedIpcSender(event), false)
  })

  it("rejects a call with no senderFrame at all", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)

    assert.equal(isTrustedIpcSender(eventFrom(webContents, null)), false)
  })

  it("rejects a call once the registered webContents is destroyed", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)
    const frame = webContents.mainFrame as unknown as WebFrameMain

    webContents.destroy()

    assert.equal(isTrustedIpcSender(eventFrom(webContents, frame)), false)
  })

  it("rejects every call before any webContents has been registered", () => {
    const webContents = new FakeWebContents(1)

    assert.equal(isTrustedIpcSender(eventFrom(webContents, webContents.mainFrame as unknown as WebFrameMain)), false)
  })
})

describe("assertTrustedIpcSender", () => {
  it("does not throw for a trusted sender", () => {
    const webContents = new FakeWebContents(1)
    registerTrustedWebContents(webContents as unknown as WebContents)

    assert.doesNotThrow(() => assertTrustedIpcSender(eventFrom(webContents, webContents.mainFrame as unknown as WebFrameMain)))
  })

  it("throws Unauthorized IPC sender for an untrusted sender", () => {
    const webContents = new FakeWebContents(1)

    assert.throws(() => assertTrustedIpcSender(eventFrom(webContents, webContents.mainFrame as unknown as WebFrameMain)), /Unauthorized IPC sender/)
  })
})
