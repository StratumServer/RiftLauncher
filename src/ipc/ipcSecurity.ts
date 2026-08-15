import { join } from "path"
import { app } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"

import { isAllowedRendererUrl } from "@src/ipc/validation"

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent

let trustedWebContentsId: number | null = null
let trustedFrameRoutingId: number | null = null

export function registerTrustedWebContents(webContents: WebContents): void {
  trustedWebContentsId = webContents.id
  trustedFrameRoutingId = webContents.mainFrame.routingId

  webContents.once("destroyed", () => {
    if (trustedWebContentsId === webContents.id) {
      trustedWebContentsId = null
      trustedFrameRoutingId = null
    }
  })
}

export function isTrustedIpcSender(event: IpcEvent): boolean {
  if (trustedWebContentsId === null || trustedFrameRoutingId === null || event.sender.id !== trustedWebContentsId || event.sender.isDestroyed()) return false

  const frame = event.senderFrame
  if (!frame || frame.routingId !== trustedFrameRoutingId) return false

  return isAllowedRendererUrl(frame.url, app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"], join(__dirname, "../renderer/index.html"))
}

export function assertTrustedIpcSender(event: IpcEvent): void {
  if (!isTrustedIpcSender(event)) throw new Error("Unauthorized IPC sender")
}
