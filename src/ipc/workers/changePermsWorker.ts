import { parentPort, workerData } from "worker_threads"
import fse from "fs-extra"
import { join } from "path"

const { paths, perms } = workerData
const MAX_ITEMS = 100_000
let itemCount = 0

const changePermissionsRecursively = (path: string): void => {
  if (fse.existsSync(path)) {
    const stats = fse.lstatSync(path)
    if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed")
    itemCount++
    if (itemCount > MAX_ITEMS) throw new Error("Too many filesystem entries")

    if (stats.isDirectory()) {
      const items = fse.readdirSync(path)
      for (const item of items) {
        changePermissionsRecursively(join(path, item))
      }
    }

    if (!stats.isDirectory() && !stats.isFile()) throw new Error("Unsupported filesystem entry")
    fse.chmodSync(path, perms)
  }
}

try {
  for (const path of paths) changePermissionsRecursively(path)
  parentPort?.postMessage({ type: "finished" })
} catch {
  parentPort?.postMessage({ type: "error", message: "Changing permissions failed" })
}
