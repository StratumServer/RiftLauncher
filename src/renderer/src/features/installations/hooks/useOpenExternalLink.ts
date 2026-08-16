/** Opens `url` in the user's default browser, straight off the preload bridge. */
export function useOpenExternalLink(): (url: string) => void {
  return (url) => window.api.utils.openOnBrowser(url)
}
