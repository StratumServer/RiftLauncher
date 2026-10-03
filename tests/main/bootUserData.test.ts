import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { setDefaultFolderPathRoot } from "@src/config/configManager"
import { readLinuxPackageType } from "@src/main/linuxPackageType"
import { selectUserDataFolder } from "@src/main/profileChoice"
import type { UserDataSelection } from "@src/main/profileChoice"

/**
 * What the boot module asks Electron to do, in what order, and what the entry is left holding when
 * the profile cannot be prepared. The decision itself belongs to tests/main/profileChoice.test.ts;
 * what is only visible here is the wiring, so `selectUserDataFolder` is answered with a fixture
 * instead of a folder layout, and only Electron is faked.
 *
 * The order is the point of the whole module: Electron derives its single-instance lock from
 * userData, so the lock folder has to be in place before the lock is taken, and the real profile
 * only after it.
 */

const SINGLE_INSTANCE_LOCK_FOLDER = "RiftLauncher.singleton"

/** Per test, and deliberately not created: a first run on a fresh account has no profile folder. */
let workDir = ""
let appDataPath = ""
let lockFolder = ""

const state = vi.hoisted(() => ({
  appData: "",
  calls: [] as string[],
  exitCodes: [] as number[],
  lockGranted: true,
  paths: {} as Record<string, string>
}))

vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      state.calls.push(`getPath:${name}`)
      return state.paths[name] ?? state.appData
    },
    setPath: (name: string, value: string): void => {
      state.calls.push(`setPath:${name}=${value}`)
      state.paths[name] = value
    },
    requestSingleInstanceLock: (): boolean => {
      state.calls.push("requestSingleInstanceLock")
      return state.lockGranted
    }
  }
}))

vi.mock("@src/config/configManager", () => ({ setDefaultFolderPathRoot: vi.fn() }))
vi.mock("@src/main/linuxPackageType", () => ({ readLinuxPackageType: vi.fn() }))

vi.mock("@src/main/profileChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/main/profileChoice")>()),
  selectUserDataFolder: vi.fn()
}))

const selection = (path: string, portableMode: boolean): UserDataSelection => ({
  setup: { path, outcome: "fresh", copied: [], cleanedStaleMigration: false },
  portableMode,
  rejectedMarker: false
})

/** Imports the module fresh, so its import-time wiring runs again against the fakes above. */
const boot = async (): Promise<typeof import("@src/main/bootUserData")> => {
  vi.resetModules()
  return import("@src/main/bootUserData")
}

describe("the boot module wires the profile into a running app", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "riftlauncher-boot-"))
    appDataPath = join(workDir, "AppData", "Roaming")
    lockFolder = join(appDataPath, SINGLE_INSTANCE_LOCK_FOLDER)
    state.appData = appDataPath
    state.calls.length = 0
    state.exitCodes.length = 0
    state.lockGranted = true
    state.paths = {}
    vi.mocked(setDefaultFolderPathRoot).mockClear()
    vi.mocked(readLinuxPackageType).mockReset()
    vi.mocked(selectUserDataFolder).mockReset()
    vi.spyOn(process, "exit").mockImplementation(((code?: number): never => {
      state.exitCodes.push(code ?? 0)
      // The module keeps running after the mocked exit, so the profile decision below still happens.
      return undefined as never
    }) as never)
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("holds only the lock in userData when it asks Electron for the single-instance lock", async () => {
    vi.mocked(selectUserDataFolder).mockImplementation(() => {
      state.calls.push("selectUserDataFolder")
      return selection("/profiles/default", false)
    })
    const { userDataSetup } = await boot()

    const lockIndex = state.calls.indexOf("requestSingleInstanceLock")
    const lockPathIndex = state.calls.indexOf(`setPath:userData=${lockFolder}`)

    assert.ok(lockIndex > 0, `expected a lock request, got ${JSON.stringify(state.calls)}`)
    assert.ok(lockPathIndex >= 0 && lockPathIndex < lockIndex, `the lock folder must be set before the lock is taken, got ${JSON.stringify(state.calls)}`)
    assert.ok(state.calls.indexOf("selectUserDataFolder") > lockIndex, `the profile must be selected after Electron takes the lock, got ${JSON.stringify(state.calls)}`)
    assert.ok(existsSync(lockFolder), "the lock folder has to exist before Electron is asked to lock it")
    assert.equal(userDataSetup.path, "/profiles/default")
  })

  it.skipIf(process.platform !== "linux")("checks the Linux package marker before selecting a portable profile", async () => {
    const previousAppImage = process.env.APPIMAGE
    process.env.APPIMAGE = join(workDir, "RiftLauncher.AppImage")
    vi.mocked(readLinuxPackageType).mockReturnValue("deb")
    vi.mocked(selectUserDataFolder).mockReturnValue(selection("/profiles/default", false))

    try {
      await boot()

      assert.equal(vi.mocked(readLinuxPackageType).mock.calls.length, 1)
      assert.deepEqual(vi.mocked(selectUserDataFolder).mock.calls, [[appDataPath, null]])
    } finally {
      if (previousAppImage === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = previousAppImage
    }
  })

  it.skipIf(process.platform === "win32")("restricts the lock folder to the current account", async () => {
    vi.mocked(selectUserDataFolder).mockReturnValue(selection("/profiles/default", false))
    await boot()

    assert.equal(statSync(lockFolder).mode & 0o777, 0o700)
  })

  it("hands the process to the instance that holds the lock, without calling it a boot failure", async () => {
    state.lockGranted = false
    vi.mocked(selectUserDataFolder).mockReturnValue(selection("/profiles/default", false))
    const module = await boot()

    assert.deepEqual(state.exitCodes, [0])
    assert.equal(module.bootFailure, null)
  })

  it("points userData and sessionData at the chosen profile and roots the default folder beside appData", async () => {
    vi.mocked(selectUserDataFolder).mockReturnValue(selection("/profiles/default", false))
    const module = await boot()

    assert.ok(state.calls.includes("setPath:userData=/profiles/default"))
    assert.ok(state.calls.includes("setPath:sessionData=/profiles/default"))
    assert.deepEqual(vi.mocked(setDefaultFolderPathRoot).mock.calls, [[appDataPath]])
    assert.equal(module.bootFailure, null)
    assert.equal(module.portableMode, false)
    assert.equal(module.portableNote, "")
  })

  it("roots the default folder at the portable profile when the marker chose one", async () => {
    vi.mocked(selectUserDataFolder).mockReturnValue(selection("/install/portable-profile", true))
    const module = await boot()

    assert.deepEqual(vi.mocked(setDefaultFolderPathRoot).mock.calls, [["/install/portable-profile"]])
    assert.equal(module.portableMode, true)
    assert.match(module.portableNote, /portable profile folder/)
    assert.equal(module.bootFailure, null)
  })

  it("hands the entry a readable failure and no half-chosen profile when the profile cannot be prepared", async () => {
    vi.mocked(selectUserDataFolder).mockImplementation(() => {
      throw new Error("Portable profile or migration folder overlaps the NSIS install folder.")
    })
    const module = await boot()

    assert.equal(module.bootFailure?.detail, "Portable profile or migration folder overlaps the NSIS install folder.")
    // Still the lock folder, so nothing was written to a profile this player did not choose.
    assert.equal(module.userDataSetup.path, lockFolder)
    assert.equal(module.userDataSetup.outcome, "unavailable")
    assert.equal(module.portableNote, "")
    assert.equal(vi.mocked(setDefaultFolderPathRoot).mock.calls.length, 0)
    assert.deepEqual(state.exitCodes, [])
  })

  it("says why the lock folder could not be created instead of exiting as if another copy were running", async () => {
    const blocker = join(workDir, "not-a-folder")
    writeFileSync(blocker, "a file where appData needs a folder")
    state.appData = join(blocker, "AppData", "Roaming")
    const module = await boot()

    const detail = module.bootFailure?.detail ?? ""
    assert.match(detail, /Could not create the folder Electron keeps the profile and the single instance lock in/)
    assert.match(detail, /ENOTDIR|not a directory/)
    assert.ok(detail.includes(join(state.appData, SINGLE_INSTANCE_LOCK_FOLDER)), `the diagnostic must keep the actionable path, got ${detail}`)
    assert.equal(module.userDataSetup.outcome, "unavailable")
    assert.equal(module.portableNote, "")
    // Exiting here would look to the player like another instance owns the launcher.
    assert.deepEqual(state.exitCodes, [])
    assert.equal(state.calls.includes("requestSingleInstanceLock"), false)
    assert.equal(vi.mocked(selectUserDataFolder).mock.calls.length, 0)
    assert.equal(vi.mocked(setDefaultFolderPathRoot).mock.calls.length, 0)
  })
})
