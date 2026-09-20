/**
 * Applying a permission bit to a folder tree.
 *
 * This exists for the Linux game folder, whose executables come out of the
 * archive without the execute bit. A symbolic link inside the tree stops the
 * whole run rather than being followed: chmod resolves links, so following one
 * would apply the launcher's bits to a file outside the folder the user picked.
 *
 * The walk is I/O and nothing else, so it runs on the main thread's event loop
 * rather than in a worker: every step is an awaited syscall, and none of them
 * holds the loop. Nothing here touches Electron.
 */

import { chmod, lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

const MAX_ITEMS = 100_000

/** The slice of the filesystem this walk needs, so a test can stand in a fake tree. `node:fs/promises` satisfies it as it is. */
export interface PermissionsFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>
  readdir(path: string): Promise<string[]>
  chmod(path: string, mode: number): Promise<void>
}

export interface ChangePermissionsOptions {
  /** Roots to walk. Each is applied to itself and to everything beneath it. */
  paths: readonly string[]
  /** Mode passed straight to `chmod`. */
  perms: number
  /** Stops the walk before its next entry. The caller's bound on a tree that never ends. */
  signal?: AbortSignal
  /** Filesystem to act on, defaulting to the real one. */
  fileSystem?: PermissionsFileSystem
}

/**
 * Applies `perms` to every path given and to everything under it.
 *
 * A path that cannot be stat'd is skipped, which is what lets a caller pass the
 * union of the paths a Linux install might use without checking each one first.
 *
 * @param options Roots, mode, abort signal, and the filesystem to act on.
 * @throws On a symbolic link, on an entry that is neither a file nor a folder,
 * once the tree passes the entry cap, and on an aborted signal. Nothing is
 * rolled back: the caller reports the failure and the bits already applied stay
 * applied.
 */
export async function changePermissions(options: ChangePermissionsOptions): Promise<void> {
  const { paths, perms, signal, fileSystem = { lstat, readdir, chmod } } = options
  let itemCount = 0

  const visit = async (path: string): Promise<void> => {
    signal?.throwIfAborted()

    // Anything the filesystem will not describe is skipped rather than refused, missing paths
    // included: the caller passes the union of the paths a Linux install might use and lets
    // the walk sort out which of them are there.
    const stats = await fileSystem.lstat(path).catch(() => null)
    if (!stats) return

    if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed")
    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")

    if (stats.isDirectory()) {
      for (const item of await fileSystem.readdir(path)) await visit(join(path, item))
    }

    if (!stats.isDirectory() && !stats.isFile()) throw new Error("Unsupported filesystem entry")
    await fileSystem.chmod(path, perms)
  }

  for (const path of paths) await visit(path)
}
