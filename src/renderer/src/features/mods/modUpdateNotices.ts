/**
 * Keeps track of active startup mod update notice IDs per Installation.
 *
 * GlobalModUpdateChecker posts a notice when an Installation has available mod updates on startup.
 * When an update (either bulk or individual) leaves no updatable mods in that Installation,
 * the active notice is resolved and dismissed (#752) so the banner and actionable Activity Center
 * entry do not stay around showing obsolete update counts.
 */
const startupModUpdateNotices = new Map<string, string>()

export function recordStartupModUpdateNotice(installationId: string, noticeId: string): void {
  startupModUpdateNotices.set(installationId, noticeId)
}

export function getStartupModUpdateNotice(installationId: string): string | undefined {
  return startupModUpdateNotices.get(installationId)
}

export function clearStartupModUpdateNotice(installationId: string): void {
  startupModUpdateNotices.delete(installationId)
}

export function resolveStartupModUpdateNotice(installationId: string, resolveNotification: (id: string) => void): boolean {
  const noticeId = startupModUpdateNotices.get(installationId)
  if (!noticeId) return false
  resolveNotification(noticeId)
  startupModUpdateNotices.delete(installationId)
  return true
}

export function resetStartupModUpdateNoticesForTesting(): void {
  startupModUpdateNotices.clear()
}
