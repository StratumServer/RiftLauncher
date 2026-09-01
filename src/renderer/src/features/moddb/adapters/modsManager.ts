/**
 * Wraps the `modsManager` bridge calls mods hooks still need directly: reading an installation's
 * Mods folder, turning one of its mods on or off, writing a modpack archive, opening the modpack
 * file picker, and clearing the icon memory cache. See moddb.ts for why this lives outside
 * features/mods.
 */
export function fetchInstalledMods(path: string): Promise<{ mods: InstalledModType[]; errors: ErrorInstalledModType[] }> {
  return window.api.modsManager.getInstalledMods(path)
}

export function setModEnabled(path: string, enabled: boolean): Promise<SetModEnabledResult> {
  return window.api.modsManager.setModEnabled(path, enabled)
}

export function cacheModImage(url: string): Promise<string | undefined> {
  return window.api.modsManager.cacheModImage(url)
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
