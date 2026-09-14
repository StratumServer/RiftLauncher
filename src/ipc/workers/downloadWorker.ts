import { serveTasks } from "@src/ipc/workers/workerHost"
import { runDownload } from "@src/ipc/workers/download"

serveTasks(
  async (payload, onProgress) => {
    const { url, outputPath, fileName, expectedMd5, expectedSha256 } = payload as { url: unknown; outputPath: string; fileName: unknown; expectedMd5?: unknown; expectedSha256?: unknown }
    const path = await runDownload({ url, outputPath, fileName, expectedMd5, expectedSha256, onProgress })
    return { path }
  },
  () => "Download failed"
)
