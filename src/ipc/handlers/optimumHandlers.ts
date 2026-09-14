import { ipcMain } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { getOptimumManifest } from "@src/ipc/optimumManifest"

/**
 * Whether Optimum can be offered this session, and where its overlay comes from.
 *
 * The answer is the session's manifest or one reason token, never an error: the
 * page shows a disabled choice with one calm line under it rather than a
 * failure, since no Optimum is a normal state and not a broken launcher.
 */
ipcMain.handle(IPC_CHANNELS.OPTIMUM_MANAGER.GET_MANIFEST, async (event): Promise<OptimumManifestResult> => {
  assertTrustedIpcSender(event)
  return getOptimumManifest()
})
