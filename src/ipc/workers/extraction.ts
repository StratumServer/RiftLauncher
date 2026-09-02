/**
 * Unpacking an archive into a folder, without the worker plumbing.
 *
 * The worker thread is a shim over this module so the same code can be driven
 * from a test or a script. Nothing here touches Electron or `worker_threads`.
 *
 * Every archive lands in a staging folder first, beside the destination rather
 * than under the OS temporary directory: `/tmp` is tmpfs on most Linux and WSL
 * systems, which would otherwise hold the whole extracted tree in RAM, and a
 * separate drive for temp files means every byte is written twice. The tree is
 * validated in the staging folder, and only then published into the
 * destination, so a hostile archive never gets to write a single byte where
 * the launcher keeps its files.
 */

import fse from "fs-extra"
import yauzl from "yauzl"
import { createReadStream, createWriteStream, mkdtempSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Readable } from "node:stream"
import * as tar from "tar"

// Relative so the module stays importable from a plain test run, like validation.ts.
import { isSafeTarEntryType, isTarGzName } from "../validation"
import { validateArchive } from "../archiveValidation"

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

export type ArchiveStats = { entries: number; bytes: number }

export function validateTree(root: string): ArchiveStats {
  const stats: ArchiveStats = { entries: 0, bytes: 0 }
  const visit = (current: string): void => {
    const entry = fse.lstatSync(current)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Archive contains an unsafe filesystem entry")

    stats.entries++
    if (stats.entries > MAX_ARCHIVE_ENTRIES) throw new Error("Archive contains too many entries")
    if (entry.isFile()) {
      if (entry.size > MAX_ARCHIVE_ENTRY_BYTES || stats.bytes + entry.size > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("Archive is too large")
      // entry.nlink is the OS's own hard-link count, unlike tracking dev:ino pairs by hand:
      // Windows has reused the same ino for two freshly written, otherwise-unrelated files
      // during a real install (nlink stayed 1 on both), which turned every install on Windows
      // into a false "hard links" refusal. nlink is what actually answers the question.
      if (entry.nlink > 1) throw new Error("Archive contains hard links")
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

function isCrossDeviceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EXDEV"
}

/** Renames a whole subtree in one move, or copies it when that is not possible. */
function renameOrCopyTree(source: string, destination: string): void {
  if (!fse.existsSync(destination)) {
    try {
      fse.renameSync(source, destination)
      return
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error
    }
  }
  // Either the rename could not cross filesystems, or something already sits
  // under this name at the destination and a rename cannot land on top of it
  // without possibly losing what that something already held. copyTree merges
  // the two trees entry by entry the way it always has.
  copyTree(source, destination)
}

/** Renames a single file, or copies it when that is not possible. */
function renameOrCopyFile(source: string, destination: string): void {
  try {
    fse.renameSync(source, destination)
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error
    fse.copyFileSync(source, destination)
  }
}

/**
 * Publishes a staged tree by renaming each top-level entry into the
 * destination, rather than copying it in byte by byte.
 *
 * `runExtraction` always stages beside the destination, on the same
 * filesystem, so a rename here is ordinarily one metadata update instead of a
 * full read and write of everything the archive held. Two things can still
 * stop a given entry from being renamed straight across: something already
 * exists under that name at the destination (an install that reuses a folder
 * in place, say), which a rename cannot land on without risking what is
 * already there, or the destination turns out to be on a different filesystem
 * after all, `EXDEV`, which can still happen if it is itself a separate mount
 * point inside its own parent folder. Both fall back to copyTree, the same
 * merge-and-overwrite behaviour a plain copy has always had.
 */
export function publishTree(sourceRoot: string, destinationRoot: string): void {
  assertNoSymlinkComponents(destinationRoot)
  fse.ensureDirSync(destinationRoot)
  if (fse.lstatSync(destinationRoot).isSymbolicLink()) throw new Error("Destination is a symbolic link")
  const resolvedDestinationRoot = resolve(destinationRoot)

  for (const child of fse.readdirSync(sourceRoot)) {
    const source = join(sourceRoot, child)
    const destination = resolve(resolvedDestinationRoot, child)
    const destinationRelativePath = relative(resolvedDestinationRoot, destination)
    if (!destinationRelativePath || destinationRelativePath === ".." || destinationRelativePath.startsWith(`..${sep}`) || isAbsolute(destinationRelativePath))
      throw new Error("Archive output escaped its root")
    assertNoSymlinkComponents(destination)

    const entry = fse.lstatSync(source)
    if (entry.isDirectory()) {
      if (fse.existsSync(destination) && !fse.lstatSync(destination).isDirectory()) throw new Error("Archive output type conflict")
      renameOrCopyTree(source, destination)
      continue
    }

    if (fse.existsSync(destination)) {
      const existing = fse.lstatSync(destination)
      if (existing.isSymbolicLink() || existing.isDirectory()) throw new Error("Archive output contains an unsafe destination")
      fse.unlinkSync(destination)
    }
    renameOrCopyFile(source, destination)
  }
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

/**
 * Where one archive entry is allowed to land, or nothing.
 *
 * The archive's table of contents was already checked for escaping names before
 * a byte was written (validateArchive, in archiveValidation.ts), and yauzl
 * refuses a leading "/" or a ".." segment on its own before either. This is the
 * check the writer itself makes anyway, on the resolved path rather than on the
 * name, because a writer is the wrong place to trust a name that came out of a
 * file someone else wrote.
 */
export function resolveEntryDestination(destination: string, entryName: string): string {
  const resolvedDestination = resolve(destination)
  const target = resolve(resolvedDestination, entryName.replaceAll("\\", "/"))
  const relativePath = relative(resolvedDestination, target)
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Archive entry escaped its root")
  return target
}

/**
 * Unpacks a zip.
 *
 * Only the backups the launcher wrote before it moved to gzipped tar arrive
 * here, and they have to keep restoring for as long as players still hold them.
 * Reading is yauzl's, the same reader the mod archives and the pre-extraction
 * table-of-contents check already run on, so no zip writer or external process
 * is needed to keep the old format readable.
 *
 * Progress is counted in entries rather than bytes: the entry count is the one
 * total a zip states up front, per entry sizes are what the archive claims
 * rather than what comes out, and a backup's entries are of a similar size.
 *
 * Unix mode bits recorded in a legacy backup are deliberately not carried over,
 * unlike the tar reader, which restores what the archive holds. An installation
 * folder is game data with nothing executable in it; on Linux every extraction
 * is followed by a blanket chmod to 0755 (startExtract in
 * TaskManagerContext.tsx), which overwrites what either reader restored; and a
 * mode read out of an archive written by a tool the launcher no longer ships is
 * as easily 0 as it is useful, which would leave a save file unreadable. The
 * attributes are still read, for the symlink check, which is the one thing in
 * them worth acting on.
 */
export function extractZip(filePath: string, destination: string, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        rejectPromise(new Error("Extraction failed"))
        return
      }

      let settled = false
      let extractedEntries = 0
      let lastReportedProgress = 0
      const totalEntries = zipFile.entryCount
      // The pair the entry being written is streaming through, so a failure can
      // stop them. Reassigned per entry, and left pointing at the last one.
      let entryReader: Readable | undefined
      let entryWriter: ReturnType<typeof createWriteStream> | undefined

      const finish = (failure?: Error): void => {
        if (settled) return
        settled = true
        if (failure) {
          // Stop both ends before the caller wipes the temporary folder, the same
          // reason extractTarGz does it: an open write handle in there turns the
          // removal into an EBUSY on Windows, which then replaces the real error
          // and leaves the folder behind.
          entryReader?.unpipe()
          entryReader?.destroy()
          entryWriter?.destroy()
        }
        try {
          zipFile.close()
        } catch {
          // Already closed after a parse error. The outcome below is what matters.
        }
        if (failure) rejectPromise(failure)
        else resolvePromise()
      }

      const advance = (): void => {
        extractedEntries++
        if (totalEntries <= 0) return
        // runExtraction emits the terminal 100 after validation and copying, so
        // the running figure stops a point short of it.
        const progress = Math.min(99, Math.floor((extractedEntries / totalEntries) * 100))
        if (progress > lastReportedProgress) {
          lastReportedProgress = progress
          onProgress?.(progress)
        }
      }

      zipFile.on("entry", (entry: yauzl.Entry) => {
        let target: string
        try {
          target = resolveEntryDestination(destination, entry.fileName)
        } catch (error) {
          finish(error as Error)
          return
        }

        if (entry.fileName.endsWith("/")) {
          try {
            fse.ensureDirSync(target)
          } catch {
            finish(new Error("Extraction failed"))
            return
          }
          advance()
          zipFile.readEntry()
          return
        }

        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            finish(new Error("Extraction failed"))
            return
          }

          entryReader = readStream
          let writeStream: ReturnType<typeof createWriteStream>
          try {
            fse.ensureDirSync(dirname(target))
            writeStream = createWriteStream(target)
          } catch {
            finish(new Error("Extraction failed"))
            return
          }
          entryWriter = writeStream

          readStream.on("error", () => finish(new Error("Extraction failed")))
          writeStream.on("error", () => finish(new Error("Extraction failed")))
          writeStream.on("close", () => {
            if (settled) return
            advance()
            zipFile.readEntry()
          })
          readStream.pipe(writeStream)
        })
      })

      zipFile.on("end", () => finish())
      zipFile.on("error", () => finish(new Error("Extraction failed")))
      zipFile.readEntry()
    })
  })
}

/**
 * Unpacks a gzipped tar: the game builds, and every backup the launcher writes.
 *
 * Progress comes from the compressed bytes read, which is the only total known
 * up front. Anything that is not a plain file or folder fails the extraction
 * rather than being skipped quietly, and `preservePaths: false` is what keeps
 * an absolute or climbing entry name from being written where it points.
 *
 * `strict` is what makes a failed entry a failed extraction. Left off, node-tar
 * treats every per-entry write error as a warning: the entry is skipped, the
 * stream still closes cleanly, and a run that hit a full disk halfway through
 * comes back indistinguishable from one that unpacked everything. A restore
 * believes that and deletes the installation the truncated tree replaced, so
 * the archive has to fail closed here rather than downstream. It also upgrades
 * the parser's own invalid-entry warning, a corrupt header whose entry is
 * dropped just as quietly. Nothing else it turns fatal is reachable: an
 * unsupported entry type is refused by the filter below, and an absolute name
 * never gets this far, validateArchive having refused the archive by name
 * before a byte was written.
 */
export function extractTarGz(filePath: string, destination: string, onProgress?: (progress: number) => void): Promise<void> {
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
        // Stop both ends before the caller wipes the temporary folder, so nothing
        // is still writing into it while it is being removed.
        reader.unpipe()
        reader.destroy()
        unpacker.abort(error)
        rejectPromise(error)
        return
      }
      resolvePromise()
    }

    const reader = createReadStream(filePath)
    const unpacker = tar.extract({
      cwd: destination,
      preservePaths: false,
      strict: true,
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
  /**
   * Whether a single wrapping folder is stepped into before the contents are
   * copied out. Asked for by the game version install, whose Linux archives
   * carry everything under `vintagestory/`, and never by a backup restore,
   * whose archive holds an installation's contents at the root already.
   */
  unwrapSingleRootFolder?: boolean
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
  const { filePath, outputPath, deleteArchive, unwrapSingleRootFolder = false, onProgress } = options
  let temporaryRoot: string | undefined

  // The first of two validation gates (see archiveValidation.ts's own comment): reads the
  // archive's table of contents and refuses it, before a single byte is written anywhere,
  // if it names an entry outside its root, repeats a name, carries a link, or busts the
  // entry/size bounds.
  await validateArchive(filePath)

  try {
    assertNoSymlinkComponents(outputPath)
    fse.ensureDirSync(outputPath)
    if (fse.lstatSync(outputPath).isSymbolicLink()) throw new Error("Extraction destination is a symbolic link")

    // Staged beside the destination rather than under the OS temp directory, so
    // the eventual publish below is a rename rather than a copy (see this
    // module's own comment). ensureDirSync above already guarantees the
    // destination's parent exists, which is what mkdtempSync needs here. The
    // dot prefix keeps the staging folder from reading as real content if
    // anything lists the parent directory while the extraction is still running.
    temporaryRoot = mkdtempSync(join(dirname(outputPath), ".riftlauncher-extract-"))
    const extractionRoot = join(temporaryRoot, "payload")
    fse.ensureDirSync(extractionRoot)

    if (isTarGzName(filePath)) await extractTarGz(filePath, extractionRoot, onProgress)
    else await extractZip(filePath, extractionRoot, onProgress)

    validateTree(extractionRoot)
    // Only the game archives wrap their contents in a folder, and only their caller
    // asks for that folder to be stepped into. A backup holds an installation's
    // contents at the root, and a restore has to put them back exactly as they were.
    publishTree(unwrapSingleRootFolder ? contentRoot(extractionRoot) : extractionRoot, outputPath)

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
