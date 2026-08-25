import { backgroundThumbnailUrl } from "@domain/backgrounds"

/** Returns the remote preview named by the catalog, or no image for an older manifest row. */
export function backgroundThumbnailSource(thumbnail: string | undefined): string | undefined {
  return thumbnail ? backgroundThumbnailUrl(thumbnail) : undefined
}
