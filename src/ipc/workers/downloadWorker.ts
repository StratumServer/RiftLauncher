import { serveTasks } from "@src/ipc/workers/workerHost"
import { runDownload } from "@src/ipc/workers/download"

serveTasks(
  async (payload, onProgress) => {
    const { url, outputPath, fileName, expectedMd5, expectedSha256, maxBytes } = payload as {
      url: unknown
      outputPath: string
      fileName: unknown
      expectedMd5?: unknown
      expectedSha256?: unknown
      maxBytes?: number
    }
    const path = await runDownload({ url, outputPath, fileName, expectedMd5, expectedSha256, maxBytes, onProgress })
    return { path }
  },
  () => "Download failed"
)
