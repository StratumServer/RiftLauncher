/**
 * Wraps the three `modsManager` bridge calls mods hooks still need directly: reading an
 * installation's Mods folder, writing a modpack archive, and clearing the icon memory cache.
 * See moddb.ts for why this lives outside features/mods.
 */
export function fetchInstalledMods(path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  return window.api.modsManager.getInstalledMods(path)
}

export function exportModpackArchive(manifest: ModpackManifestType): Promise<{ success: boolean; path?: string }> {
  return window.api.modsManager.exportModpack(manifest)
}

export function clearModIconMemoryCache(): void {
  window.api.modsManager.clearModIconMemoryCache()
}
