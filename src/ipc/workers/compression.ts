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

const MAX_ITEMS = 100_000

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
    throw new Error("Compression failed")
  }

  onProgress?.(100)
}
