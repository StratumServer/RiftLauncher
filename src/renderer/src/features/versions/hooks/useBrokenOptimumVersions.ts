import { useEffect, useState } from "react"

import { requiredOptimumAssemblies } from "@domain/optimum/plan"

/**
 * Which registered Optimum builds are missing assemblies required to run.
 *
 * Hash verification after a patch proves what the overlay wrote, but cannot
 * catch an assembly the overlay forgot to ship (such as Optimum.GameContent.dll
 * in 0.3.19). A build whose required assemblies are missing on disk cannot
 * enter a world. The Versions list flags that broken state on its row and
 * keeps Remove Optimum reachable so the player has a way back.
 */
export function useBrokenOptimumVersions(versions: readonly GameVersionType[], optimumBackups: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    void (async (): Promise<void> => {
      const broken = await Promise.all(
        versions.map(async (version) => {
          const isOptimum = version.variant?.name === "Optimum" || optimumBackups.has(version.id)
          if (!isOptimum) return undefined

          const required = requiredOptimumAssemblies(version.variant?.version)
          try {
            for (const assembly of required) {
              const fullPath = await window.api.pathsManager.formatPath([version.path, assembly])
              const exists = await window.api.pathsManager.checkPathExists(fullPath)
              if (!exists) return version.id
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
