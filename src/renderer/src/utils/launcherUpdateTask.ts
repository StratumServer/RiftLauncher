/**
 * The one task id every launcher-update progress event drives.
 *
 * Fixed rather than generated, unlike the uuid each download/extract/compress
 * flow mints for itself: this task is started by the main process, over a
 * stream of events the renderer only observes, so both ends have to agree on
 * which task a percentage belongs to without ever exchanging an id. There can
 * only ever be one launcher update in flight, which is what makes a constant
 * enough.
 */
export const LAUNCHER_UPDATE_TASK_ID = "launcher-update"

/**
 * What the task list and the toasts call the update, e.g. "RiftLauncher 1.7.0".
 *
 * Deliberately not translated: it is a product name and a version, the same
 * kind of free text every other task description carries (an installation
 * name, a mod name), not a sentence.
 */
export function launcherUpdateName(version: string): string {
  const trimmed = version.trim()
  return trimmed ? `RiftLauncher ${trimmed}` : "RiftLauncher"
}
