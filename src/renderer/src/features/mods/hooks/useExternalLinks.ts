import { openExternalLink } from "@renderer/features/moddb/adapters/links"

const MODDB_MOD_PAGE_BASE = "https://mods.vintagestory.at/show/mod"

/** Opens a mod's ModDB page in the system browser. Shared by every "view on the ModDB" link. */
export function useExternalLinks(): { openModOnModDb: (assetid: number | string) => void } {
  return {
    openModOnModDb: (assetid: number | string): void => openExternalLink(`${MODDB_MOD_PAGE_BASE}/${assetid}`)
  }
}
