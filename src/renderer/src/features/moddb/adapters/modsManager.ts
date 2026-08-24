/**
 * Wraps the four `modsManager` bridge calls mods hooks still need directly: reading an
 * installation's Mods folder, writing a modpack archive, opening the modpack file picker, and
 * clearing the icon memory cache. See moddb.ts for why this lives outside features/mods.
 */
export function fetchInstalledMods(path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  return window.api.modsManager.getInstalledMods(path)
}

export function exportModpackArchive(manifest: ModpackManifestType): Promise<{ success: boolean; path?: string }> {
  return window.api.modsManager.exportModpack(manifest)
}

export function importModpackArchive(): Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }> {
  return window.api.modsManager.importModpack()
}

export function clearModIconMemoryCache(): void {
  window.api.modsManager.clearModIconMemoryCache()
}
