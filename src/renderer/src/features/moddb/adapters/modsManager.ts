/**
 * Wraps the `modsManager` bridge calls mods hooks still need directly: reading an installation's
 * Mods folder, turning one of its mods on or off, writing a modpack archive, opening the modpack
 * file picker, and clearing the icon memory cache. See moddb.ts for why this lives outside
 * features/mods.
 */
import type { ModBatchPorts } from "@domain/mods/batch"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"

export function fetchInstalledMods(path: string): Promise<InstalledModsScan> {
  return window.api.modsManager.getInstalledMods(path)
}

export function setModEnabled(path: string, enabled: boolean): Promise<SetModEnabledResult> {
  return window.api.modsManager.setModEnabled(path, enabled)
}

/** The host calls a batch of Mods is made of, for the domain's setModsEnabled and removeMods. */
export function createModBatchPorts(): ModBatchPorts {
  return { setEnabled: setModEnabled, remove: (path) => createFileSystemPort().remove(path) }
}

/** Reads an Installation's profiles file. The host names the file; this only names the Installation. */
export function fetchModProfiles(installationPath: string): Promise<ModProfilesReadResult> {
  return window.api.modsManager.getModProfiles(installationPath)
}

export function saveModProfiles(installationPath: string, document: ModProfilesDocument): Promise<ModProfilesSaveResult> {
  return window.api.modsManager.saveModProfiles(installationPath, document)
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
