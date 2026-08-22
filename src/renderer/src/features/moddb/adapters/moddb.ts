const MODDB_API_BASE = "https://mods.vintagestory.at/api"

/**
 * Fetches a ModDB v1 endpoint through the preload bridge.
 *
 * `path` is the endpoint path only (e.g. "/mods", "/authors"); the base URL is applied here so
 * every caller builds the exact same request it always has.
 *
 * Lives outside features/mods on purpose: no file under that tree may mention window.api. This
 * is the mods feature's equivalent of the shared src/renderer/src/adapters/** port layer, for its
 * remaining IPC surface (ModDB queries, the installed-mods read, modpack export, logging).
 */
export function queryModDb(path: string): Promise<string> {
  return window.api.netManager.queryURL(`${MODDB_API_BASE}${path}`)
}
