import { backgroundCacheFileName, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"

import defaultBackground from "@renderer/assets/background.jpg"

/**
 * The Tailwind theme variable behind the `bg-image-vs` utility (src/renderer/src/styles.css).
 *
 * Setting it on the root element is the whole of "apply a background": the three elements that
 * paint the scene (the app shell and the loader overlay in App.tsx, and PopupDialogPanel) all
 * resolve it, so none of them needs to know a choice exists.
 */
const BACKGROUND_IMAGE_PROPERTY = "--background-image-image-vs"

/** The URL the `background:` protocol serves one cached scene under. */
export function backgroundImageSource(id: string, revision: number): string {
  return `background:${backgroundCacheFileName(id)}?r=${revision}`
}

/**
 * Paints the chosen background, or clears the override so the stylesheet's bundled scene shows.
 *
 * The chosen scene is laid over the bundled one rather than replacing it. A background layer that
 * fails to load is skipped and the layer under it paints, so an id whose cached file has been
 * deleted, or has not been downloaded yet, quietly falls back to the scene that ships with the app
 * instead of leaving a blank window.
 */
export function applyBackground(id: string, revision: number): void {
  const root = document.documentElement

  if (id === DEFAULT_BACKGROUND_ID) {
    root.style.removeProperty(BACKGROUND_IMAGE_PROPERTY)
    return
  }

  root.style.setProperty(BACKGROUND_IMAGE_PROPERTY, `url("${backgroundImageSource(id, revision)}"), url("${defaultBackground}")`)
}
