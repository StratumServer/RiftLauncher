import { serveTasks } from "@src/ipc/workers/workerHost"
import { changePermissions } from "@src/ipc/workers/permissions"

serveTasks(
  (payload) => {
    const { paths, perms } = payload as { paths: readonly string[]; perms: number }
    changePermissions({ paths, perms })
  },
  () => "Changing permissions failed"
)
