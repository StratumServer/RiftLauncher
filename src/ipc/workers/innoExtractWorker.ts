import { parentPort, workerData } from "worker_threads"

import { runInnoExtraction } from "@src/ipc/workers/innoExtraction"

const { filePath, outputPath, deleteInstaller } = workerData

runInnoExtraction({
  filePath,
  outputPath,
  deleteInstaller,
  onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress })
}).then(
  (outcome) => parentPort?.postMessage({ type: "finished", verdict: outcome.verdict, reason: outcome.reason, filesWritten: outcome.filesWritten, bytesWritten: outcome.bytesWritten }),
  () => parentPort?.postMessage({ type: "error", message: "Installer payload extraction failed" })
)
