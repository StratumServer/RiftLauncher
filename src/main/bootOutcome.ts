import type { BootFailure } from "@src/main/bootUserData"
import type { UserDataSetup } from "@src/main/userDataMigration"

const ERROR_TITLE = "RiftLauncher could not start"

export function logUserDataSetupUnlessBootFailed(failure: BootFailure | null, message: string, writeLog: (message: string) => void): void {
  if (failure === null) writeLog(message)
}

/** Tells the player a VS Launcher import failed, but only when the next start will try it again. */
export function reportFailedImportUnlessBootFailed(failure: BootFailure | null, setup: Pick<UserDataSetup, "outcome" | "importPending">, report: () => void): void {
  if (failure === null && setup.outcome === "migration-failed" && setup.importPending === true) report()
}

export function reportBootFailure(
  failure: BootFailure | null,
  reporters: {
    readonly writeStderr: (message: string) => void
    readonly showErrorBox: (title: string, message: string) => void
    readonly exit: (code: number) => void
  }
): boolean {
  if (failure === null) return false

  const message = failure.detail
  reporters.writeStderr(`${ERROR_TITLE}: ${message}\n`)
  reporters.showErrorBox(ERROR_TITLE, message)
  reporters.exit(1)
  return true
}
