import { join } from "node:path"
import fse from "fs-extra"

import { planUserDataMigration } from "@domain/userData/migrationPlan"
import type { UserDataMigrationAction } from "@domain/userData/migrationPlan"

/** Folder RiftLauncher keeps its own user data in, under the platform's appData. */
export const RIFT_USER_DATA_FOLDER = "RiftLauncher"

/** Folder VS Launcher keeps its user data in. Read from, never written to. */
export const LEGACY_USER_DATA_FOLDER = "VSLauncher"

/** Sibling a migration builds in, renamed onto {@link RIFT_USER_DATA_FOLDER} once complete. */
export const MIGRATION_TEMP_FOLDER = "RiftLauncher.migrating"

/** What happened, on top of the three planned actions. */
export type UserDataSetupOutcome =
  | UserDataMigrationAction
  /** A copy started and did not finish. The launcher starts on an empty folder. */
  | "migration-failed"

export interface UserDataSetup {
  /** Folder to hand to `app.setPath("userData", ...)`. */
  readonly path: string
  readonly outcome: UserDataSetupOutcome
  /** Entries actually copied over, in the order they were copied. */
  readonly copied: readonly string[]
  /** Whether a half-finished copy from an earlier run was thrown away first. */
  readonly cleanedStaleMigration: boolean
}

/**
 * Picks the user-data folder and carries VS Launcher's data over the first time.
 *
 * Runs synchronously and before anything else, because `app.setPath` has to be
 * called before the logger, the config manager or any handler reads `userData`.
 *
 * The copy lands in a temporary sibling and is renamed into place as the last
 * step, so an interrupted run leaves a folder that is obviously incomplete
 * rather than a RiftLauncher folder that looks migrated and is not. The next
 * run deletes that leftover and starts over.
 *
 * The VS Launcher folder is only ever read. An installed VS Launcher keeps
 * every byte it had, and a player can go back to it at any time.
 *
 * @param appDataPath The platform's roaming application-data folder.
 * @returns The folder to use and what was done to get there.
 */
export function setUpUserDataFolder(appDataPath: string): UserDataSetup {
  const riftPath = join(appDataPath, RIFT_USER_DATA_FOLDER)
  const legacyPath = join(appDataPath, LEGACY_USER_DATA_FOLDER)
  const temporaryPath = join(appDataPath, MIGRATION_TEMP_FOLDER)

  const plan = planUserDataMigration({
    riftExists: fse.existsSync(riftPath),
    vslExists: fse.existsSync(legacyPath),
    staleMigrationExists: fse.existsSync(temporaryPath)
  })

  if (plan.cleanStaleMigration) fse.removeSync(temporaryPath)

  if (plan.action !== "migrate") {
    fse.ensureDirSync(riftPath)
    return { path: riftPath, outcome: plan.action, copied: [], cleanedStaleMigration: plan.cleanStaleMigration }
  }

  const copied: string[] = []

  try {
    fse.ensureDirSync(temporaryPath)

    for (const entry of plan.copy) {
      const source = join(legacyPath, entry)
      if (!fse.existsSync(source)) continue
      fse.copySync(source, join(temporaryPath, entry))
      copied.push(entry)
    }

    fse.moveSync(temporaryPath, riftPath)
  } catch {
    // A migration that cannot finish must not stop the launcher from starting.
    // The leftover goes, the player gets an empty folder, and VS Launcher's own
    // data is still there to try again from on the next run.
    fse.removeSync(temporaryPath)
    fse.ensureDirSync(riftPath)
    return { path: riftPath, outcome: "migration-failed", copied: [], cleanedStaleMigration: plan.cleanStaleMigration }
  }

  return { path: riftPath, outcome: "migrate", copied, cleanedStaleMigration: plan.cleanStaleMigration }
}

/** One line for the startup log, describing what {@link setUpUserDataFolder} did. */
export function describeUserDataSetup(setup: UserDataSetup): string {
  const stale = setup.cleanedStaleMigration ? " Discarded an unfinished migration from an earlier run." : ""

  switch (setup.outcome) {
    case "use-existing":
      return `Using the existing RiftLauncher user data folder.${stale}`
    case "migrate":
      return `Copied ${setup.copied.length > 0 ? setup.copied.join(", ") : "nothing"} from the VS Launcher user data folder, which was left untouched.${stale}`
    case "migration-failed":
      return `Could not copy the VS Launcher user data folder. Starting on an empty RiftLauncher folder.${stale}`
    case "fresh":
      return `Created a new RiftLauncher user data folder.${stale}`
  }
}
