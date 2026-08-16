import { parentPort, workerData } from "worker_threads"

import { runExtraction } from "@src/ipc/workers/extraction"

const { filePath, outputPath, deleteZip, sevenZipBin } = workerData

runExtraction({
  filePath,
  outputPath,
  deleteArchive: deleteZip,
  sevenZipBin,
  onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress })
}).then(
  () => parentPort?.postMessage({ type: "finished" }),
  () => parentPort?.postMessage({ type: "error", message: "Extraction failed" })
)
