/** Opens the modpack file picker and parses the chosen manifest, straight off the preload bridge. */
export function useImportModpackTrigger(): () => Promise<{ success: boolean; manifest?: ModpackManifestType; error?: string }> {
  return () => window.api.modsManager.importModpack()
}
