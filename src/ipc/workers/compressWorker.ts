import { serveTasks } from "@src/ipc/workers/workerHost"
import { runCompression } from "@src/ipc/workers/compression"

serveTasks(
  async (payload, onProgress) => {
    const { inputPath, outputPath, outputFileName, compressionLevel, sevenZipBin } = payload as {
      inputPath: string
      outputPath: string
      outputFileName: string
      compressionLevel?: number
      sevenZipBin?: string
    }
    await runCompression({ inputPath, outputPath, outputFileName, compressionLevel, sevenZipBin, onProgress })
  },
  () => "Compression failed"
)
