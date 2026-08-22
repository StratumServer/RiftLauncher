import { useCallback, useEffect, useState } from "react"

import { BACKGROUNDS_MANIFEST_URL, parseBackgroundManifest } from "@domain/backgrounds"

export type BackgroundCatalogState = {
  /** The scenes the branch lists. Empty while loading and after a failure. */
  entries: BackgroundType[]
  loading: boolean
  failed: boolean
  /** Resets the failure and fetches the manifest again. */
  retry: () => void
}

/**
 * Reads the background catalog off the repository's `backgrounds` branch.
 *
 * Runs when the component holding it mounts, which is when the settings page opens, and never at
 * startup: a launcher that is only ever launched offline makes no request for this at all and
 * shows the scene it ships with.
 *
 * A refused fetch and a manifest nothing could be read out of are the same answer here, `failed`
 * with the reload button beside it, the shape useModReleaseCatalog settled on. Both mean the same
 * thing to the player: the list is not there, try again.
 */
export function useBackgroundCatalog(): BackgroundCatalogState {
  const [entries, setEntries] = useState<BackgroundType[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setFailed(false)
    ;(async (): Promise<void> => {
      let found: BackgroundType[] = []

      try {
        found = parseBackgroundManifest(await window.api.netManager.queryURL(BACKGROUNDS_MANIFEST_URL))
      } catch {
        found = []
      }

      if (cancelled) return
      setEntries(found)
      setLoading(false)
      setFailed(found.length === 0)
    })()

    return (): void => {
      cancelled = true
    }
  }, [attempt])

  const retry = useCallback((): void => {
    setLoading(true)
    setFailed(false)
    setAttempt((n) => n + 1)
  }, [])

  return { entries, loading, failed, retry }
}
