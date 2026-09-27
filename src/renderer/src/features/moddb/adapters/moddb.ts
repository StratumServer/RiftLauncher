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

/**
 * Hands the player's answer to the ModDB listing question over to the main process, which writes
 * it and then counts the running version on the listing when the answer says to (#219, #477).
 *
 * `consent` is the answer they just gave, or null for the silent count a stored "always" owes this
 * launch. Answers the outcome and the state that reached disk, which the caller mirrors into the
 * config so both copies agree on what has been counted.
 */
export function countModDbDownload(consent: ModDbVisibilityConsentValue | null): Promise<ModDbCountResult> {
  return window.api.netManager.countModDbDownload(consent)
}
