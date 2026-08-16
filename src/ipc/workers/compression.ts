/**
 * Packing a folder into an archive, without the worker plumbing.
 *
 * The worker thread is a shim over this module, the same split extraction.ts
 * and innoExtraction.ts already use, so the same code can be driven from a test
 * or a script. Nothing here touches Electron or `worker_threads`.
 *
 * The source tree is walked before 7-Zip is handed anything: a symbolic link or
 * a device node in there would be followed into whatever it points at, and an
 * unbounded tree would keep the worker busy indefinitely.
 */

import type { EventEmitter } from "events"
import Seven from "node-7z"
import fse from "fs-extra"
import { join } from "path"

const MAX_ITEMS = 100_000

/** The `Seven.add` shape, so a test can drive the progress and end events without spawning 7-Zip. */
export type ArchiveAdd = (archivePath: string, source: string, options: NonNullable<Parameters<typeof Seven.add>[2]>) => EventEmitter

/**
 * Refuses a source tree holding anything but plain files and folders, or more
 * entries than the launcher ever legitimately backs up.
 *
 * @param root Folder about to be archived.
 * @param fileSystem Filesystem to walk, defaulting to the real one.
 * @throws When an entry is a symbolic link or a special file, or the tree is too large.
 */
export function assertSafeCompressionTree(root: string, fileSystem: Pick<typeof fse, "lstatSync" | "readdirSync"> = fse): void {
  const pending = [root]
  let itemCount = 0

  while (pending.length > 0) {
    const current = pending.pop() as string
    const stats = fileSystem.lstatSync(current)
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("Compression source contains an unsafe filesystem entry")

    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")
    if (stats.isDirectory()) {
      for (const child of fileSystem.readdirSync(current)) pending.push(join(current, child))
    }
  }
}

export interface CompressionOptions {
  /** Folder whose contents are archived. Its own name is not kept. */
  inputPath: string
  /** Folder the archive is written into. Created when missing. */
  outputPath: string
  /** Archive file name, taken as given. */
  outputFileName: string
  /** 7-Zip `-mx` level, 0 to 9. */
  compressionLevel?: number
  /** 7-Zip binary. */
  sevenZipBin?: string
  /** Injected `Seven.add`, defaulting to the real one. */
  addArchive?: ArchiveAdd
  /** Called with 0 to 100 as the work advances, and once with 100 at the end. */
  onProgress?: (progress: number) => void
}

/**
 * Compresses one folder into one archive.
 *
 * @param options Source, destination, and how to report progress.
 * @throws As a rejection, for an unsafe source or destination and for a 7-Zip
 * failure alike. The caller reports "Compression failed" either way.
 */
export function runCompression(options: CompressionOptions): Promise<void> {
  const { inputPath, outputPath, outputFileName, compressionLevel = 6, sevenZipBin, addArchive = Seven.add, onProgress } = options

  return new Promise<void>((resolvePromise, rejectPromise) => {
    assertSafeCompressionTree(inputPath)
    if (!fse.existsSync(inputPath) || !fse.lstatSync(inputPath).isDirectory()) throw new Error("Compression source must be a directory")
    if (!fse.existsSync(outputPath)) fse.mkdirSync(outputPath, { recursive: true })
    if (fse.lstatSync(outputPath).isSymbolicLink() || !fse.lstatSync(outputPath).isDirectory()) throw new Error("Compression destination is unsafe")

    const archivePath = join(outputPath, outputFileName)
    if (fse.existsSync(archivePath)) {
      const archiveStats = fse.lstatSync(archivePath)
      if (archiveStats.isSymbolicLink() || archiveStats.isDirectory()) throw new Error("Compression archive target is unsafe")
    }
    const sourceGlob = join(inputPath, "*")

    const stream = addArchive(archivePath, sourceGlob, {
      $bin: sevenZipBin,
      $progress: true,
      recursive: true,
      method: [`x=${compressionLevel}`, "mt=on"]
    })

    let lastReportedProgress = 0

    stream.on("progress", ({ percent }: { percent: unknown }) => {
      const boundedPercent = Number(percent)
      if (Number.isFinite(boundedPercent) && boundedPercent >= lastReportedProgress && boundedPercent <= 100) {
        lastReportedProgress = boundedPercent
        onProgress?.(boundedPercent)
      }
    })

    stream.on("end", () => {
      onProgress?.(100)
      resolvePromise()
    })

    stream.on("error", () => {
      rejectPromise(new Error("Compression failed"))
    })
  })
}
