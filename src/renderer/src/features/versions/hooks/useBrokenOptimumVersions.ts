import { useEffect, useState } from "react"

import { OPTIMUM_ASSEMBLY_SEARCH_FOLDERS, OPTIMUM_DEPLOYED_ASSEMBLIES } from "@domain/optimum/plan"

/**
 * Which registered Optimum builds are missing assemblies required to run.
 *
 * Hash verification after a patch proves what the overlay wrote, but cannot
 * catch an assembly the overlay forgot to ship (as overlays 0.3.18 and 0.3.19
 * did with Optimum.GameContent.dll). A build whose required assemblies are missing on disk cannot
 * enter a world. The Versions list flags that broken state on its row and
 * keeps Remove Optimum reachable so the player has a way back.
 */
export function useBrokenOptimumVersions(versions: readonly GameVersionType[], optimumBackups: ReadonlySet<string>): ReadonlySet<string> {
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    void (async (): Promise<void> => {
      const broken = await Promise.all(
        versions.map(async (version) => {
          const isOptimum = version.variant?.name === "Optimum" || optimumBackups.has(version.id)
          if (!isOptimum) return undefined

          const required = OPTIMUM_DEPLOYED_ASSEMBLIES
          try {
            for (const assembly of required) {
              let found = false
              for (const folder of OPTIMUM_ASSEMBLY_SEARCH_FOLDERS) {
                const parts = folder ? [version.path, folder, assembly] : [version.path, assembly]
                const fullPath = await window.api.pathsManager.formatPath(parts)
                if (await window.api.pathsManager.checkPathExists(fullPath)) {
                  found = true
                  break
                }
              }
              if (!found) return version.id
            }
            return undefined
          } catch {
            return undefined
          }
        })
      )

      if (!cancelled) {
        setBrokenIds(new Set(broken.filter((id): id is string => id !== undefined)))
      }
    })()

    return (): void => {
      cancelled = true
    }
  }, [versions, optimumBackups])

  return brokenIds
}
