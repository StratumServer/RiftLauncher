import { serveTasks } from "@src/ipc/workers/workerHost"
import { runExtraction } from "@src/ipc/workers/extraction"

serveTasks(
  async (payload, onProgress) => {
    const { filePath, outputPath, deleteZip, sevenZipBin } = payload as { filePath: string; outputPath: string; deleteZip: boolean; sevenZipBin: string }
    await runExtraction({ filePath, outputPath, deleteArchive: deleteZip, sevenZipBin, onProgress })
  },
  (error) => (error instanceof Error ? error.message : "Extraction failed")
)
