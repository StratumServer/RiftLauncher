import assert from "node:assert/strict"
import { beforeEach, describe, it, vi } from "vitest"

/**
 * src/utils/autoUpdaterLoader.ts: the one place electron-updater is loaded.
 *
 * The package used to be a top-level import in main/index.ts, which cost 88.9 ms
 * of the main module's 163.8 ms of require time on every launch, measured in the
 * packaged app. What these tests pin is not the timing, which no test can hold
 * still, but the two properties that timing depends on: the module is imported
 * once per process however many callers ask for it, and it never reaches a
 * caller without the redacting logger already attached.
 */
const mockState = vi.hoisted(() => ({
  /** How many times the module factory has run, which is how many times it was really imported. */
  imports: 0,
  autoUpdater: { logger: undefined as unknown }
}))

// Shaped like the real package, not like a convenient double: electron-updater has no named
// `autoUpdater` export node's own ESM interop can see (see src/utils/autoUpdaterLoader.ts's own
// comment on why), only a `default` carrying it behind a getter. A mock that skipped straight to
// `{ autoUpdater: ... }` would let a reverted loader pass every test here while still throwing
// "Cannot set properties of undefined" in the packaged app.
vi.mock("electron-updater", () => {
  mockState.imports += 1
  return {
    // Declared (as undefined) rather than left off entirely: vitest's mocked module namespace
    // throws on a property access it was never told about, where node's real interop would just
    // hand back `undefined`. Declaring it is what lets `namespace.autoUpdater` behave like the
    // real absent export the loader's `??` fallback is written for.
    autoUpdater: undefined,
    default: {
      get autoUpdater(): { logger: unknown } {
        return mockState.autoUpdater
      }
    }
  }
})

vi.mock("@src/utils/logManager", () => ({
  logMessage: vi.fn(),
  getErrorMessage: (error: unknown): string => String(error)
}))

beforeEach(() => {
  vi.resetModules()
  mockState.imports = 0
  mockState.autoUpdater.logger = undefined
})

describe("loadAutoUpdater", () => {
  it("imports electron-updater once however many callers ask for it", async () => {
    const { loadAutoUpdater } = await import("@src/utils/autoUpdaterLoader")

    const [first, second] = await Promise.all([loadAutoUpdater(), loadAutoUpdater()])
    const third = await loadAutoUpdater()

    assert.equal(mockState.imports, 1)
    assert.equal(first, mockState.autoUpdater)
    assert.equal(second, mockState.autoUpdater)
    assert.equal(third, mockState.autoUpdater)
  })

  it("does not import anything until it is called", async () => {
    await import("@src/utils/autoUpdaterLoader")

    assert.equal(mockState.imports, 0)
  })

  it("attaches the redacting logger before the module reaches a caller", async () => {
    const { loadAutoUpdater } = await import("@src/utils/autoUpdaterLoader")

    const autoUpdater = await loadAutoUpdater()

    // Not the raw electron-log instance: every level has to be a function of this app's own,
    // so update errors carrying feed URLs and cache paths go through logMessage's redaction
    // rather than straight to disk. See src/utils/updaterLogger.ts.
    const logger = autoUpdater.logger as Record<string, unknown> | null
    assert.notEqual(logger, null)
    for (const level of ["info", "warn", "error", "debug"]) assert.equal(typeof logger?.[level], "function")
  })
})
