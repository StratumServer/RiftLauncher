import { useEffect, useState } from "react"

import { OPTIMUM_STATE_FOLDER, OPTIMUM_VANILLA_FOLDER } from "@domain/optimum/plan"

/**
 * Which registered builds hold a copy of their original game files.
 *
 * The row's own `variant` is not enough to decide whether Remove Optimum is
 * worth offering. A patch that ran and then failed the launcher's own reading of
 * the folder afterwards leaves the four originals in
 * `<game-dir>/.optimum/vanilla/` and the row unregistered, and gating the action
 * on the variant would leave exactly that folder with no way back. What is asked
 * here is the one thing the restore itself depends on: whether there is a backup
 * on disk.
 *
 * A row that already reads as Optimum is not probed. It carries the action
 * either way, and a patched build with no backup is refused by the main process
 * with a sentence of its own rather than by hiding the button.
 */
export function useOptimumBackups(versions: readonly GameVersionType[]): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    void (async (): Promise<void> => {
      const found = await Promise.all(
        versions.map(async (version) => {
          if (version.variant) return version.id
          try {
            const backup = await window.api.pathsManager.formatPath([version.path, OPTIMUM_STATE_FOLDER, OPTIMUM_VANILLA_FOLDER])
            return (await window.api.pathsManager.checkPathExists(backup)) ? version.id : undefined
          } catch {
            // A folder that cannot be looked at is one the restore could not read either.
            return undefined
          }
        })
      )

      if (!cancelled) setIds(new Set(found.filter((id): id is string => id !== undefined)))
    })()

    return (): void => {
      cancelled = true
    }
  }, [versions])

  return ids
}
