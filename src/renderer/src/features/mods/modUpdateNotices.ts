/**
 * Tracks startup update notices until a complete Manage Mods scan finds no updates (#752).
 * Updates from the ModDB catalog are reflected when the player next opens Manage Mods.
 */
const startupModUpdateNotices = new Map<string, Set<string>>()

export function recordStartupModUpdateNotice(installationId: string, noticeId: string): void {
  let ids = startupModUpdateNotices.get(installationId)
  if (!ids) {
    ids = new Set()
    startupModUpdateNotices.set(installationId, ids)
  }
  ids.add(noticeId)
}

export function resolveStartupModUpdateNotice(installationId: string, resolveNotification: (id: string) => void): void {
  const ids = startupModUpdateNotices.get(installationId)
  if (!ids) return
  startupModUpdateNotices.delete(installationId)
  for (const id of ids) resolveNotification(id)
}

export function resetStartupModUpdateNoticesForTests(): void {
  startupModUpdateNotices.clear()
}
