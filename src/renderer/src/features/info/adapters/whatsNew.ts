/**
 * The info feature's one touchpoint with the preload bridge for release notes. No file under
 * src/renderer/src/components may mention window.api (tests/security-boundaries.test.ts), so
 * WhatsNewDialog reaches this through useWhatsNew.ts rather than calling it directly, the same
 * shape features/moddb/adapters/moddb.ts already gives the ModDB prompt.
 */
export function fetchReleaseNotes(): Promise<FetchReleaseNotesResult> {
  return window.api.netManager.fetchReleaseNotes()
}
