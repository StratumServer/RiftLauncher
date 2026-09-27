import { useEffect, useState } from "react"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useOptimumManifest.ts] [useOptimumManifest]"

export type OptimumManifestState = {
  /** What Optimum published for this machine, or undefined while none is known. */
  manifest: OptimumManifestInfo | undefined
  loading: boolean
  /** Why nothing is on offer. Undefined while loading, and once a manifest is in hand. */
  reason: OptimumManifestFailureReason | undefined
}

/**
 * Asks the main process for Optimum's published overlay, once.
 *
 * The same shape `useGameVersionCatalog` answers in, with one difference: there
 * is no retry. A missing Optimum is not a failure the page asks the player to
 * do anything about, it is one disabled choice with a sentence under it, and
 * the main process already caches the answer for the session and forgets a
 * failed fetch, so reopening the page is the retry.
 */
export function useOptimumManifest(): OptimumManifestState {
  const [manifest, setManifest] = useState<OptimumManifestInfo | undefined>()
  const [loading, setLoading] = useState(true)
  const [reason, setReason] = useState<OptimumManifestFailureReason | undefined>()

  useEffect(() => {
    let cancelled = false

    void (async (): Promise<void> => {
      try {
        const result = await window.api.optimumManager.getManifest()
        if (cancelled) return
        if (result.ok) setManifest(result.manifest)
        else setReason(result.reason)
      } catch (err) {
        window.api.utils.logMessage("error", `${LOG_TAG} Error reading Optimum's published overlay.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} Error reading Optimum's published overlay: ${err}`)
        if (!cancelled) setReason("unreachable")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return (): void => {
      cancelled = true
    }
  }, [])

  return { manifest, loading, reason }
}
