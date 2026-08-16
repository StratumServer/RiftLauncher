import { parentPort, workerData } from "worker_threads"

import { runCompression } from "@src/ipc/workers/compression"

const { inputPath, outputPath, outputFileName, compressionLevel, sevenZipBin } = workerData

runCompression({
  inputPath,
  outputPath,
  outputFileName,
  compressionLevel,
  sevenZipBin,
  onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress })
}).then(
  () => parentPort?.postMessage({ type: "finished" }),
  () => parentPort?.postMessage({ type: "error", message: "Compression failed" })
)
