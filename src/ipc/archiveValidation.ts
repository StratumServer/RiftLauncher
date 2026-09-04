/**
 * Reading an archive's table of contents before anything is unpacked.
 *
 * Nothing is written to disk here. An archive that names an entry outside its
 * root, repeats a name, carries a link, or busts the entry and size bounds is
 * refused while it is still just a file, before the extraction worker
 * (runExtraction, in workers/extraction.ts) does anything else. The worker
 * validates the extracted tree again in its own temporary folder once
 * extraction finishes, so this is the first of two gates rather than the
 * only one.
 *
 * Called from inside the worker rather than from the IPC handler before it
 * starts one: walking a table of contents can run to 100,000 entries, real CPU
 * work that has no business running on the main process's event loop when a
 * worker thread is about to exist for this archive regardless.
 *
 * Which reader runs is decided by the file name, which is exactly why the name
 * has to be the real one: a `.tar.gz` saved as `.zip` used to be handed to a
 * zip reader that could not read it, and the install died there.
 */

import yauzl from "yauzl"
import * as tar from "tar"

import type { ArchiveSizeLimits } from "./validation"
import { archiveSizeLimits, isArchiveSymlink, isSafeArchiveEntry, isSafeTarEntryType, isTarGzName } from "./validation"

const MAX_ARCHIVE_ENTRIES = 100_000

function comparableArchiveEntry(entryName: string): string {
  const normalizedName = entryName.replaceAll("\\", "/")
  return process.platform === "win32" ? normalizedName.toLowerCase() : normalizedName
}

export function validateZipArchive(filePath: string, limits: ArchiveSizeLimits = archiveSizeLimits(false)): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let totalUncompressedBytes = 0
    let entryCount = 0
    const entryNames = new Set<string>()

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        finish(new Error("Archive could not be read"))
        return
      }

      zipFile.on("entry", (entry) => {
        const entrySize = entry.uncompressedSize
        entryCount++
        const normalizedEntryName = typeof entry.fileName === "string" ? comparableArchiveEntry(entry.fileName) : ""
        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          !isSafeArchiveEntry(entry.fileName) ||
          entryNames.has(normalizedEntryName) ||
          isArchiveSymlink(entry.externalFileAttributes) ||
          !Number.isFinite(entrySize) ||
          entrySize < 0 ||
          entrySize > limits.entryBytes ||
          totalUncompressedBytes + entrySize > limits.totalBytes
        ) {
          try {
            zipFile.close()
          } catch {
            // The archive may already be closed after a parse error.
          }
          finish(new Error("Archive contains an unsafe entry"))
          return
        }

        entryNames.add(normalizedEntryName)
        totalUncompressedBytes += entrySize
        zipFile.readEntry()
      })

      zipFile.once("end", () => finish())
      zipFile.once("error", () => finish(new Error("Archive could not be read")))
      zipFile.readEntry()
    })
  })
}

/**
 * Lists a gzipped tar and holds it to the same bounds as the zip reader.
 *
 * The tar reader states an entry's kind outright, so links are refused by type
 * rather than by reading an attributes column.
 */
export async function validateTarGzArchive(filePath: string, limits: ArchiveSizeLimits = archiveSizeLimits(false)): Promise<void> {
  let entryCount = 0
  let totalUncompressedBytes = 0
  const entryNames = new Set<string>()
  let failure: Error | undefined

  const inspect = (entryPath: unknown, entryType: unknown, entrySize: unknown): void => {
    if (failure) return

    const entryName = typeof entryPath === "string" ? entryPath : ""
    const comparableName = comparableArchiveEntry(entryName)
    const size = entryType === "Directory" ? 0 : Number(entrySize)
    entryCount++
    totalUncompressedBytes += Number.isFinite(size) && size > 0 ? size : 0

    if (
      !isSafeTarEntryType(entryType) ||
      entryCount > MAX_ARCHIVE_ENTRIES ||
      !isSafeArchiveEntry(entryName) ||
      entryNames.has(comparableName) ||
      !Number.isFinite(size) ||
      size < 0 ||
      size > limits.entryBytes ||
      totalUncompressedBytes > limits.totalBytes
    ) {
      failure = new Error("Archive contains an unsafe entry")
      return
    }

    entryNames.add(comparableName)
  }

  try {
    await tar.list({ file: filePath, onReadEntry: (entry) => inspect(entry.path, entry.type, entry.size) })
  } catch {
    throw new Error("Archive could not be read")
  }

  if (failure) throw failure
  // A tar reader walks a file it cannot parse without complaining, it just finds
  // nothing in it. An archive with no entries is one of those, not an archive.
  if (entryCount === 0) throw new Error("Archive could not be read")
}

/**
 * Checks an archive with the reader its format actually needs.
 *
 * Two formats reach the launcher and no others: gzipped tar, which the game
 * builds ship as and which every backup is written as, and zip, which is what
 * the backups made before that change still are. Anything else is refused here
 * rather than handed to a reader that would have to guess at it.
 *
 * @param filePath Archive on disk. Its name decides the reader.
 * @param limits Entry and total ceilings, the strict pair unless the caller has
 *   established this is one of the launcher's own backups.
 * @throws When the archive cannot be read or holds an entry the launcher refuses to unpack.
 */
export async function validateArchive(filePath: string, limits: ArchiveSizeLimits = archiveSizeLimits(false)): Promise<void> {
  if (isTarGzName(filePath)) return validateTarGzArchive(filePath, limits)
  if (filePath.toLowerCase().endsWith(".zip")) return validateZipArchive(filePath, limits)
  throw new Error("Archive format is not supported")
}
