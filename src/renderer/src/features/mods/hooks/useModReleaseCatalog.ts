import { useCallback, useEffect, useState } from "react"

import { useQueryMod } from "./useQueryMod"

export type ModReleaseCatalogState = {
  /** The queried mod with its releases, or null while it is loading or after a failure. */
  mod: DownloadableModType | null
  loading: boolean
  failed: boolean
  /**
   * The ModDB answered a clean 404: the id is not on it. `failed` is set too, so a caller with nothing
   * more to say about a 404 than about an unreachable ModDB can go on ignoring this.
   */
  notFound: boolean
  /** Resets the failure and re-runs the query. Safe to call again while a retry is already in flight. */
  retry: () => void
}

/**
 * Queries one mod's detail (its release list) and reports whether that query worked.
 *
 * useQueryMod tells a clean 404 apart from a lookup that never answered, but this screen has
 * nothing more useful to say about either one than "it did not work": without a failure flag of
 * its own it cannot tell "still loading" from "never coming", which is how the install popup ended
 * up spinning forever whenever the ModDB was slow or down. `failed` is that flag, and `retry` is
 * the way out of it, the same shape useGameVersionCatalog gives the version list.
 */
export function useModReleaseCatalog(modid: number | string | null): ModReleaseCatalogState {
  const queryMod = useQueryMod()

  const [mod, setMod] = useState<DownloadableModType | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Falsy covers the closed popup (null) the same way the popup's own effect always has.
    if (!modid) {
      setMod(null)
      setLoading(false)
      setFailed(false)
      setNotFound(false)
      return
    }

    let cancelled = false

    setMod(null)
    setLoading(true)
    setFailed(false)
    setNotFound(false)
    ;(async (): Promise<void> => {
      const outcome = await queryMod({ modid })
      if (cancelled) return
      setMod(outcome.status === "found" ? outcome.mod : null)
      setLoading(false)
      setFailed(outcome.status !== "found")
      setNotFound(outcome.status === "not-found")
    })()

    return (): void => {
      cancelled = true
    }
  }, [modid, attempt, queryMod])

  const retry = useCallback((): void => {
    setLoading(true)
    setFailed(false)
    setNotFound(false)
    setAttempt((n) => n + 1)
  }, [])

  return { mod, loading, failed, notFound, retry }
}
