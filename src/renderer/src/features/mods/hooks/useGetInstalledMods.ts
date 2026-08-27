import { resolveModsFolder } from "@renderer/features/mods/adapters/folder"
import { fetchInstalledMods } from "@renderer/features/moddb/adapters/modsManager"
import { logMods } from "@renderer/features/moddb/adapters/log"

/**
 * Makes a query and returns all the mods from the selected path.
 *
 * @param {object} props
 * @param {string} [props.path] Where to look for the mods. Not the Mods folder! It'll append Mods at the end.
 * @param {() => void} [props.onFinish] Optional function that will be called just before returning the mod.
 * @returns {Promise<void>}
 */
async function getInstalledMods({ path, onFinish }: { path: string; onFinish?: () => void }): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  try {
    const fullPath = await resolveModsFolder(path)
    const mods = await fetchInstalledMods(fullPath)

    if (onFinish) onFinish()

    return mods
  } catch (err) {
    logMods("error", `[front] [mods] [features/mods/hooks/useGetInstalledMods.ts] [useGetInstalledMods > getInstalledMods] Error getting mods installed on ${path}.`)
    logMods("debug", `[front] [mods] [features/mods/hooks/useGetInstalledMods.ts] [useGetInstalledMods > getInstalledMods] Error getting mods installed on ${path}: ${err}`)
    return { mods: [], errors: [] }
  }
}

export function useGetInstalledMods(): ({ path, onFinish }: { path: string; onFinish?: () => void }) => Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  return getInstalledMods
}
