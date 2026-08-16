/** Opens a URL in the system browser through the preload bridge. See moddb.ts for why this lives outside features/mods. */
export function openExternalLink(url: string): void {
  window.api.utils.openOnBrowser(url)
}
