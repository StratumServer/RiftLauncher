import { ipcMain } from "electron"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { tryAcquireInstallationOperation } from "@src/ipc/installationActivity"
import { assertSafeTaskId, assertString } from "@src/ipc/validation"

/**
 * Reservations the renderer holds for operations that run on its side, such as restoring an
 * Installation backup. Each one is the same lease a world operation takes, so the two exclude each
 * other and a launch is refused while one is held.
 *
 * ponytail: a reservation outlives a renderer that dies before it releases. The close guard has the
 * same limit, and the window cannot be used without the renderer, so the app restarts anyway.
 */
const heldLeases = new Map<string, () => void>()

ipcMain.handle(IPC_CHANNELS.INSTALLATION_ACTIVITY.ACQUIRE_LEASE, (event, installationId: unknown, token: unknown): { ok: true } | { ok: false; reason: "playing" | "busy" } => {
  assertTrustedIpcSender(event)
  // Same bound as the config loader and the world handlers, so every id the app accepts can be leased. It is only a Set key here.
  const id = assertString(installationId, "installation id", 128)
  const leaseToken = assertSafeTaskId(token)
  if (heldLeases.has(leaseToken)) throw new TypeError("Lease token already in use")

  const lease = tryAcquireInstallationOperation([id])
  if (!lease.ok) return { ok: false, reason: lease.reason }
  heldLeases.set(leaseToken, lease.release)
  return { ok: true }
})

ipcMain.handle(IPC_CHANNELS.INSTALLATION_ACTIVITY.RELEASE_LEASE, (event, token: unknown): void => {
  assertTrustedIpcSender(event)
  const leaseToken = assertSafeTaskId(token)
  heldLeases.get(leaseToken)?.()
  heldLeases.delete(leaseToken)
})
