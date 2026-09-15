import React, { createContext, useReducer, useContext, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { taskSurvivesBulkClear } from "@domain/notifications/bulkClear"
import { classifyFailure, type FailureReason } from "@domain/notifications/failureReason"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { LAUNCHER_UPDATE_TASK_ID, launcherUpdateName } from "@renderer/utils/launcherUpdateTask"

export interface TaskType {
  id: string
  name: string
  desc: string
  type: "download" | "extract" | "install" | "compress"
  progress: number
  status: "pending" | "in-progress" | "completed" | "failed"
  /**
   * Why a failed task failed, as a token the locale turns into a sentence. Set
   * once by the catch site that has the error, which is the only place that
   * ever sees the raw text. Absent on anything that has not failed.
   */
  reason?: FailureReason
}

/** Describes which terminal task events should reach the notification system. */
export interface TaskNotificationPolicy {
  /** Whether the task runner owns a generic failure notification. */
  failure: "generic" | "caller-handled"
  /** Whether the task runner should announce successful completion. */
  completion: "toast" | "silent"
}

export const TASK_NOTIFICATION_POLICIES = {
  individual: { failure: "generic", completion: "toast" },
  callerHandled: { failure: "caller-handled", completion: "toast" },
  aggregate: { failure: "caller-handled", completion: "silent" }
} as const satisfies Record<string, TaskNotificationPolicy>

export enum ACTIONS {
  ADD_TASK = "ADD_TASK",
  UPDATE_TASK = "UPDATE_TASK",
  REMOVE_TASK = "REMOVE_TASK"
}

export interface AddTaskAction {
  type: ACTIONS.ADD_TASK
  payload: TaskType
}

export interface UpdateTaskAction {
  type: ACTIONS.UPDATE_TASK
  payload: {
    id: string
    updates: Partial<Omit<TaskType, "id">>
  }
}

export interface RemoveTaskAction {
  type: ACTIONS.REMOVE_TASK
  payload: { id: string }
}

export type TaskAction = AddTaskAction | UpdateTaskAction | RemoveTaskAction

/** True when every field the update carries already holds that value on the task. */
function changesNothing(task: TaskType, updates: Partial<Omit<TaskType, "id">>): boolean {
  return (Object.keys(updates) as (keyof typeof updates)[]).every((field) => task[field] === updates[field])
}

/**
 * What is left of an update once the task it targets has finished: everything
 * but its status and its progress, which a terminal task keeps for good.
 *
 * Completion is owned by the awaited operation, not by the progress stream
 * (see the reducer below), and nothing orders the last progress tick of a
 * download before the promise that flushed it. Without this, the 100 tick
 * that lands after `downloadOnPath` resolved pushed a completed task back to
 * in-progress at 100, which the Activity Center reads as "finalizing" until
 * the next launch (#387). Every flow's updates go through here, so the three
 * progress listeners and the launcher update are all covered at once.
 */
function applicableUpdates(task: TaskType, updates: Partial<Omit<TaskType, "id">>): Partial<Omit<TaskType, "id">> {
  if (task.status !== "completed" && task.status !== "failed") return updates
  const applicable = { ...updates }
  delete applicable.status
  delete applicable.progress
  return applicable
}

/**
 * UPDATE_TASK is deliberately idempotent: an update that would not change a
 * single field returns the very same state array, so `useReducer` bails out
 * instead of re-rendering every task consumer. An update stripped down to
 * nothing by the guard above counts as one of those.
 *
 * A progress event is not the terminal signal for an awaited operation. A
 * download can report 100 while its promise still has to flush the file, so
 * the operation marks itself completed after that promise resolves. Extract
 * and compress retain the same idempotent terminal update when their progress
 * listener and awaited operation finish together.
 */
export function taskReducer(state: TaskType[], action: TaskAction): TaskType[] {
  switch (action.type) {
    // Ids are fresh per run everywhere but the launcher update, which reuses
    // one id for every attempt: adding it again restarts that task instead of
    // stacking a second card under the same id.
    case ACTIONS.ADD_TASK:
      return [action.payload, ...state.filter((task) => task.id !== action.payload.id)]
    case ACTIONS.UPDATE_TASK: {
      const { id, updates } = action.payload
      const target = state.find((task) => task.id === id)
      if (!target) return state
      const applicable = applicableUpdates(target, updates)
      if (changesNothing(target, applicable)) return state
      return state.map((task) => (task.id === id ? { ...task, ...applicable } : task))
    }
    case ACTIONS.REMOVE_TASK:
      return state.filter((task) => task.id !== action.payload.id)
    default:
      return state
  }
}

export const initialState: TaskType[] = []

/**
 * The one terminal state a successful task ends on, whichever route gets there
 * first. Kept at module scope so the progress-listener effect below can use it
 * without taking a dependency that would re-subscribe the listeners on render.
 */
const COMPLETED: Partial<Omit<TaskType, "id">> = { progress: 100, status: "completed" }

export interface TaskContextType {
  tasks: TaskType[]
  activeTaskCount: number
  startDownload(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    url: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, path: string, error: Error | null) => void
  ): Promise<void>
  startExtract(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    filePath: string,
    outputPath: string,
    deleteZip: boolean,
    onFinish: (status: boolean, error: Error | null) => void,
    unwrapSingleRootFolder?: boolean
  ): Promise<void>
  startInstall(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    filePath: string,
    outputPath: string,
    deleteInstaller: boolean,
    onFinish: (status: boolean, error: Error | null) => void
  ): Promise<void>
  startCompress(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    inputPath: string,
    outputPath: string,
    backupName: string,
    onFinish: (status: boolean, error: Error | null) => void,
    compressionLevel?: number
  ): Promise<void>
  /**
   * Patching an installed build with Optimum's overlay, or putting the vanilla
   * assemblies back.
   *
   * Reuses the `install` task type rather than adding a fifth: it is the same
   * thing to a player watching the list, a build being turned into something
   * else, and a type only exists to pick an icon.
   */
  startOptimumPatch(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    mode: "apply" | "restore",
    gameDirectory: string,
    gameVersion: string,
    onFinish: (result: OptimumPatchResult) => void
  ): Promise<void>
  removeTask(id: string): void
  /** Drops every finished row in one action. Work still running stays: it is not a leftover. */
  clearFinishedTasks(): () => void
}

const TaskContext = createContext<TaskContextType | null>(null)

export const TaskProvider = ({ children }: { children: React.ReactNode }): JSX.Element => {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const [tasks, tasksDispatch] = useReducer(taskReducer, initialState)

  /**
   * Whether the launcher-update task has been added to the list yet. The
   * update download is the one task nothing in the renderer starts, so there
   * is no call site to add it from: the first progress tick to arrive is what
   * creates it, and every tick after that updates it. A ref, not state,
   * because the listener below is subscribed once and must not be resubscribed
   * to see the flag change.
   */
  const launcherUpdateTaskAdded = useRef(false)

  useEffect((): (() => void) => {
    window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider] Adding listener for download progress.`)
    const removeDownloadProgressListener = window.api.pathsManager.onDownloadProgress(({ id, progress }) => {
      // The final progress tick can arrive before downloadOnPath has flushed and resolved. Only
      // startDownload can mark a download completed, because that is the event that says the file
      // is on disk for consumers such as ListMods.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { progress, status: "in-progress" } } })
    })

    window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider] Adding listener for extract progress.`)
    const removeExtractProgressListener = window.api.pathsManager.onExtractProgress(({ id, progress }) => {
      if (progress === 100) return tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { progress, status: "in-progress" } } })
    })

    window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider] Adding listener for compress progress.`)
    const removeCompressProgressListener = window.api.pathsManager.onCompressProgress(({ id, progress }) => {
      if (progress === 100) return tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { progress, status: "in-progress" } } })
    })

    window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider] Adding listener for Optimum patch progress.`)
    const removePatchProgressListener = window.api.optimumManager.onPatchProgress(({ id, progress }) => {
      // The CLI climbs to 99 and never emits 100: the awaited call below is what
      // completes the task, the same split every other flow here keeps.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { progress, status: "in-progress" } } })
    })

    // The launcher's own update (#185). It gets a task like any other download
    // so it draws the same progress bar, in the same list, rather than a
    // one-off widget that only ever appears for this one case.
    window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider] Adding listener for launcher update progress.`)
    const removeUpdateProgressListener = window.api.appUpdater.onUpdateDownloadProgress(({ version, progress }) => {
      if (!launcherUpdateTaskAdded.current) {
        launcherUpdateTaskAdded.current = true
        return tasksDispatch({
          type: ACTIONS.ADD_TASK,
          payload: { id: LAUNCHER_UPDATE_TASK_ID, name: launcherUpdateName(version), desc: launcherUpdateName(version), type: "download", progress, status: "in-progress" }
        })
      }
      // No completion arm here on purpose (#200). The percentage is rounded on
      // the way out of the main process, so a tick at 99.6 arrives as 100 while
      // bytes are still moving, and on Windows the last stretch of a real
      // download overlaps the installer's signature check. Only
      // update-downloaded below knows the file is actually there.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id: LAUNCHER_UPDATE_TASK_ID, updates: { progress, status: "in-progress" } } })
    })

    // What completes the task, and the only thing that does, the same way a
    // resolved downloadOnPath does for every flow below: a last tick under 100
    // must not leave the update showing as still running.
    const removeUpdateDownloadedListener = window.api.appUpdater.onUpdateDownloaded(() => {
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id: LAUNCHER_UPDATE_TASK_ID, updates: COMPLETED } })
    })

    // A check that failed before any offer was made lands here too, on a task
    // that does not exist; the reducer's missing-id arm makes that a no-op.
    const removeUpdateErrorListener = window.api.appUpdater.onUpdateError(() => {
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id: LAUNCHER_UPDATE_TASK_ID, updates: { status: "failed" } } })
      // The failure offers the download again (NotificationsContext), and that
      // retry runs under this same id on a task the reducer now holds
      // terminal. Forgetting the task here is what lets the next tick start a
      // fresh one rather than try, and fail, to update a dead one.
      launcherUpdateTaskAdded.current = false
    })

    return () => {
      removeDownloadProgressListener()
      removeExtractProgressListener()
      removeCompressProgressListener()
      removePatchProgressListener()
      removeUpdateProgressListener()
      removeUpdateDownloadedListener()
      removeUpdateErrorListener()
    }
  }, [])

  /** The noun each task's prevent-close reason and its "Adding ___ to [PATH]" log use; irregular enough (extraction, installation, compression) that concatenating `type` does not produce them. */
  const TASK_NOUNS: Record<"download" | "extract" | "install" | "compress", string> = { download: "download", extract: "extraction", install: "installation", compress: "compression" }

  /**
   * The scaffold startDownload, startExtract, startInstall and startCompress used to each carry
   * on their own: a uuid, the prevent-close token, the two info logs, ADD_TASK, the awaited
   * operation, the COMPLETED dispatch and optional toast on success, classifyFailure and the
   * failed dispatch and optional toast on catch, and releasing the prevent-close token either way.
   *
   * The download resolving (or extracting, or installing, or compressing) is what completes the
   * task, not the progress events a separate listener feeds into the reducer above: a source whose
   * last tick lands under 100 would otherwise leave the task showing as still running forever, and
   * dispatching COMPLETED after a 100 tick already did costs nothing (the reducer is idempotent).
   *
   * `operation` is the one thing each of the four actually differs on: the host call itself, plus
   * whatever it alone needs after it (extract's post-await chmod, install's throw-on-!result.ok,
   * compress's optional compressionLevel). `onFinish` here stays the two-argument (status, error)
   * shape every non-download caller already has; download's own three-argument contract (status,
   * path, error) is adapted in its own wrapper, over data (the downloaded file's path) only that
   * wrapper's closure holds. The raw caught value is handed back as-is, not normalized to an
   * Error, so a wrapper's own `${err}` in its error message matches exactly what it produced
   * before this fold.
   *
   * Two of the four info logs are worded a little more generically than their old per-function
   * copies (a shared "runTask" tag instead of "startDownload"/"startExtract"/etc., and compress's
   * "Adding" log no longer names its source path, only its destination): neither reaches a player,
   * neither is asserted by a test, and log-provenance.test.ts still passes since nothing here
   * interpolates a path, a name or any other risky identifier.
   */
  async function runTask(
    config: { type: keyof typeof TASK_NOUNS; name: string; desc: string; notifications: TaskNotificationPolicy; messageKeys: { successKey: string; failureKey: string } },
    operation: (id: string) => Promise<void>,
    onFinish: (status: boolean, error: unknown) => void
  ): Promise<void> {
    const { type, name, desc, notifications, messageKeys } = config
    const id = crypto.randomUUID()
    const noun = TASK_NOUNS[type]
    const nameParam = `${type}Name`
    const LOG_TAG = `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > runTask] [${id}] [${type}]`

    try {
      window.api.utils.setPreventAppClose("add", id, `Started ${noun}.`)
      window.api.utils.logMessage("info", `${LOG_TAG} Adding ${noun} to [PATH].`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type, progress: 0, status: "pending" } })

      window.api.utils.logMessage("info", `${LOG_TAG} ${type}ing...`)
      await operation(id)

      window.api.utils.logMessage("info", `${LOG_TAG} ${type}ed.`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      if (notifications.completion === "toast") addNotification(t(messageKeys.successKey, { [nameParam]: name }), "success", { presentation: "toast" })
      onFinish(true, null)
    } catch (err) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error ${type}ing.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error ${type}ing: ${err}`)
      const reason = classifyFailure(err)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed", reason } } })
      if (notifications.failure === "generic") addNotification(t(messageKeys.failureKey, { [nameParam]: name }), "error", { reason })
      onFinish(false, err)
    } finally {
      window.api.utils.setPreventAppClose("remove", id, `Finished ${noun}.`)
    }
  }

  async function startDownload(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    url: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, path: string, error: Error | null) => void
  ): Promise<void> {
    let downloadedFile = ""
    await runTask(
      { type: "download", name, desc, notifications, messageKeys: { successKey: "notifications.body.downloaded", failureKey: "notifications.body.downloadError" } },
      async (id) => {
        downloadedFile = await window.api.pathsManager.downloadOnPath(id, url, outputPath, fileName)
      },
      (status, err) => onFinish(status, downloadedFile, status ? null : new Error(`Error downloading ${url}: ${err}`))
    )
  }

  async function startExtract(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    filePath: string,
    outputPath: string,
    deleteZip: boolean,
    onFinish: (status: boolean, error: Error | null) => void,
    unwrapSingleRootFolder = false
  ): Promise<void> {
    await runTask(
      { type: "extract", name, desc, notifications, messageKeys: { successKey: "notifications.body.extracted", failureKey: "notifications.body.extractError" } },
      async (id) => {
        const result = await window.api.pathsManager.extractOnPath(id, filePath, outputPath, deleteZip, unwrapSingleRootFolder)
        if (!result) throw new Error("Extraction failed")

        // Awaited so a rejected chmod is caught below instead of becoming an unhandled
        // rejection. A failed chmod fails the task on purpose: an unexecutable game is a
        // failed install on Linux, not a harmless side note. (On non-Linux platforms the
        // call resolves `false` without throwing, which is the normal, expected outcome.)
        await window.api.pathsManager.changePerms([outputPath], 0o755)
      },
      (status, err) => onFinish(status, status ? null : new Error(`Error extracting ${filePath}: ${err}`))
    )
  }

  async function startInstall(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    filePath: string,
    outputPath: string,
    deleteInstaller: boolean,
    onFinish: (status: boolean, error: Error | null) => void
  ): Promise<void> {
    await runTask(
      { type: "install", name, desc, notifications, messageKeys: { successKey: "notifications.body.installed", failureKey: "notifications.body.installError" } },
      async (id) => {
        const result = await window.api.pathsManager.runInstaller(id, filePath, outputPath, deleteInstaller)

        // The wire tells apart why the installer never landed the game (see
        // InstallerRunResult in global.d.ts), but onFinish here stays the
        // boolean shape every caller already expects: the reason still rides
        // along on the thrown Error's message for the log line below.
        if (!result.ok) throw new Error(`Installation failed: ${result.reason}`)
      },
      (status, err) => onFinish(status, status ? null : new Error(`Error installing ${filePath}: ${err}`))
    )
  }

  async function startCompress(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    inputPath: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, error: Error | null) => void,
    compressionLevel?: number
  ): Promise<void> {
    await runTask(
      { type: "compress", name, desc, notifications, messageKeys: { successKey: "notifications.body.compressed", failureKey: "notifications.body.compressError" } },
      async (id) => {
        const result = await window.api.pathsManager.compressOnPath(id, inputPath, outputPath, fileName, compressionLevel)
        if (!result) throw new Error("Compression failed")
      },
      (status, err) => onFinish(status, status ? null : new Error(`Error compressing: ${err}`))
    )
  }

  async function startOptimumPatch(
    name: string,
    desc: string,
    notifications: TaskNotificationPolicy,
    mode: "apply" | "restore",
    gameDirectory: string,
    gameVersion: string,
    onFinish: (result: OptimumPatchResult) => void
  ): Promise<void> {
    const id = crypto.randomUUID()

    try {
      window.api.utils.setPreventAppClose("add", id, "Started an Optimum patch.")
      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startOptimumPatch] [${id}] [install] Adding an Optimum patch of [PATH].`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type: "install", progress: 0, status: "pending" } })

      const result = mode === "apply" ? await window.api.optimumManager.applyOverlay(id, gameDirectory, gameVersion) : await window.api.optimumManager.restoreVanilla(id, gameDirectory)

      if (result.ok) {
        window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startOptimumPatch] [${id}] [install] Patched.`)
        // The CLI owns 0 to 99 and this owns the last tick, so the resolved call
        // is the only thing that can complete the task.
        tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
        if (notifications.completion === "toast") addNotification(t("notifications.body.extracted", { extractName: name }), "success", { presentation: "toast" })
      } else {
        window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startOptimumPatch] [${id}] [install] Refused: ${result.reason}.`)
        tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
        if (notifications.failure === "generic") addNotification(t("notifications.body.extractError", { extractName: name }), "error")
      }

      onFinish(result)
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startOptimumPatch] [${id}] [install] Error patching.`)
      window.api.utils.logMessage("debug", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startOptimumPatch] [${id}] [install] Error patching: ${err}`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
      if (notifications.failure === "generic") addNotification(t("notifications.body.extractError", { extractName: name }), "error")
      // Only a rejected invoke reaches here, which means the boundary refused the
      // call rather than the patch refusing the folder.
      onFinish({ ok: false, reason: "engine-internal" })
    } finally {
      window.api.utils.setPreventAppClose("remove", id, "Finished an Optimum patch.")
    }
  }

  function removeTask(id: string): void {
    tasksDispatch({ type: ACTIONS.REMOVE_TASK, payload: { id } })
  }

  function clearFinishedTasks(): () => void {
    const clearedTasks = tasks.filter((task) => !taskSurvivesBulkClear(task.status))
    for (const task of clearedTasks) tasksDispatch({ type: ACTIONS.REMOVE_TASK, payload: { id: task.id } })
    let restored = false
    return (): void => {
      if (restored) return
      restored = true
      // ADD_TASK puts a row at the head, so the snapshot goes back newest last to
      // come out in the order it had. A task started inside the five second undo
      // window ends up below these rather than above them.
      for (const task of [...clearedTasks].reverse()) tasksDispatch({ type: ACTIONS.ADD_TASK, payload: task })
    }
  }

  const activeTaskCount = tasks.filter((task) => task.status === "pending" || task.status === "in-progress").length
  return (
    <TaskContext.Provider value={{ tasks, activeTaskCount, startDownload, startExtract, startInstall, startCompress, startOptimumPatch, removeTask, clearFinishedTasks }}>
      {children}
    </TaskContext.Provider>
  )
}

export const useTaskContext = (): TaskContextType => {
  const context = useContext(TaskContext)
  if (!context) {
    throw new Error("useTaskContext must be used within an TaskProvider")
  }
  return context
}
