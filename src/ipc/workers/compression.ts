/**
 * Packing a folder into an archive, without the worker plumbing.
 *
 * The worker thread is a shim over this module, the same split extraction.ts
 * and innoExtraction.ts already use, so the same code can be driven from a test
 * or a script. Nothing here touches Electron or `worker_threads`.
 *
 * Backups are written as gzipped tar through the same `tar` package the game
 * archives are already read with. The source tree is walked before tar is
 * handed anything: a symbolic link or a device node in there would be followed
 * into whatever it points at, and an unbounded tree would keep the worker busy
 * indefinitely. The walk also totals the bytes, which is what progress is
 * measured against.
 */

import fse from "fs-extra"
import { join } from "node:path"
import * as tar from "tar"

import { DEFAULT_COMPRESSION_LEVEL } from "@domain/config/defaults"

// Relative so the module stays importable from a plain test run, like extraction.ts.
import { MAX_ARCHIVE_TOTAL_BYTES } from "../validation"

const MAX_ITEMS = 100_000

/**
 * The link cache tar keeps while it packs, rigged never to report a hit.
 *
 * tar looks a file up in here by `dev:ino` whenever its `nlink` is above one,
 * and on a hit writes the second name as a `Link` entry pointing at the first
 * instead of writing its bytes again. The restore reader refuses `Link`, so
 * that backup reports success and can never be put back. A cache that answers
 * nothing sends every name down the ordinary file path, so both names come out
 * of the archive as independent copies carrying their own bytes.
 *
 * Deduplicating filesystems hand out hard links on their own, so a player can
 * have them without ever having made one. Refusing the source instead would
 * cost them backups entirely; this costs them the sharing, which was a disk
 * layout detail rather than anything the installation depends on.
 *
 * The key type matches tar's own `LinkCacheKey`, which the package does not
 * re-export from its entry point.
 */
class UnsharedLinkCache extends Map<`${number}:${number}`, string> {
  get(): undefined {
    return undefined
  }
}

/**
 * Refuses a source tree holding anything but plain files and folders, or more
 * entries than the launcher ever legitimately backs up.
 *
 * @param root Folder about to be archived.
 * @param fileSystem Filesystem to walk, defaulting to the real one.
 * @returns Total size in bytes of every plain file in the tree.
 * @throws When an entry is a symbolic link or a special file, or the tree is too large.
 */
export function assertSafeCompressionTree(root: string, fileSystem: Pick<typeof fse, "lstatSync" | "readdirSync"> = fse): number {
  const pending = [root]
  let itemCount = 0
  let totalBytes = 0

  while (pending.length > 0) {
    const current = pending.pop() as string
    const stats = fileSystem.lstatSync(current)
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("Compression source contains an unsafe filesystem entry")

    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")
    if (stats.isDirectory()) {
      for (const child of fileSystem.readdirSync(current)) pending.push(join(current, child))
    } else {
      totalBytes += stats.size
    }
  }

  return totalBytes
}

export interface CompressionOptions {
  /** Folder whose contents are archived. Its own name is not kept. */
  inputPath: string
  /** Folder the archive is written into. Created when missing. */
  outputPath: string
  /** Archive file name, taken as given. */
  outputFileName: string
  /** gzip level, 0 to 9. Same scale the config's compressionLevel has always carried. */
  compressionLevel?: number
  /** Called with 0 to 100 as the work advances, and once with 100 at the end. */
  onProgress?: (progress: number) => void
}

/**
 * Compresses one folder into one archive.
 *
 * @param options Source, destination, and how to report progress.
 * @throws As a rejection, for an unsafe source or destination and for a failed
 * write alike. The caller reports "Compression failed" either way.
 */
export async function runCompression(options: CompressionOptions): Promise<void> {
  const { inputPath, outputPath, outputFileName, compressionLevel = DEFAULT_COMPRESSION_LEVEL, onProgress } = options

  const totalBytes = assertSafeCompressionTree(inputPath)
  // The restore reader holds an archive to this same total and refuses anything
  // past it, so an installation over the cap would compress happily into a
  // backup that can never be put back. Refusing here costs the player a failed
  // backup; not refusing costs them a backup they only find out is useless on
  // the day they need it, and one prune slot that an older, restorable backup
  // used to hold.
  if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("Compression source is too large")
  if (!fse.existsSync(inputPath) || !fse.lstatSync(inputPath).isDirectory()) throw new Error("Compression source must be a directory")
  if (!fse.existsSync(outputPath)) fse.mkdirSync(outputPath, { recursive: true })
  if (fse.lstatSync(outputPath).isSymbolicLink() || !fse.lstatSync(outputPath).isDirectory()) throw new Error("Compression destination is unsafe")

  const archivePath = join(outputPath, outputFileName)
  if (fse.existsSync(archivePath)) {
    const archiveStats = fse.lstatSync(archivePath)
    if (archiveStats.isSymbolicLink() || archiveStats.isDirectory()) throw new Error("Compression archive target is unsafe")
  }

  const entries = fse.readdirSync(inputPath)
  let writtenBytes = 0
  let lastReportedProgress = 0

  try {
    await tar.create(
      {
        file: archivePath,
        cwd: inputPath,
        gzip: { level: compressionLevel },
        portable: true,
        // Two names for one inode would otherwise become a Link entry the
        // restore reader refuses. See UnsharedLinkCache above.
        linkCache: new UnsharedLinkCache(),
        // `entry.size` is not filled in yet when this runs, and the stat behind
        // the entry is the same number the walk above totalled. Folders are
        // skipped for the same reason the walk skipped them: their stat size is
        // the directory's own on-disk size, which is not content.
        onWriteEntry: (entry) => {
          writtenBytes += entry.stat?.isFile() ? entry.stat.size : 0
          if (totalBytes <= 0) return
          // The terminal 100 below is the only one this ever reports, so the
          // running figure is capped a point short of it.
          const progress = Math.min(99, Math.floor((writtenBytes / totalBytes) * 100))
          if (progress > lastReportedProgress) {
            lastReportedProgress = progress
            onProgress?.(progress)
          }
        }
      },
      // A folder with nothing in it is still a folder worth backing up, and tar
      // refuses an empty list of paths. "." archives the folder itself, which
      // unpacks back to an empty folder rather than to nothing at all.
      entries.length > 0 ? entries : ["."]
    )
  } catch {
    // tar opens the archive as soon as it starts, so a write that failed partway
    // leaves a truncated file sitting in the backups folder. No backup record
    // ever names it, which is exactly what pruning walks, so it would never be
    // cleaned up and every retry would leave another one.
    try {
      fse.removeSync(archivePath)
    } catch {
      // Best effort. The compression failure below is the outcome that matters.
    }
    throw new Error("Compression failed")
  }

  onProgress?.(100)
}
