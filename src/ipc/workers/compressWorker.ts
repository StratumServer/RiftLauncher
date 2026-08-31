import { serveTasks } from "@src/ipc/workers/workerHost"
import { runCompression } from "@src/ipc/workers/compression"

serveTasks(
  async (payload, onProgress) => {
    const { inputPath, outputPath, outputFileName, compressionLevel } = payload as {
      inputPath: string
      outputPath: string
      outputFileName: string
      compressionLevel?: number
    }
    await runCompression({ inputPath, outputPath, outputFileName, compressionLevel, onProgress })
  },
  () => "Compression failed"
)
