import type { BootFailure } from "@src/main/bootUserData"

const ERROR_TITLE = "RiftLauncher could not start"

export function logUserDataSetupUnlessBootFailed(failure: BootFailure | null, message: string, writeLog: (message: string) => void): void {
  if (failure === null) writeLog(message)
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
