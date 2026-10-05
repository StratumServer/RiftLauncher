import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire, Module } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Logger from "electron-log"
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest"

import type { AppUpdater, ResolvedUpdateFileInfo, UpdateInfo } from "electron-updater"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { registerAutoUpdaterEvents, scheduleUpdateCheck } from "@src/main/autoUpdaterEvents"
import { createUpdaterLogger } from "@src/utils/updaterLogger"

/**
 * What a failed update check leaves in the log (#650), against the real electron-updater.
 *
 * tests/main/autoUpdaterEvents.test.ts holds the same property against a double, and a double only
 * proves what it was told to do. The whole difficulty here is what the package does by itself: its
 * constructor listens to its own "error" event and writes `Error: ${error.stack}` at error level
 * through the logger in place, before the check's promise rejects. That line is not the check
 * caller's to write or to cut, so the only way to know a failed check leaves one line and not two is
 * to let the package fail one. The GitHub provider is replaced by one that fails the way the real
 * one does with no regular release published: a message that is a first line naming the reason,
 * then the whole releases feed.
 *
 * Everything else is the launcher's own: registerAutoUpdaterEvents, scheduleUpdateCheck, the
 * redacting logger createUpdaterLogger hands the package, and electron-log underneath, read after
 * logManager's redaction.
 */
const mockState = vi.hoisted(() => ({ userDataDir: "" }))

// The launcher's own modules import `electron`, and appUpdaterHandlers (reached through
// autoUpdaterEvents) registers its channels on import. electron-updater's own `require("electron")`
// is not reached by this mock: it is answered from the require cache, in beforeAll.
vi.mock("electron", () => {
  const app = {
    getPath: (): string => mockState.userDataDir,
    getAppPath: (): string => mockState.userDataDir,
    isPackaged: false,
    name: "RiftLauncher",
    getName: (): string => "RiftLauncher",
    getVersion: (): string => "0.0.0-test",
    isReady: (): boolean => true,
    on: (): void => {},
    off: (): void => {},
    once: (): void => {}
  }

  return { app, ipcMain: { handle: (): void => {}, on: (): void => {} } }
})

type ElectronUpdater = typeof import("electron-updater")
type AppAdapter = NonNullable<ConstructorParameters<ElectronUpdater["NsisUpdater"]>[1]>
type LogLine = { level: "error" | "warn" | "info" | "debug"; text: string }

const REASON = "Cannot parse releases feed: Error: Unable to find latest version on GitHub, please ensure a production release exists: HttpError: 406 Not Acceptable"
const FEED = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">${"<entry><title>A release</title></entry>".repeat(3_000)}</feed>`
const CHECK_PREFIX = "[back] [autoUpdaterEvents] [main/autoUpdaterEvents.ts] [scheduleUpdateCheck]"
const UPDATER_PREFIX = "[back] [index] [utils/updaterLogger.ts] [autoUpdater]"

let electronUpdater: ElectronUpdater
let forgetElectronStub: (() => void) | undefined
let temporaryRoot: string
let sent: Array<{ channel: string; payload?: unknown }>

// electron-updater requires `electron` while it loads, and there is no Electron process here (nor, on
// a CI job that skips the binary download, an installed one for the real package to hand back). The
// same stub tests/fixtures/electronUpdaterModuleShapeChild.mts puts in the require cache.
beforeAll(async () => {
  const requireFromHere = createRequire(__filename)
  const electronPath = requireFromHere.resolve("electron")
  const electronStub = new Module(electronPath)
  electronStub.filename = electronPath
  electronStub.loaded = true
  electronStub.exports = { app: {} }
  requireFromHere.cache[electronPath] = electronStub
  forgetElectronStub = (): void => {
    delete requireFromHere.cache[electronPath]
  }

  electronUpdater = await import("electron-updater")
})

afterAll(() => {
  forgetElectronStub?.()
})

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "update-check-failure-log-"))
  mockState.userDataDir = join(temporaryRoot, "userData")
  sent = []
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

/** Runs `attempt` and hands back every line that reached electron-log while it ran, after logManager's own redaction. */
async function logLinesDuring(attempt: () => Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = []
  const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    vi.spyOn(Logger, level).mockImplementation((...params: unknown[]) => {
      lines.push({ level, text: String(params[0]) })
    })
  )

  try {
    await attempt()
    return lines
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

/**
 * The real updater, wired the way main/index.ts wires it, whose feed fails with `failure`.
 * Packaged, so that it is willing to check at all; its staging id file goes to the temporary folder.
 */
function wiredUpdaterWhoseCheckFailsWith(failure: Error): AppUpdater {
  class FailingProvider extends electronUpdater.Provider<UpdateInfo> {
    constructor(...args: unknown[]) {
      super(args[2] as never)
    }

    getLatestVersion(): Promise<UpdateInfo> {
      return Promise.reject(failure)
    }

    resolveFiles(): ResolvedUpdateFileInfo[] {
      return []
    }
  }

  const app: AppAdapter = {
    version: "1.7.0-beta.13",
    name: "RiftLauncher",
    isPackaged: true,
    appUpdateConfigPath: join(temporaryRoot, "app-update.yml"),
    userDataPath: join(temporaryRoot, "userData"),
    baseCachePath: join(temporaryRoot, "cache"),
    whenReady: () => Promise.resolve(),
    relaunch: (): void => {},
    quit: (): void => {},
    onQuit: (): void => {}
  }

  const updater = new electronUpdater.NsisUpdater(undefined, app)
  updater.logger = createUpdaterLogger()
  updater.setFeedURL({ provider: "custom", updateProvider: FailingProvider })
  registerAutoUpdaterEvents(updater, (channel, payload) => sent.push({ channel, payload }))
  return updater
}

/** Arms the launcher's check, waits for the package to be asked, then for whatever reports its failure to have run. */
async function runTheScheduledCheck(updater: AppUpdater): Promise<void> {
  const check = vi.spyOn(updater, "checkForUpdates")
  scheduleUpdateCheck(updater, async () => false, 1)

  await vi.waitFor(() => assert.equal(check.mock.calls.length, 1))
  await Promise.resolve(check.mock.results[0]?.value).catch(() => undefined)
  // The catch that reports the failure runs a few microtasks after the promise settles.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("a failed update check, with the real electron-updater", () => {
  it("leaves one warn line holding only the reason, and nothing at error level", async () => {
    const updater = wiredUpdaterWhoseCheckFailsWith(new Error(`${REASON}\n${FEED}`))
    const logger = updater.logger

    const lines = await logLinesDuring(() => runTheScheduledCheck(updater))

    assert.deepEqual(
      lines.filter((line) => line.level === "warn").map((line) => line.text),
      [`${CHECK_PREFIX} Update check failed: ${REASON}.`]
    )
    assert.deepEqual(
      lines.filter((line) => line.level === "error").map((line) => line.text.length),
      [],
      "the updater's own record of the failure reached error.log"
    )
    assert.deepEqual(
      lines.filter((line) => line.text.length > 1_000).map((line) => `${line.level}: ${line.text.length} characters`),
      [],
      "a line carries more than the reason"
    )
    assert.ok(
      lines.some((line) => line.level === "info" && line.text === `${UPDATER_PREFIX} Checking for update`),
      "the updater's own account of the check went missing"
    )
    assert.equal(updater.logger, logger)
  })

  it("tells the renderer exactly what it told it before: that the check failed, with nothing in it", async () => {
    const updater = wiredUpdaterWhoseCheckFailsWith(new Error(`${REASON}\n${FEED}`))

    await logLinesDuring(() => runTheScheduledCheck(updater))

    assert.deepEqual(sent, [{ channel: IPC_CHANNELS.APP_UPDATER.UPDATE_ERROR, payload: undefined }])
  })

  it("still writes the updater's own record of an error that is not the check's", async () => {
    const updater = wiredUpdaterWhoseCheckFailsWith(new Error(`${REASON}\n${FEED}`))

    const lines = await logLinesDuring(async () => {
      await runTheScheduledCheck(updater)
      // What the package emits when a download dies halfway: no check is running, so nothing else reports it.
      updater.emit("error", new Error("connection reset"))
    })

    const records = lines.filter((line) => line.level === "error" && line.text.includes("connection reset")).map((line) => line.text)
    assert.equal(records.length, 1)
    assert.match(records[0] ?? "", /^\[back\] \[index\] \[utils\/updaterLogger\.ts\] \[autoUpdater\] Error: Error: connection reset\n/)
  })
})
