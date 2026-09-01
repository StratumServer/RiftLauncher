import React, { createContext, useReducer, useContext, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { LAUNCHER_UPDATE_TASK_ID, launcherUpdateName } from "@renderer/utils/launcherUpdateTask"

export interface TaskType {
  id: string
  name: string
  desc: string
  type: "download" | "extract" | "compress"
  progress: number
  status: "pending" | "in-progress" | "completed" | "failed"
}

/**
 * How a task's toasts are gated. The success toast always shows; what the two
 * modes differ on is the start toast and the generic error one.
 *
 * - "end": no start toast, and the generic error toast shows. For callers that
 *   do not report their own failures and want the ambient one.
 * - "progress": the start toast shows and the generic error one does not. For
 *   callers whose domain layer already raises its own specific failure
 *   notification, so the generic one would just be a second toast for the same
 *   event.
 */
export type TaskNotificationsMode = "end" | "progress"

function showsStart(mode: TaskNotificationsMode): boolean {
  return mode === "progress"
}

function showsError(mode: TaskNotificationsMode): boolean {
  return mode === "end"
}

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
 * UPDATE_TASK is deliberately idempotent: an update that would not change a
 * single field returns the very same state array, so `useReducer` bails out
 * instead of re-rendering every task consumer.
 *
 * A completed task now gets its completion dispatched twice on a normal run,
 * once by the progress listener seeing 100 and once by the flow's own success
 * path (both land on the same `{ progress: 100, status: "completed" }`), and
 * whichever arrives second has to be a no-op rather than a second render with
 * identical content.
 */
export function taskReducer(state: TaskType[], action: TaskAction): TaskType[] {
  switch (action.type) {
    case ACTIONS.ADD_TASK:
      return [action.payload, ...state]
    case ACTIONS.UPDATE_TASK: {
      const { id, updates } = action.payload
      const target = state.find((task) => task.id === id)
      if (!target || changesNothing(target, updates)) return state
      return state.map((task) => (task.id === id ? { ...task, ...updates } : task))
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
  startDownload(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    url: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, path: string, error: Error | null) => void
  ): Promise<void>
  startExtract(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    filePath: string,
    outputPath: string,
    deleteZip: boolean,
    onFinish: (status: boolean, error: Error | null) => void,
    unwrapSingleRootFolder?: boolean
  ): Promise<void>
  startInstall(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    filePath: string,
    outputPath: string,
    deleteInstaller: boolean,
    onFinish: (status: boolean, error: Error | null) => void
  ): Promise<void>
  startCompress(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    inputPath: string,
    outputPath: string,
    backupName: string,
    onFinish: (status: boolean, error: Error | null) => void,
    compressionLevel?: number
  ): Promise<void>
  removeTask(id: string): void
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
      if (progress === 100) return tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
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
    })

    return () => {
      removeDownloadProgressListener()
      removeExtractProgressListener()
      removeCompressProgressListener()
      removeUpdateProgressListener()
      removeUpdateDownloadedListener()
      removeUpdateErrorListener()
    }
  }, [])

  async function startDownload(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    url: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, path: string, error: Error | null) => void
  ): Promise<void> {
    const id = crypto.randomUUID()

    try {
      window.api.utils.setPreventAppClose("add", id, "Started download.")
      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startDownload] [${id}] [${fileName}] Adding download of ${url} to ${outputPath}.`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type: "download", progress: 0, status: "pending" } })

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startDownload] [${id}] [${fileName}] Downloading...`)
      if (showsStart(notifications)) addNotification(t("notifications.body.downloading", { downloadName: name }), "info")
      const downloadedFile = await window.api.pathsManager.downloadOnPath(id, url, outputPath, fileName)

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startDownload] [${id}] [${fileName}] Downloaded.`)
      // The download resolving is what completes the task, not the progress
      // events: a source whose last tick lands at 97 would otherwise leave the
      // task showing as still running forever. See the reducer above for why
      // dispatching this after a 100 tick already did costs nothing.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      addNotification(t("notifications.body.downloaded", { downloadName: name }), "success")
      onFinish(true, downloadedFile, null)
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startDownload] [${id}] [${fileName}] Error downloading.`)
      window.api.utils.logMessage("debug", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startDownload] [${id}] [${fileName}] Error downloading: ${err}`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
      if (showsError(notifications)) addNotification(t("notifications.body.downloadError", { downloadName: name }), "error")
      onFinish(false, "", new Error(`Error downloading ${url}: ${err}`))
    } finally {
      window.api.utils.setPreventAppClose("remove", id, "Finished download.")
    }
  }

  async function startExtract(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    filePath: string,
    outputPath: string,
    deleteZip: boolean,
    onFinish: (status: boolean, error: Error | null) => void,
    unwrapSingleRootFolder = false
  ): Promise<void> {
    const id = crypto.randomUUID()

    try {
      window.api.utils.setPreventAppClose("add", id, "Started extraction.")
      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startExtract] [${id}] [${filePath}] Adding extraction of ${filePath} to ${outputPath}.`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type: "extract", progress: 0, status: "pending" } })

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startExtract] [${id}] [${filePath}] Extracting...`)
      if (showsStart(notifications)) addNotification(t("notifications.body.extracting", { extractName: name }), "info")
      const result = await window.api.pathsManager.extractOnPath(id, filePath, outputPath, deleteZip, unwrapSingleRootFolder)

      if (!result) throw new Error("Extraction failed")

      // Awaited so a rejected chmod is caught below instead of becoming an unhandled
      // rejection. A failed chmod fails the task on purpose: an unexecutable game is a
      // failed install on Linux, not a harmless side note. (On non-Linux platforms the
      // call resolves `false` without throwing, which is the normal, expected outcome.)
      await window.api.pathsManager.changePerms([outputPath], 0o755)

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startExtract] [${id}] [${filePath}] Extracted.`)
      // Completed once the extraction and the chmod are both through, so a
      // last progress tick under 100 cannot strand the task as running.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      addNotification(t("notifications.body.extracted", { extractName: name }), "success")
      onFinish(true, null)
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startExtract] [${id}] [${filePath}] Error extracting.`)
      window.api.utils.logMessage("debug", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startExtract] [${id}] [${filePath}] Error extracting: ${err}`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
      if (showsError(notifications)) addNotification(t("notifications.body.extractError", { extractName: name }), "error")
      onFinish(false, new Error(`Error extracting ${filePath}: ${err}`))
    } finally {
      window.api.utils.setPreventAppClose("remove", id, "Finished extraction.")
    }
  }

  async function startInstall(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    filePath: string,
    outputPath: string,
    deleteInstaller: boolean,
    onFinish: (status: boolean, error: Error | null) => void
  ): Promise<void> {
    const id = crypto.randomUUID()

    try {
      window.api.utils.setPreventAppClose("add", id, "Started installation.")
      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startInstall] [${id}] [${filePath}] Adding installation of ${filePath} to ${outputPath}.`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type: "extract", progress: 0, status: "pending" } })

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startInstall] [${id}] [${filePath}] Installing...`)
      if (showsStart(notifications)) addNotification(t("notifications.body.extracting", { extractName: name }), "info")
      const result = await window.api.pathsManager.runInstaller(id, filePath, outputPath, deleteInstaller)

      // The wire tells apart why the installer never landed the game (see
      // InstallerRunResult in global.d.ts), but onFinish here stays the
      // boolean shape every caller already expects: the reason still rides
      // along on the thrown Error's message for the log line below.
      if (!result.ok) throw new Error(`Installation failed: ${result.reason}`)

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startInstall] [${id}] [${filePath}] Installed.`)
      // The worst of the four for this: an installer that ran to the end sends
      // a 100 tick, but one whose payload was read out instead reports whatever
      // the reader last counted, and neither is what says the task is done.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      addNotification(t("notifications.body.extracted", { extractName: name }), "success")
      onFinish(true, null)
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startInstall] [${id}] [${filePath}] Error installing.`)
      window.api.utils.logMessage("debug", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startInstall] [${id}] [${filePath}] Error installing: ${err}`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
      if (showsError(notifications)) addNotification(t("notifications.body.extractError", { extractName: name }), "error")
      onFinish(false, new Error(`Error installing ${filePath}: ${err}`))
    } finally {
      window.api.utils.setPreventAppClose("remove", id, "Finished installation.")
    }
  }

  async function startCompress(
    name: string,
    desc: string,
    notifications: TaskNotificationsMode,
    inputPath: string,
    outputPath: string,
    fileName: string,
    onFinish: (status: boolean, error: Error | null) => void,
    compressionLevel?: number
  ): Promise<void> {
    const id = crypto.randomUUID()

    try {
      window.api.utils.setPreventAppClose("add", id, "Started compression.")
      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startCompress] [${id}] [${fileName}] Adding compression of ${inputPath} to ${outputPath}.`)
      tasksDispatch({ type: ACTIONS.ADD_TASK, payload: { id, name, desc, type: "compress", progress: 0, status: "pending" } })

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startCompress] [${id}] [${fileName}] Compressing...`)
      if (showsStart(notifications)) addNotification(t("notifications.body.compressing", { compressName: name }), "info")
      const result = await window.api.pathsManager.compressOnPath(id, inputPath, outputPath, fileName, compressionLevel)

      if (!result) throw new Error("Compression failed")

      window.api.utils.logMessage("info", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startCompress] [${id}] [${fileName}] Compressed.`)
      // Same as the other three: the resolved call is the completion signal.
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: COMPLETED } })
      addNotification(t("notifications.body.compressed", { compressName: name }), "success")
      onFinish(true, null)
    } catch (err) {
      window.api.utils.logMessage("error", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startCompress] [${id}] [${fileName}] Error compressing.`)
      window.api.utils.logMessage("debug", `[front] [tasks] [contexts/TaskManagercontext.tsx] [TaskProvider > startCompress] [${id}] [${fileName}] Error compressing: ${err}`)
      tasksDispatch({ type: ACTIONS.UPDATE_TASK, payload: { id, updates: { status: "failed" } } })
      if (showsError(notifications)) addNotification(t("notifications.body.compressError", { compressName: name }), "error")
      onFinish(false, new Error(`Error comrpessing ${inputPath}: ${err}`))
    } finally {
      window.api.utils.setPreventAppClose("remove", id, "Finished compression.")
    }
  }

  function removeTask(id: string): void {
    tasksDispatch({ type: ACTIONS.REMOVE_TASK, payload: { id } })
  }

  return <TaskContext.Provider value={{ tasks, startDownload, startExtract, startInstall, startCompress, removeTask }}>{children}</TaskContext.Provider>
}

export const useTaskContext = (): TaskContextType => {
  const context = useContext(TaskContext)
  if (!context) {
    throw new Error("useTaskContext must be used within an TaskProvider")
  }
  return context
}
