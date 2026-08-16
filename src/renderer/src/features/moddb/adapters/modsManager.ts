/**
 * Wraps the two `modsManager` bridge calls mods hooks still need directly: reading an
 * installation's Mods folder, and writing a modpack archive. See moddb.ts for why this lives
 * outside features/mods.
 */
export function fetchInstalledMods(path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  return window.api.modsManager.getInstalledMods(path)
}

export function exportModpackArchive(manifest: ModpackManifestType): Promise<{ success: boolean; path?: string }> {
  return window.api.modsManager.exportModpack(manifest)
}
