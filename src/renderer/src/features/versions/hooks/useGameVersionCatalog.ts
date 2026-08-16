import { useEffect, useState } from "react"

import { compareVersions } from "@domain/versionNumbers"

// Official public API: https://api.vintagestory.at/{stable,unstable}.json
// Shape: { [version]: { [platform]: { filename, filesize, md5, urls: { cdn, local }, ... } } }
type RawPlatform = { filename?: string; urls: { cdn: string; local: string } }
type RawVersions = Record<string, Record<string, RawPlatform>>
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

/**
 * Fetches the public stable and unstable catalogs and merges them into one
 * sorted, typed list. Empty until the first successful fetch resolves, and
 * stays that way on failure: the view already renders a loading spinner for
 * an empty list, so a fetch that fails just leaves that spinner up instead of
 * gaining its own error state.
 */
export function useGameVersionCatalog(): DownloadableGameVersionTypeType[] {
  const [gameVersions, setGameVersions] = useState<DownloadableGameVersionTypeType[]>([])

  useEffect(() => {
    ;(async (): Promise<void> => {
      try {
        const [stableResponse, unstableResponse] = await Promise.all([fetch(`${VS_API}/stable.json`), fetch(`${VS_API}/unstable.json`)])
        if (!stableResponse.ok || !unstableResponse.ok) throw new Error("Game version API request failed")
        const [stable, unstable] = (await Promise.all([stableResponse.json(), unstableResponse.json()])) as [RawVersions, RawVersions]
        setGameVersions(parseGameVersions(stable, unstable))
      } catch (err) {
        window.api.utils.logMessage("error", `${LOG_TAG} Error fetching game versions.`)
        window.api.utils.logMessage("debug", `${LOG_TAG} Error fetching game versions: ${err}`)
      }
    })()
  }, [])

  return gameVersions
}
