import type { FileSystem } from "@domain/ports"

/** Wires the FileSystem port onto the preload path primitives. */
export function createFileSystemPort(): FileSystem {
  return {
    exists: (path) => window.api.pathsManager.checkPathExists(path),
    remove: (path) => window.api.pathsManager.deletePath(path),
    move: (from, to) => window.api.pathsManager.movePath(from, to)
  }
}
