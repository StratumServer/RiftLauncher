import { useGetInstalledMods } from "./useGetInstalledMods"
import { useQueryMod } from "./useQueryMod"
import semver from "semver"

import { evaluateModCompatibility } from "@domain/mods/compatibility"
import { logMods } from "@renderer/features/moddb/adapters/log"

export function useGetCompleteInstalledMods(): ({ path, version, onFinish }: { path: string; version: string; onFinish?: (updates: number) => void }) => Promise<{
  mods: InstalledModType[]
  errors: ErrorInstalledModType[]
}> {
  const getInstalledMods = useGetInstalledMods()
  const queryMod = useQueryMod()

  /**
   * Get the mods installed on the selected folder, query each mod from the moddb and add it to the mod, check if there is any update and add it to the mod.
   *
   * @param {Object} props
   * @param {string} [props.path] Path to look for mods.
   * @param {string} [props.version] Installation/Server version to check if there are compatible updates WITHOUT "v"! Example: ~~v1.2.3~~ 1.2.3
   * @param {(updates: number) => void} [props.onFinish] Fuction called before returning mods. Updates is the number of updates found.
   * @returns {Promise<{mods: InstalledModType[]errors: ErrorInstalledModType[]}>} Mods with ModDB mods and updates(if any) and mods with errors.
   */
  async function getCompleteInstalledMods({ path, version, onFinish }: { path: string; version: string; onFinish?: (updates: number) => void }): Promise<{
    mods: InstalledModType[]
    errors: ErrorInstalledModType[]
  }> {
    let availableModUpdates = 0

    const mods = await getInstalledMods({
      path: path,
      onFinish: () => logMods("info", `[front] [mods] [features/mods/hooks/useGetCompleteInstalledMods.ts] [useGetCompleteInstalledMods > getCompleteInstalledMods] Mods got succesfully.`)
    })

    await Promise.all(
      mods.mods.map(async (mod) => {
        const dmod = await queryMod({ modid: mod.modid })
        mod._mod = dmod

        if (dmod) {
          for (const release of dmod.releases) {
            if (!mod.version || !release.modversion || !semver.valid(release.modversion) || !semver.valid(mod.version)) continue

            // Declared or same-minor both count as "worth offering": the tag compat check historically
            // treated "1.19.X" tags on a "1.19.6" install the same as an exact "1.19.6" tag, so only
            // "undeclared" is excluded here to keep this identical to that behaviour.
            const compatibleWithVersion = evaluateModCompatibility(release.tags, version) !== "undeclared"

            // 0 if it's the same version
            // 1 if the downloadable version < than the installed one
            // -1 if the downloadable version > than the isntalled one
            const newRelease = semver.compare(mod.version, release.modversion)

            if (compatibleWithVersion && newRelease === -1) {
              availableModUpdates++
              mod._updatableTo = release.modversion
              break
            } else if (!compatibleWithVersion && newRelease === -1 && !mod._lastVersion) {
              mod._lastVersion = release.modversion
            }
          }
        }
      })
    )

    logMods("info", `[front] [mods] [features/mods/hooks/useGetCompleteInstalledMods.ts] [useGetCompleteInstalledMods > getCompleteInstalledMods] Found ${availableModUpdates} mod updates.`)

    if (onFinish) onFinish(availableModUpdates)
    return mods
  }

  return getCompleteInstalledMods
}
