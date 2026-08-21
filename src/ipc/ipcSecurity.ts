import { join } from "node:path"
import { app } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"

import { isAllowedRendererUrl } from "@src/ipc/validation"

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent

// Fixes #67: a full main-frame reload (renderer crash recovery, or any
// in-app `location.reload()`) tears down the old main frame and mints a new
// one on the SAME webContents. The previous check pinned the main frame's
// routingId once at registration and compared against that pinned number
// forever, so a legitimate reload permanently killed every IPC channel.
// Chromium also recycles routingId values once a frame is torn down, so
// pinning a number and comparing it later is not even safe against
// coincidental reuse. Instead, only the webContents identity is pinned;
// the "is this the trusted main frame" question is answered live, against
// `webContents.mainFrame` as it exists right now, at the moment of the
// call. That keeps trust following the SAME webContents across any number
// of legitimate reloads while still rejecting a foreign webContents (id
// check) and any subframe (a subframe's senderFrame is never the
// webContents' current mainFrame).
let trustedWebContents: WebContents | null = null

export function registerTrustedWebContents(webContents: WebContents): void {
  trustedWebContents = webContents

  webContents.once("destroyed", () => {
    if (trustedWebContents === webContents) {
      trustedWebContents = null
    }
  })
}

export function isTrustedIpcSender(event: IpcEvent): boolean {
  if (trustedWebContents === null || event.sender.id !== trustedWebContents.id || event.sender.isDestroyed()) return false

  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false

  return isAllowedRendererUrl(frame.url, app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"], join(__dirname, "../renderer/index.html"))
}

export function assertTrustedIpcSender(event: IpcEvent): void {
  if (!isTrustedIpcSender(event)) throw new Error("Unauthorized IPC sender")
}
