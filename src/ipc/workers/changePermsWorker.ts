import { parentPort, workerData } from "worker_threads"

import { changePermissions } from "@src/ipc/workers/permissions"

const { paths, perms } = workerData

try {
  changePermissions({ paths, perms })
  parentPort?.postMessage({ type: "finished" })
} catch {
  parentPort?.postMessage({ type: "error", message: "Changing permissions failed" })
}
