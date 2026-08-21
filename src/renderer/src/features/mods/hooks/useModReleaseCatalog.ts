import { useCallback, useEffect, useState } from "react"

import { useQueryMod } from "./useQueryMod"

export type ModReleaseCatalogState = {
  /** The queried mod with its releases, or null while it is loading or after a failure. */
  mod: DownloadableModType | null
  loading: boolean
  failed: boolean
  /** Resets the failure and re-runs the query. Safe to call again while a retry is already in flight. */
  retry: () => void
}

/**
 * Queries one mod's detail (its release list) and reports whether that query worked.
 *
 * useQueryMod answers `undefined` both when the ModDB call throws and when the payload does not
 * parse, and it logs either one. That is enough for the callers that merge the answer into a
 * bigger list, but not for a screen whose whole content is that answer: without a failure flag
 * they cannot tell "still loading" from "never coming", which is how the install popup ended up
 * spinning forever whenever the ModDB was slow or down. `failed` is that flag, and `retry` is the
 * way out of it, the same shape useGameVersionCatalog gives the version list.
 */
export function useModReleaseCatalog(modid: number | string | null): ModReleaseCatalogState {
  const queryMod = useQueryMod()

  const [mod, setMod] = useState<DownloadableModType | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Falsy covers the closed popup (null) the same way the popup's own effect always has.
    if (!modid) {
      setMod(null)
      setLoading(false)
      setFailed(false)
      return
    }

    let cancelled = false

    setMod(null)
    setLoading(true)
    setFailed(false)
    ;(async (): Promise<void> => {
      const found = await queryMod({ modid })
      if (cancelled) return
      setMod(found ?? null)
      setLoading(false)
      setFailed(found === undefined)
    })()

    return (): void => {
      cancelled = true
    }
  }, [modid, attempt, queryMod])

  const retry = useCallback((): void => {
    setLoading(true)
    setFailed(false)
    setAttempt((n) => n + 1)
  }, [])

  return { mod, loading, failed, retry }
}
