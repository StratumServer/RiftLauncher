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

/** Reads the Mods the game downloaded per server. The host names the folder; this names the Installation. */
export function fetchServerMods(installationPath: string): Promise<ServerModsScan> {
  return window.api.modsManager.getServerMods(installationPath)
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

/**
 * Reads the mod configs an Installation already has, so a pack's rows can be told apart from the
 * ones a player has never seen. The host names the folder; this names the Installation.
 */
export function fetchModConfigs(installationPath: string): Promise<ModConfigsReadResult> {
  return window.api.modsManager.getModConfigs(installationPath)
}

/** Writes the chosen configs into an Installation. The host does the backups, the refusals and the writes. */
export function applyModConfigs(installationPath: string, files: { name: string; text: string; sha256: string }[]): Promise<ApplyModConfigsResult> {
  return window.api.modsManager.applyModConfigs(installationPath, files)
}

/**
 * `includeConfigs` is a request to read the Installation's own `ModConfig` folder, not a list of
 * files: the host is what reads it, so a renderer cannot put a path in a pack.
 */
export function exportModpackArchive(
  manifest: ModpackManifestType,
  installationPath: string,
  includeConfigs: boolean,
  configNames?: readonly string[]
): Promise<{ success: boolean; path?: string; reason?: ExportModpackRefusal; name?: string }> {
  return window.api.modsManager.exportModpack(manifest, installationPath, includeConfigs, configNames)
}

export function importModpackArchive(): Promise<{ success: boolean; manifest?: ModpackManifestType; settingsRefused?: SettingsRefused; error?: string }> {
  return window.api.modsManager.importModpack()
}

export function clearModIconMemoryCache(): void {
  window.api.modsManager.clearModIconMemoryCache()
}
