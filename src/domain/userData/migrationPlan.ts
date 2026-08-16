/**
 * Decides which folder the launcher keeps its user data in, and whether
 * anything has to be carried over from the VS Launcher folder first.
 *
 * The fork used to point `userData` straight at the VS Launcher folder so an
 * existing player kept their config on the first run. That was safe while the
 * two applications shared an appId and could never be installed side by side.
 * Since v1.7.0-beta.1 RiftLauncher installs under its own identity, so both can
 * run on the same machine, and two applications writing one `config.json` is a
 * corruption waiting to happen.
 *
 * So the data moves to a folder of our own, by copy. Nothing is ever renamed
 * away from VS Launcher and nothing is ever deleted there: whatever that
 * installation still needs stays exactly where it was.
 *
 * Everything here is pure. It takes three answers about what exists on disk and
 * returns what to do about it; probing and copying belong to the host.
 */

/** What the launcher does with the folders it found. */
export type UserDataMigrationAction =
  /** A RiftLauncher folder is already there, so it is used untouched. */
  | "use-existing"
  /** No RiftLauncher folder, but a VS Launcher one: carry a copy over. */
  | "migrate"
  /** Neither folder exists, so this is a first run with nothing to carry. */
  | "fresh"

/**
 * Entries copied out of the VS Launcher folder, and the only ones.
 *
 * `config.json` is the whole point: installations, versions, folders, window
 * state. `Icons` holds the images a player picked for their installations,
 * which nothing can rebuild. `Logs` and `Cache` are deliberately left behind.
 * The mod catalogue and the mod images regenerate on demand, and the logs of
 * another application are not ours to duplicate.
 *
 * `account-secrets.json` also stays behind: it is sealed by the OS keychain
 * under the identity that wrote it, so copying it would move a blob the new
 * identity may not be able to open. A migrated player signs in again.
 */
export const MIGRATED_USER_DATA_ENTRIES = ["config.json", "Icons"] as const

export type MigratedUserDataEntry = (typeof MIGRATED_USER_DATA_ENTRIES)[number]

/** What the host found on disk, before anything is decided. */
export interface UserDataProbe {
  /** Whether the RiftLauncher user-data folder is already there. */
  readonly riftExists: boolean
  /** Whether a VS Launcher user-data folder is there to copy from. */
  readonly vslExists: boolean
  /** Whether a temporary migration folder survived an earlier run. */
  readonly staleMigrationExists: boolean
}

interface UserDataPlanBase {
  /**
   * Whether a leftover temporary folder has to go before anything else.
   *
   * A migration copies into a temporary sibling and renames it into place as
   * its very last step, so a temporary folder that outlived its run is by
   * definition half a copy. It is removed rather than trusted, whichever action
   * follows.
   */
  readonly cleanStaleMigration: boolean
}

export type UserDataMigrationPlan =
  | (UserDataPlanBase & { readonly action: "use-existing" })
  | (UserDataPlanBase & { readonly action: "migrate"; readonly copy: readonly MigratedUserDataEntry[] })
  | (UserDataPlanBase & { readonly action: "fresh" })

/**
 * Reads the three facts about the disk and says what the launcher should do.
 *
 * An existing RiftLauncher folder always wins: once the migration has run, the
 * VS Launcher folder is somebody else's data and its later edits are none of
 * our business.
 *
 * @param probe What the host found on disk.
 * @returns The action to take, plus whether a stale temporary folder is in the way.
 */
export function planUserDataMigration(probe: UserDataProbe): UserDataMigrationPlan {
  const cleanStaleMigration = probe.staleMigrationExists

  if (probe.riftExists) return { action: "use-existing", cleanStaleMigration }
  if (probe.vslExists) return { action: "migrate", cleanStaleMigration, copy: MIGRATED_USER_DATA_ENTRIES }

  return { action: "fresh", cleanStaleMigration }
}
