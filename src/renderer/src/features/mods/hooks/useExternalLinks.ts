import { useExternalLinks as useAppExternalLinks } from "@renderer/hooks/useExternalLinks"

const MODDB_MOD_PAGE_BASE = "https://mods.vintagestory.at/show/mod"

/** Opens a mod's ModDB page in the system browser. Shared by every "view on the ModDB" link. */
export function useExternalLinks(): { openModOnModDb: (assetid: number | string) => void } {
  const { openOnBrowser } = useAppExternalLinks()

  return {
    openModOnModDb: (assetid: number | string): void => openOnBrowser(`${MODDB_MOD_PAGE_BASE}/${assetid}`)
  }
}
