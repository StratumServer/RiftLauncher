/**
 * Applying a permission bit to a folder tree, without the worker plumbing.
 *
 * The worker thread is a shim over this module, the same split extraction.ts
 * and innoExtraction.ts already use, so the same code can be driven from a test
 * or a script. Nothing here touches Electron or `worker_threads`.
 *
 * This exists for the Linux game folder, whose executables come out of the
 * archive without the execute bit. A symbolic link inside the tree stops the
 * whole run rather than being followed: chmod resolves links, so following one
 * would apply the launcher's bits to a file outside the folder the user picked.
 */

import fse from "fs-extra"
import { join } from "node:path"

const MAX_ITEMS = 100_000

/** The slice of the filesystem this walk needs, so a test can stand in a fake tree. */
export interface PermissionsFileSystem {
  existsSync(path: string): boolean
  lstatSync(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }
  readdirSync(path: string): string[]
  chmodSync(path: string, mode: number): void
}

const nodeFileSystem: PermissionsFileSystem = {
  existsSync: (path) => fse.existsSync(path),
  lstatSync: (path) => fse.lstatSync(path),
  readdirSync: (path) => fse.readdirSync(path),
  chmodSync: (path, mode) => fse.chmodSync(path, mode)
}

export interface ChangePermissionsOptions {
  /** Roots to walk. Each is applied to itself and to everything beneath it. */
  paths: readonly string[]
  /** Mode passed straight to `chmod`. */
  perms: number
  /** Filesystem to act on, defaulting to the real one. */
  fileSystem?: PermissionsFileSystem
}

/**
 * Applies `perms` to every path given and to everything under it.
 *
 * A path that does not exist is skipped, which is what lets a caller pass the
 * union of the paths a Linux install might use without checking each one first.
 *
 * @param options Roots, mode, and the filesystem to act on.
 * @throws On a symbolic link, on an entry that is neither a file nor a folder,
 * and once the tree passes the entry cap. Nothing is rolled back: the caller
 * reports the failure and the bits already applied stay applied.
 */
export function changePermissions(options: ChangePermissionsOptions): void {
  const { paths, perms, fileSystem = nodeFileSystem } = options
  let itemCount = 0

  const visit = (path: string): void => {
    if (!fileSystem.existsSync(path)) return

    const stats = fileSystem.lstatSync(path)
    if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed")
    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")

    if (stats.isDirectory()) {
      for (const item of fileSystem.readdirSync(path)) visit(join(path, item))
    }

    if (!stats.isDirectory() && !stats.isFile()) throw new Error("Unsupported filesystem entry")
    fileSystem.chmodSync(path, perms)
  }

  for (const path of paths) visit(path)
}
