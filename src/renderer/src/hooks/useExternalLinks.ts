/** Opens `url` in the user's default browser, straight off the preload bridge. Shared by every "open in browser" action across features. */
export function useExternalLinks(): { openOnBrowser: (url: string) => void } {
  return {
    openOnBrowser: (url: string): void => window.api.utils.openOnBrowser(url)
  }
}
