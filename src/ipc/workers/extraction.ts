/**
 * Unpacking an archive into a folder, without the worker plumbing.
 *
 * The worker thread is a shim over this module so the same code can be driven
 * from a test or a script. Nothing here touches Electron or `worker_threads`.
 *
 * Every archive lands in a temporary folder first. The tree is validated there,
 * and only then copied into the destination, so a hostile archive never gets to
 * write a single byte where the launcher keeps its files.
 */

import Seven from "node-7z"
import fse from "fs-extra"
import { createReadStream, mkdtempSync } from "fs"
import { isAbsolute, join, relative, resolve, sep } from "path"
import { tmpdir } from "os"
import * as tar from "tar"

// Relative so the module stays importable from a plain test run, like validation.ts.
import { isSafeTarEntryType, isTarGzName } from "../validation"

const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_ARCHIVE_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

export function assertNoSymlinkComponents(pathValue: string): void {
  let current = resolve(pathValue)
  let parent = resolve(current, "..")
  while (!fse.existsSync(current)) {
    if (parent === current) return
    current = parent
    parent = resolve(current, "..")
  }

  while (current !== parent) {
    const stats = fse.lstatSync(current)
    if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed")
    current = parent
    parent = resolve(current, "..")
  }

  if (fse.lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links are not allowed")
}

export type ArchiveStats = { entries: number; bytes: number; inodes: Set<string> }

export function validateTree(root: string): ArchiveStats {
  const stats: ArchiveStats = { entries: 0, bytes: 0, inodes: new Set<string>() }
  const visit = (current: string): void => {
    const entry = fse.lstatSync(current)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Archive contains an unsafe filesystem entry")

    stats.entries++
    if (stats.entries > MAX_ARCHIVE_ENTRIES) throw new Error("Archive contains too many entries")
    if (entry.isFile()) {
      if (entry.size > MAX_ARCHIVE_ENTRY_BYTES || stats.bytes + entry.size > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("Archive is too large")
      const inode = `${entry.dev}:${entry.ino}`
      if (stats.inodes.has(inode)) throw new Error("Archive contains hard links")
      stats.inodes.add(inode)
      stats.bytes += entry.size
      return
    }

    for (const child of fse.readdirSync(current)) visit(join(current, child))
  }

  visit(root)
  return stats
}

export function copyTree(sourceRoot: string, destinationRoot: string): void {
  assertNoSymlinkComponents(destinationRoot)
  fse.ensureDirSync(destinationRoot)
  if (fse.lstatSync(destinationRoot).isSymbolicLink()) throw new Error("Destination is a symbolic link")
  const resolvedDestinationRoot = resolve(destinationRoot)

  const copyEntry = (source: string): void => {
    const entry = fse.lstatSync(source)
    const relativePath = relative(sourceRoot, source)
    if (!relativePath) {
      for (const child of fse.readdirSync(source)) copyEntry(join(source, child))
      return
    }

    const destination = resolve(resolvedDestinationRoot, relativePath)
    const destinationRelativePath = relative(resolvedDestinationRoot, destination)
    if (!destinationRelativePath || destinationRelativePath === ".." || destinationRelativePath.startsWith(`..${sep}`) || isAbsolute(destinationRelativePath))
      throw new Error("Archive output escaped its root")
    assertNoSymlinkComponents(destination)

    if (entry.isDirectory()) {
      if (fse.existsSync(destination) && !fse.lstatSync(destination).isDirectory()) throw new Error("Archive output type conflict")
      fse.ensureDirSync(destination)
      for (const child of fse.readdirSync(source)) copyEntry(join(source, child))
      return
    }

    if (fse.existsSync(destination)) {
      const existing = fse.lstatSync(destination)
      if (existing.isSymbolicLink() || existing.isDirectory()) throw new Error("Archive output contains an unsafe destination")
      fse.unlinkSync(destination)
    }
    fse.copyFileSync(source, destination)
  }

  copyEntry(sourceRoot)
}

/**
 * The folder to copy from, once an archive's single wrapping folder is skipped.
 *
 * The Linux game archives carry everything under `vintagestory/`, so copying the
 * extraction root verbatim would put the game one level below the folder the
 * user picked and the executable check would rightly refuse it. Only an
 * unambiguous case is flattened: exactly one entry at the root, and a directory.
 * The server archives, which are already flat, come back unchanged.
 *
 * @param root Folder the archive was extracted into.
 * @returns The single root directory, or `root` itself when there is not exactly one.
 */
export function contentRoot(root: string): string {
  const entries = fse.readdirSync(root)
  const onlyEntry = entries.length === 1 ? entries[0] : undefined
  if (onlyEntry === undefined) return root

  const candidate = join(root, onlyEntry)
  return fse.lstatSync(candidate).isDirectory() ? candidate : root
}

function extractWithSevenZip(filePath: string, destination: string, sevenZipBin: string, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = Seven.extractFull(filePath, destination, { $bin: sevenZipBin, $progress: true, recursive: true })
    let lastReportedProgress = 0

    stream.on("progress", ({ percent }) => {
      const boundedPercent = Number(percent)
      if (Number.isFinite(boundedPercent) && boundedPercent >= lastReportedProgress && boundedPercent <= 100) {
        lastReportedProgress = boundedPercent
        onProgress?.(boundedPercent)
      }
    })

    stream.on("end", () => resolvePromise())
    stream.on("error", () => rejectPromise(new Error("Extraction failed")))
  })
}

/**
 * Unpacks a gzipped tar.
 *
 * 7-Zip is not used here. It needs two passes for a `.tar.gz`, and the bundled
 * p7zip 16.02 cannot read the tar Vintage Story ships at all: its headers leave
 * the numeric fields as NUL bytes, which GNU tar and node-tar accept and 7-Zip
 * rejects with "Is not archive".
 *
 * Progress comes from the compressed bytes read, which is the only total known
 * up front. Anything that is not a plain file or folder fails the extraction
 * rather than being skipped quietly.
 */
function extractTarGz(filePath: string, destination: string, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const totalBytes = fse.statSync(filePath).size
    let readBytes = 0
    let lastReportedProgress = 0
    let unsafeEntry: Error | undefined
    let settled = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) {
        reader.unpipe()
        reader.destroy()
        rejectPromise(error)
        return
      }
      resolvePromise()
    }

    const reader = createReadStream(filePath)
    const unpacker = tar.extract({
      cwd: destination,
      preservePaths: false,
      filter: (_entryPath, entry): boolean => {
        if (isSafeTarEntryType("type" in entry ? entry.type : undefined)) return true
        unsafeEntry = new Error("Archive contains an unsafe entry")
        return false
      }
    })

    reader.on("data", (chunk: Buffer | string) => {
      readBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
      if (totalBytes <= 0) return
      const progress = Math.min(99, Math.floor((readBytes / totalBytes) * 100))
      if (progress > lastReportedProgress) {
        lastReportedProgress = progress
        onProgress?.(progress)
      }
    })

    reader.on("error", () => finish(new Error("Extraction failed")))
    unpacker.on("error", () => finish(new Error("Extraction failed")))
    unpacker.on("close", () => finish(unsafeEntry))
    reader.pipe(unpacker)
  })
}

export interface ExtractionOptions {
  /** Archive on disk. Its name decides which mechanism unpacks it. */
  filePath: string
  /** Folder the contents end up in. Created when missing. */
  outputPath: string
  /** Whether the archive is deleted once its contents landed. */
  deleteArchive: boolean
  /** 7-Zip binary, used for every format outside the tar.gz family. */
  sevenZipBin: string
  /** Called with 0 to 100 as the work advances. */
  onProgress?: (progress: number) => void
}

/**
 * Unpacks one archive into one folder.
 *
 * @param options Archive, destination, and how to report progress.
 * @throws When the archive cannot be read, holds something other than plain
 * files and folders, or busts the entry and size bounds.
 */
export async function runExtraction(options: ExtractionOptions): Promise<void> {
  const { filePath, outputPath, deleteArchive, sevenZipBin, onProgress } = options
  let temporaryRoot: string | undefined

  try {
    assertNoSymlinkComponents(outputPath)
    fse.ensureDirSync(outputPath)
    if (fse.lstatSync(outputPath).isSymbolicLink()) throw new Error("Extraction destination is a symbolic link")

    temporaryRoot = mkdtempSync(join(tmpdir(), "vs-launcher-extract-"))
    const extractionRoot = join(temporaryRoot, "payload")
    fse.ensureDirSync(extractionRoot)

    const isGameArchive = isTarGzName(filePath)
    if (isGameArchive) await extractTarGz(filePath, extractionRoot, onProgress)
    else await extractWithSevenZip(filePath, extractionRoot, sevenZipBin, onProgress)

    validateTree(extractionRoot)
    // Only the game archives wrap their contents in a folder. The zips reaching
    // here are backups the launcher wrote itself, holding an installation's
    // contents at the root, and a restore has to put them back exactly as they were.
    copyTree(isGameArchive ? contentRoot(extractionRoot) : extractionRoot, outputPath)

    if (deleteArchive) {
      assertNoSymlinkComponents(filePath)
      const archiveStats = fse.lstatSync(filePath)
      if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) throw new Error("Archive path is unsafe")
      fse.unlinkSync(filePath)
    }

    onProgress?.(100)
  } finally {
    if (temporaryRoot) fse.removeSync(temporaryRoot)
  }
}
