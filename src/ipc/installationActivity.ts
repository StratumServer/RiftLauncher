/** Main-process activity state. Renderer flags are advisory; world operations use this state. */
const playingInstallationCounts = new Map<string, number>()
const installationOperationIds = new Set<string>()

export type InstallationOperationFailure = "playing" | "busy"

export type InstallationOperationLease = { ok: true; release: () => void } | { ok: false; reason: InstallationOperationFailure }

/** Reserves one or more installations for one host-side filesystem operation. */
export function tryAcquireInstallationOperation(installationIds: readonly string[]): InstallationOperationLease {
  const ids = [...new Set(installationIds)].sort()
  if (ids.some((id) => isInstallationPlaying(id))) return { ok: false, reason: "playing" }
  if (ids.some((id) => installationOperationIds.has(id))) return { ok: false, reason: "busy" }

  ids.forEach((id) => installationOperationIds.add(id))
  let released = false
  return {
    ok: true,
    release: (): void => {
      if (released) return
      released = true
      ids.forEach((id) => installationOperationIds.delete(id))
    }
  }
}

/** Marks a launch before spawning, closing the check-to-spawn race with world operations. */
export function markInstallationPlaying(installationId: string): boolean {
  if (installationOperationIds.has(installationId)) return false
  playingInstallationCounts.set(installationId, (playingInstallationCounts.get(installationId) ?? 0) + 1)
  return true
}

export function clearInstallationPlaying(installationId: string): void {
  const count = playingInstallationCounts.get(installationId) ?? 0
  if (count <= 1) playingInstallationCounts.delete(installationId)
  else playingInstallationCounts.set(installationId, count - 1)
}

export function isInstallationPlaying(installationId: string): boolean {
  return (playingInstallationCounts.get(installationId) ?? 0) > 0
}
