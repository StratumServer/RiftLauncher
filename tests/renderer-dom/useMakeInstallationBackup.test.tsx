import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { ConfigProvider, useInstallations } from "@renderer/features/config/contexts/ConfigContext"
import { BACKUP_NO_INSTALLATION, useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside the hook, the same
// way renderWithProviders (./helpers/render) does for full-page renders.
import "@renderer/i18n"

const INSTALLATION_PATH = "/games/a"

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: INSTALLATION_PATH,
    version: "1.20.0",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <ConfigProvider>
        <TaskProvider>{children}</TaskProvider>
      </ConfigProvider>
    </NotificationsProvider>
  )
}

describe("useMakeInstallationBackup outcomes", () => {
  it("hard-stops on an installation it cannot find, with a reason no prompt should offer to skip", async () => {
    // The hard-stop arm is unreachable from MainMenu, which passes the id off an
    // already-resolved installation, but it still has to be a hard stop: turning
    // it into { ok: true } would launch a game whose installation the launcher
    // just failed to find (#338 review, blocker 5).
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [] })) } })

    const { result } = renderHook(() => useMakeInstallationBackup(), { wrapper })
    const outcome = await result.current("does-not-exist")

    expect(outcome).toEqual({ ok: false, reason: BACKUP_NO_INSTALLATION })
  })
})

/**
 * Issue #358. describeBackupFailure picks the sentence off the cause the
 * service carries, and tests/renderer/describeBackupFailure.test.ts pins that
 * mapping, including the arm where there is no cause. That leaves the hook's
 * own call free to stop passing one: every failure would fall back to "the
 * archive could not be written" and the suite would stay green, which is the
 * #337 state again. So the assertion here is on the sentence a player reads
 * after a real compression failure, driven end to end through the hook.
 */
describe("useMakeInstallationBackup failure notification", () => {
  const FULL_DRIVE = "No backup made: the drive holding the Backups folder does not have enough free space for this Installation."
  const GENERIC_WRITE_FAILURE = "No backup made: the backup archive could not be written. Check that the Backups folder is on a writable drive with free space."

  it("names the cause the compression reported rather than the generic write failure", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ backupsFolder: "/backups", installations: [anInstallation()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        // What the compress worker raises when assertRoomForArchive refuses the
        // destination, wrapped the way TaskManagerContext wraps it.
        compressOnPath: vi.fn(async () => {
          throw new Error("Compression failed: Not enough free space for the backup: 12 GB more is needed")
        })
      }
    })

    const { result } = renderHook(() => ({ makeBackup: useMakeInstallationBackup(), installations: useInstallations(), notifications: useNotificationsContext() }), { wrapper })
    // The config loads asynchronously, and the hook resolves the installation off it.
    await waitFor(() => expect(result.current.installations).toHaveLength(1))

    const outcome = await result.current.makeBackup("install-a")

    expect(outcome).toEqual({ ok: false, reason: "compress-failed" })
    await waitFor(() => expect(result.current.notifications.history.map((notification) => notification.body)).toContain(FULL_DRIVE))
    expect(result.current.notifications.history.map((notification) => notification.body)).not.toContain(GENERIC_WRITE_FAILURE)
  })
})

/**
 * Issue #507, reported on Discord. An archive removed from the Backups folder
 * outside the launcher leaves its record behind, and the host refuses to delete
 * a path it cannot find (assertManagedDeletionPath in ipc/pathPolicy.ts). Once
 * the records reach the Installation's limit the prune has to remove one, so
 * every backup was refused with a sentence about making room, which reads as a
 * limit the player has to raise.
 */
describe("useMakeInstallationBackup with an archive missing from the Backups folder", () => {
  const PRUNE_FAILED = "No backup made: an old backup file could not be deleted to make room for the new one. Check that it is not open in another program, then try again."
  const MISSING_ARCHIVE = "/backups/a/backup-6.tar.gz"

  function anInstallationAtItsLimit(): InstallationType {
    return {
      ...anInstallation(),
      backupsLimit: 6,
      // Newest first, the order the config keeps them in.
      backups: Array.from({ length: 6 }, (_, index) => ({ id: `backup-${index + 1}`, date: 1_700_000_000_000 - index, path: `/backups/a/backup-${index + 1}.tar.gz` }))
    }
  }

  it("makes the backup and drops the record whose archive is gone", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ backupsFolder: "/backups", installations: [anInstallationAtItsLimit()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async (path: string) => path !== MISSING_ARCHIVE),
        deletePath: vi.fn(async (path: string) => path !== MISSING_ARCHIVE),
        compressOnPath: vi.fn(async () => true)
      }
    })

    const { result } = renderHook(() => ({ makeBackup: useMakeInstallationBackup(), installations: useInstallations(), notifications: useNotificationsContext() }), { wrapper })
    await waitFor(() => expect(result.current.installations).toHaveLength(1))

    const outcome = await result.current.makeBackup("install-a")

    expect(outcome).toEqual({ ok: true })
    expect(result.current.notifications.history.map((notification) => notification.body)).not.toContain(PRUNE_FAILED)
    await waitFor(() => expect(result.current.installations[0]?.backups.map((backup) => backup.id)).not.toContain("backup-6"))
  })
})
