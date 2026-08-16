/**
 * Reading an archive's table of contents before anything is unpacked.
 *
 * Nothing is written to disk here. An archive that names an entry outside its
 * root, repeats a name, carries a link, or busts the entry and size bounds is
 * refused while it is still just a file, and the extraction worker is never
 * started. The worker validates the extracted tree again in its temporary
 * folder, so this is the first of two gates rather than the only one.
 *
 * Which reader runs is decided by the file name, which is exactly why the name
 * has to be the real one: a `.tar.gz` saved as `.zip` used to be handed to a
 * zip reader that could not read it, and the install died there.
 */

import { spawn } from "child_process"
import yauzl from "yauzl"
import * as tar from "tar"

import { isArchiveSymlink, isSafeArchiveEntry, isSafeTarEntryType, isTarGzName, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_TOTAL_BYTES } from "./validation"

const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_LISTING_BYTES = 4 * 1024 * 1024

function comparableArchiveEntry(entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, "/")
  return process.platform === "win32" ? normalizedName.toLowerCase() : normalizedName
}

export function validateZipArchive(filePath: string): Promise<void> {
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
          entrySize > MAX_ARCHIVE_ENTRY_BYTES ||
          totalUncompressedBytes + entrySize > MAX_ARCHIVE_TOTAL_BYTES
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

export function validateSevenZipArchive(filePath: string, sevenZipBin: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const archiveLister = spawn(sevenZipBin, ["l", "-slt", "-bb0", filePath], { windowsHide: true })
    let output = ""
    let settled = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    archiveLister.stdout.on("data", (chunk) => {
      output += chunk.toString()
      if (Buffer.byteLength(output, "utf8") > MAX_LISTING_BYTES) {
        archiveLister.kill()
        finish(new Error("Archive listing is too large"))
      }
    })
    archiveLister.stderr.on("data", () => {})
    archiveLister.on("error", (error) => finish(error))
    archiveLister.on("close", (code) => {
      if (settled) return
      if (code !== 0) {
        finish(new Error("Archive could not be listed"))
        return
      }

      const records = output.split(/\r?\n\s*\r?\n/)
      let entryCount = 0
      let totalUncompressedBytes = 0
      let firstRecord = true
      const entryNames = new Set<string>()
      for (const record of records) {
        const lines = record.split(/\r?\n/)
        const pathLine = lines.find((line) => line.startsWith("Path = "))
        if (!pathLine) continue
        if (firstRecord) {
          firstRecord = false
          continue
        }

        const entryName = pathLine.slice("Path = ".length)
        const sizeLine = lines.find((line) => line.startsWith("Size = "))
        const folderLine = lines.find((line) => line.startsWith("Folder = "))
        const isFolder = folderLine?.slice("Folder = ".length).trim() === "+"
        const attributesLine = lines.find((line) => line.startsWith("Attributes = "))
        // Tar style listings report links in their own columns instead of the attributes one.
        const linkLines = lines.filter((line) => line.startsWith("Symbolic Link = ") || line.startsWith("Hard Link = "))
        const entrySize = sizeLine ? Number(sizeLine.slice("Size = ".length)) : 0
        entryCount++
        totalUncompressedBytes += Number.isFinite(entrySize) && entrySize >= 0 ? entrySize : 0

        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          !isSafeArchiveEntry(entryName) ||
          entryNames.has(comparableArchiveEntry(entryName)) ||
          (attributesLine !== undefined && /(^|\s)L(\s|$)/.test(attributesLine)) ||
          linkLines.some((line) => line.slice(line.indexOf("= ") + 2).trim().length > 0) ||
          (!isFolder && (!sizeLine || !Number.isFinite(entrySize) || entrySize < 0)) ||
          entrySize > MAX_ARCHIVE_ENTRY_BYTES ||
          totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES
        ) {
          finish(new Error("Archive contains an unsafe entry"))
          return
        }
        entryNames.add(comparableArchiveEntry(entryName))
      }

      finish()
    })
  })
}

/**
 * Lists a gzipped tar and holds it to the same bounds as the other formats.
 *
 * 7-Zip is not used for this one. It would only see the gzip container and
 * report the single `.tar` inside, and the bundled p7zip 16.02 cannot read the
 * tars Vintage Story ships at all: their headers leave the numeric fields as
 * NUL bytes, which GNU tar and node-tar accept and 7-Zip calls "Is not
 * archive". The tar reader also states an entry's kind outright, so links are
 * refused by type rather than by parsing an attributes column.
 */
export async function validateTarGzArchive(filePath: string): Promise<void> {
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
      size > MAX_ARCHIVE_ENTRY_BYTES ||
      totalUncompressedBytes > MAX_ARCHIVE_TOTAL_BYTES
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
 * @param filePath Archive on disk. Its name decides the reader.
 * @param sevenZipBin 7-Zip binary, for the formats neither yauzl nor tar handles.
 * @throws When the archive cannot be read or holds an entry the launcher refuses to unpack.
 */
export async function validateArchive(filePath: string, sevenZipBin: string): Promise<void> {
  if (filePath.toLowerCase().endsWith(".zip")) return validateZipArchive(filePath)
  if (isTarGzName(filePath)) return validateTarGzArchive(filePath)
  return validateSevenZipArchive(filePath, sevenZipBin)
}
