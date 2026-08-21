import { serveTasks } from "@src/ipc/workers/workerHost"
import { runDownload } from "@src/ipc/workers/download"

serveTasks(
  async (payload, onProgress) => {
    const { url, outputPath, fileName, expectedMd5 } = payload as { url: unknown; outputPath: string; fileName: unknown; expectedMd5?: unknown }
    const path = await runDownload({ url, outputPath, fileName, expectedMd5, onProgress })
    return { path }
  },
  () => "Download failed"
)
