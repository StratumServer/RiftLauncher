import { useCallback } from "react"

/**
 * Opens `url` in the user's default browser, straight off the preload bridge. Shared by
 * every "open in browser" action across features. Wrapped in useCallback so consumers that
 * memoize their own callbacks on top of this one (e.g. ModsGrid's cards) get a dependency
 * that's actually stable across re-renders, not a fresh function every time.
 */
export function useExternalLinks(): { openOnBrowser: (url: string) => void } {
  const openOnBrowser = useCallback((url: string): void => window.api.utils.openOnBrowser(url), [])
  return { openOnBrowser }
}
