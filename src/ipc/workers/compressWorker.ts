import { parentPort, workerData } from "worker_threads"
import Seven from "node-7z"
import fse from "fs-extra"
import { join } from "path"

const { inputPath, outputPath, outputFileName, compressionLevel = 6, sevenZipBin } = workerData
const MAX_ITEMS = 100_000

function assertSafeCompressionTree(root: string): void {
  const pending = [root]
  let itemCount = 0

  while (pending.length > 0) {
    const current = pending.pop() as string
    const stats = fse.lstatSync(current)
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("Compression source contains an unsafe filesystem entry")

    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")
    if (stats.isDirectory()) {
      for (const child of fse.readdirSync(current)) pending.push(join(current, child))
    }
  }
}

try {
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

  const stream = Seven.add(archivePath, sourceGlob, {
    $bin: sevenZipBin,
    $progress: true,
    recursive: true,
    method: [`x=${compressionLevel}`, "mt=on"]
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
    parentPort?.postMessage({ type: "progress", progress: 100 })
    parentPort?.postMessage({ type: "finished" })
  })

  stream.on("error", () => {
    parentPort?.postMessage({ type: "error", message: "Compression failed" })
  })
} catch {
  parentPort?.postMessage({ type: "error", message: "Compression failed" })
}
