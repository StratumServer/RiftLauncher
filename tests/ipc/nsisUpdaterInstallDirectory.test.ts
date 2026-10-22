import assert from "node:assert/strict"
import { describe, it, vi } from "vitest"

import type { AppAdapter } from "electron-updater/out/AppAdapter"

/**
 * UPDATE_AND_RESTART sets `installDirectory` on the updater and relies on the real NsisUpdater turning
 * it into the last installer argument (#734). The handler tests mock the updater and only see the
 * property, so this drives the real class and reads the arguments it hands to the spawn.
 */

const INSTALLER = "C:\\Temp\\RiftLauncher-Setup.exe"

const appAdapter: AppAdapter = {
  version: "1.7.0",
  name: "RiftLauncher",
  isPackaged: true,
  appUpdateConfigPath: "app-update.yml",
  userDataPath: "userData",
  baseCachePath: "cache",
  whenReady: async (): Promise<void> => {},
  relaunch: (): void => {},
  quit: (): void => {},
  onQuit: (): void => {}
}

interface InstallDriver {
  installDirectory?: string
  doInstall: (options: { isSilent: boolean; isForceRunAfter: boolean; isAdminRightsRequired: boolean }) => boolean
}

async function installerArgumentsFor(installDirectory: string | undefined): Promise<string[]> {
  const { NsisUpdater } = await import("electron-updater")
  const updater = new NsisUpdater(null, appAdapter)
  vi.spyOn(updater as unknown as { installerPath: string | null }, "installerPath", "get").mockReturnValue(INSTALLER)
  const spawnLog = vi.spyOn(updater as unknown as { spawnLog: () => Promise<boolean> }, "spawnLog").mockResolvedValue(true)
  const driver = updater as unknown as InstallDriver
  driver.installDirectory = installDirectory

  assert.equal(driver.doInstall({ isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }), true)

  assert.equal(spawnLog.mock.calls.length, 1)
  const [command, args] = spawnLog.mock.calls[0] as unknown as [string, string[]]
  assert.equal(command, INSTALLER)
  return args
}

describe("NsisUpdater installDirectory", () => {
  it.each([
    ["a portable folder on another drive", "D:\\Games\\RiftLauncher"],
    ["a folder with a space", "C:\\Program Files\\RiftLauncher"]
  ])("passes %s as the last installer argument, after --force-run", async (_label, folder) => {
    const args = await installerArgumentsFor(folder)

    assert.deepEqual(args, ["--updated", "/S", "--force-run", `/D=${folder}`])
  })

  it("passes no /D= when installDirectory is unset, so the installer falls back to the registry", async () => {
    const args = await installerArgumentsFor(undefined)

    assert.deepEqual(args, ["--updated", "/S", "--force-run"])
  })
})
