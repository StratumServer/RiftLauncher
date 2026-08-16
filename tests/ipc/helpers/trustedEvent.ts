import { vi } from "vitest"
import type { IpcMainInvokeEvent, WebContents } from "electron"

/**
 * A trusted-webContents `IpcMainInvokeEvent` stand-in: registers a fake
 * webContents on `@src/ipc/ipcSecurity`'s real `registerTrustedWebContents`,
 * so `assertTrustedIpcSender` passes for it.
 *
 * Imports `ipcSecurity` dynamically rather than statically, on purpose: tests
 * that need a fresh copy of a handler's dependencies per case call
 * `vi.resetModules()` and re-import the handler module, which pulls in a
 * brand new `ipcSecurity` instance with its own `trustedWebContents`
 * singleton. A static import here would stay bound to whichever instance
 * existed when this helper file first loaded, register trust on it, and
 * leave the handler checking a different, still-untrusted instance. A
 * dynamic import always resolves against the current module registry, the
 * same one the just-(re)imported handler is using.
 *
 * No `vi.mock` of its own (see ipcHandlerRegistry.ts for why that matters):
 * this only reaches `electron` transitively, through whatever mock the
 * calling test file already installed.
 */
export async function createTrustedEvent(): Promise<IpcMainInvokeEvent> {
  const { registerTrustedWebContents } = await import("@src/ipc/ipcSecurity")
  const mainFrame = { url: "app://renderer/index.html" }
  const webContents = {
    id: 1,
    mainFrame,
    isDestroyed: (): boolean => false,
    send: vi.fn(),
    once: (): void => {}
  }
  registerTrustedWebContents(webContents as unknown as WebContents)
  return { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
}

/** An `IpcMainInvokeEvent` stand-in from a webContents nothing ever registered as trusted. */
export function createUntrustedEvent(): IpcMainInvokeEvent {
  const mainFrame = { url: "app://renderer/index.html" }
  const webContents = { id: -1, mainFrame, isDestroyed: (): boolean => false, send: vi.fn(), once: (): void => {} }
  return { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
}
