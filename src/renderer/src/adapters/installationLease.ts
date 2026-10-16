import type { InstallationLease } from "@domain/ports"

/** Wires the InstallationLease port onto the main process reservation, one token per reservation. */
export function createInstallationLeasePort(): InstallationLease {
  return {
    acquire: async (installationId) => {
      const token = crypto.randomUUID()
      const answer = await window.api.installationActivity.acquireLease(installationId, token)
      if (!answer.ok) return answer
      // Fire and forget: the release has to run from a plain finally block. Messages from one
      // renderer reach the main process in order, so a launch sent after it sees the release.
      return { ok: true, release: () => void window.api.installationActivity.releaseLease(token) }
    }
  }
}
