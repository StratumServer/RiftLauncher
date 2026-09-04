import { serveTasks } from "@src/ipc/workers/workerHost"
import { runExtraction } from "@src/ipc/workers/extraction"

serveTasks(
  async (payload, onProgress) => {
    const { filePath, outputPath, deleteZip, unwrapSingleRootFolder, isBackupArchive } = payload as {
      filePath: string
      outputPath: string
      deleteZip: boolean
      unwrapSingleRootFolder: boolean
      isBackupArchive: boolean
    }
    await runExtraction({ filePath, outputPath, deleteArchive: deleteZip, unwrapSingleRootFolder, isBackupArchive, onProgress })
  },
  (error) => (error instanceof Error ? error.message : "Extraction failed")
)
