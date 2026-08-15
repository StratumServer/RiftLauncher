import { parentPort, workerData } from "worker_threads"
import Seven from "node-7z"
import fse from "fs-extra"
import { mkdtempSync } from "fs"
import { isAbsolute, join, relative, resolve, sep } from "path"
import { tmpdir } from "os"

const { filePath, outputPath, deleteZip, sevenZipBin } = workerData
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_ARCHIVE_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

function assertNoSymlinkComponents(pathValue: string): void {
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

type ArchiveStats = { entries: number; bytes: number; inodes: Set<string> }

function validateTree(root: string): ArchiveStats {
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

function copyTree(sourceRoot: string, destinationRoot: string): void {
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

let temporaryRoot: string | undefined
try {
  assertNoSymlinkComponents(outputPath)
  fse.ensureDirSync(outputPath)
  if (fse.lstatSync(outputPath).isSymbolicLink()) throw new Error("Extraction destination is a symbolic link")
  temporaryRoot = mkdtempSync(join(tmpdir(), "vs-launcher-extract-"))
  const extractionRoot = join(temporaryRoot, "payload")
  fse.ensureDirSync(extractionRoot)

  const stream = Seven.extractFull(filePath, extractionRoot, {
    $bin: sevenZipBin,
    $progress: true,
    recursive: true
  })

  let lastReportedProgress = 0

  stream.on("progress", ({ percent }) => {
    const boundedPercent = Number(percent)
    if (Number.isFinite(boundedPercent) && boundedPercent >= lastReportedProgress && boundedPercent <= 100) {
      lastReportedProgress = boundedPercent
      parentPort?.postMessage({ type: "progress", progress: boundedPercent })
    }
  })

  stream.on("end", () => {
    try {
      validateTree(extractionRoot)
      copyTree(extractionRoot, outputPath)
      if (deleteZip) {
        assertNoSymlinkComponents(filePath)
        const archiveStats = fse.lstatSync(filePath)
        if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) throw new Error("Archive path is unsafe")
        fse.unlinkSync(filePath)
      }
      parentPort?.postMessage({ type: "progress", progress: 100 })
      parentPort?.postMessage({ type: "finished" })
    } catch {
      parentPort?.postMessage({ type: "error", message: "Extraction cleanup failed" })
    } finally {
      if (temporaryRoot) fse.removeSync(temporaryRoot)
    }
  })

  stream.on("error", () => {
    parentPort?.postMessage({ type: "error", message: "Extraction failed" })
    if (temporaryRoot) fse.removeSync(temporaryRoot)
  })
} catch {
  parentPort?.postMessage({ type: "error", message: "Extraction failed" })
  if (temporaryRoot) fse.removeSync(temporaryRoot)
}
