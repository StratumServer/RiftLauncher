/**
 * True for a VS Version row whose install was cut off.
 *
 * `incomplete` is written to config.json the moment the row is registered and cleared only once
 * the install is seen to finish; `_installing` lives in the running window alone. A row that has
 * the first without the second is not being installed by anyone: the launcher stopped (crash,
 * power cut, kill, a restart to update) before the install ended, so its folder may be empty,
 * partial or half copied and it cannot be played.
 */
export function isInterruptedInstall(version: { incomplete?: boolean; _installing?: boolean }): boolean {
  return version.incomplete === true && version._installing !== true
}
