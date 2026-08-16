import { parentPort, workerData } from "worker_threads"

import { runDownload } from "@src/ipc/workers/download"

const { url, outputPath, fileName, expectedMd5 } = workerData

runDownload({
  url,
  outputPath,
  fileName,
  expectedMd5,
  onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress })
}).then(
  (path) => parentPort?.postMessage({ type: "finished", path }),
  () => parentPort?.postMessage({ type: "error", message: "Download failed" })
)
