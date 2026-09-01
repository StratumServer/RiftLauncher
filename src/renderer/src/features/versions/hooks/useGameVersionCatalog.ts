import { useCallback, useEffect, useState } from "react"

import { parseGameVersionCatalog, type RawPlatform, type RawVersions } from "@domain/versions/gameVersionCatalog"
import { compareVersions } from "@domain/versionNumbers"

// Official public API: https://api.vintagestory.at/{stable,unstable}.json
// Shape: { [version]: { [platform]: { filename, filesize, md5, urls: { cdn, local }, ... } } }
const VS_API = "https://api.vintagestory.at"

const NO_BUILD: DownloadableGameVersionBuildType = { url: "", fileName: "" }

const LOG_TAG = "[front] [versions] [features/versions/hooks/useGameVersionCatalog.ts] [useGameVersionCatalog]"

/**
 * Reads one platform's build out of a catalog entry.
 *
 * The catalog `filename` is the name the file is saved under. It is the same
 * string as the URL basename today, but it is the field the catalog publishes
 * alongside the md5 the download is checked against, so it is the one taken.
 * A build missing either field counts as no build: the install then says the
 * catalog has nothing for this system instead of inventing a name for it.
 */
function toBuild(platform: RawPlatform | undefined): DownloadableGameVersionBuildType {
  if (!platform?.urls.cdn || !platform.filename) return NO_BUILD
  return { url: platform.urls.cdn, fileName: platform.filename }
}

function deriveType(version: string): DownloadableGameVersionTypeType["type"] {
  if (version.includes("-rc")) return "rc"
  if (version.includes("-pre")) return "pre"
  return "stable"
}

function parseGameVersions(stable: RawVersions, unstable: RawVersions): DownloadableGameVersionTypeType[] {
  return Object.entries({ ...unstable, ...stable })
    .map(([version, p]) => ({
      version,
      type: deriveType(version),
      windows: toBuild(p.windows),
      linux: toBuild(p.linux),
      mac: toBuild(p["mac-arm64"] ?? p["mac-x64"])
    }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

export type GameVersionCatalogState = {
  gameVersions: DownloadableGameVersionTypeType[]
  loading: boolean
  failed: boolean
  /** Resets the failure and re-runs the fetch. Safe to call again while a retry is already in flight. */
  retry: () => void
}

/**
 * Fetches the public stable and unstable catalogs through the netManager IPC
 * channel (the same bounded, allow-listed path every ModDB call already
 * rides) and merges them into one sorted, typed list.
 *
 * A failed fetch surfaces as `failed: true` instead of leaving the caller to
 * infer it from an empty list forever: the page renders one sentence and a
 * retry, rather than a spinner with nothing behind it.
 */
export function useGameVersionCatalog(): GameVersionCatalogState {
  const [gameVersions, setGameVersions] = useState<DownloadableGameVersionTypeType[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    ;(async (): Promise<void> => {
      try {
        const [stableText, unstableText] = await Promise.all([window.api.netManager.queryURL(`${VS_API}/stable.json`), window.api.netManager.queryURL(`${VS_API}/unstable.json`)])
        const stable = parseGameVersionCatalog(stableText)
        const unstable = parseGameVersionCatalog(unstableText)
        if (Object.keys(stable).length === 0 && Object.keys(unstable).length === 0) {
          throw new Error("Game version catalogs are empty.")
        }
        if (cancelled) return
        setGameVersions(parseGameVersions(stable, unstable))
        setLoading(false)
        setFailed(false)
      } catch (err) {
        window.api.utils.logMessage("error", `${LOG_TAG} Error fetching game versions.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} Error fetching game versions: ${err}`)
        if (cancelled) return
        setLoading(false)
        setFailed(true)
      }
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

  return { gameVersions, loading, failed, retry }
}
