import { serveTasks } from "@src/ipc/workers/workerHost"
import { runInnoExtraction } from "@src/ipc/workers/innoExtraction"

serveTasks(
  async (payload, onProgress) => {
    const { filePath, outputPath, deleteInstaller } = payload as { filePath: string; outputPath: string; deleteInstaller: boolean }
    const outcome = await runInnoExtraction({ filePath, outputPath, deleteInstaller, onProgress })
    return { verdict: outcome.verdict, reason: outcome.reason, filesWritten: outcome.filesWritten, bytesWritten: outcome.bytesWritten }
  },
  () => "Installer payload extraction failed"
)
