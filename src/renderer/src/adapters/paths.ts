import type { PathBuilder } from "@domain/ports"

/** Wires the PathBuilder port onto the preload path primitives. */
export function createPathBuilderPort(): PathBuilder {
  return { join: (parts) => window.api.pathsManager.formatPath(parts) }
}
