import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { beforeAll, describe, it } from "vitest"

/**
 * The regression guard for src/utils/autoUpdaterLoader.ts's actual bug: electron-updater
 * defines `autoUpdater` with a late `Object.defineProperty(exports, "autoUpdater", { get: ... })`
 * rather than a plain assignment, and node's ESM interop finds a CommonJS module's named exports
 * by running cjs-module-lexer's static analysis over its source, which does not recognise that
 * getter form. The loader used to destructure `{ autoUpdater }` straight off the awaited dynamic
 * import, which is `undefined` for exactly that reason, so every packaged launch that reached
 * `autoUpdater.logger = ...` threw "Cannot set properties of undefined".
 *
 * This cannot be reproduced by simply not mocking electron-updater inside a vitest test: vitest's
 * own CJS interop enumerates the getter and hands `autoUpdater` back as a named binding, so an
 * unmocked `await import("electron-updater")` inside vitest has `hasOwnProperty(mod, "autoUpdater")
 * === true` and passes whether the loader is fixed or not. What actually differs is node's own
 * interop, so this spawns a bare `node` child process (no vitest, no tsx — tried, and tsx's own
 * CJS/ESM interop turns out to enumerate the same getter vitest's does, which would have hidden
 * the bug the same way) and asks it directly. See tests/fixtures/electronUpdaterModuleShapeChild.mts
 * for the probe and why it does not import the shipped loader file itself.
 */

interface ModuleShapeResult {
  hasOwnNamedAutoUpdater: boolean
  hasDefaultAutoUpdaterDescriptor: boolean
  resolvedFrom: "named" | "default" | "neither"
  resolvedMethods: Record<string, boolean>
}

const repoRoot = join(__dirname, "../..")
const fixturePath = join(__dirname, "../fixtures/electronUpdaterModuleShapeChild.mts")

/** Runs the probe once and parses its one line of JSON. Failure carries the child's stderr, since a broken stub or a genuinely changed electron-updater otherwise shows up as an unreadable JSON.parse error. */
function runModuleShapeProbe(): ModuleShapeResult {
  let stdout: string
  try {
    // stdio is piped rather than left to inherit so the child's own stderr (electron-updater
    // logs a "package-type" warning to it while resolving the Linux updater, since the stubbed
    // app carries no real install path) never reaches the test run's own output on the success
    // path; it is still captured, and surfaced below, the one time it is actually useful.
    stdout = execFileSync(process.execPath, [fixturePath], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    throw new Error(`electron-updater module-shape probe did not run cleanly.\n--- stdout ---\n${failure.stdout ?? ""}\n--- stderr ---\n${failure.stderr ?? ""}`, { cause: error })
  }

  try {
    return JSON.parse(stdout) as ModuleShapeResult
  } catch (error) {
    throw new Error(`electron-updater module-shape probe printed something that was not JSON: ${JSON.stringify(stdout)}`, { cause: error })
  }
}

let result: ModuleShapeResult

beforeAll(() => {
  result = runModuleShapeProbe()
})

describe("electron-updater's real export shape, under node's own ESM interop", () => {
  it("does not surface autoUpdater as a named export the way electron-updater's own .d.ts promises", () => {
    // If this goes red because electron-updater started defining `autoUpdater` in a form
    // cjs-module-lexer can see, that is good news, not a broken test: the `?? mod.default.autoUpdater`
    // fallback in src/utils/autoUpdaterLoader.ts is then dead code and should be dropped, and this
    // assertion (with the descriptor one below) should be rewritten to match the new shape.
    assert.equal(
      result.hasOwnNamedAutoUpdater,
      false,
      'electron-updater now exposes a named "autoUpdater" export node\'s interop can see. Simplify loadAutoUpdater in src/utils/autoUpdaterLoader.ts to drop its mod.default fallback, and rewrite this assertion to expect the named export instead.'
    )
  })

  it("keeps the getter reachable through mod.default, node's interop's fallback for a CommonJS module's whole exports object", () => {
    assert.equal(
      result.hasDefaultAutoUpdaterDescriptor,
      true,
      'expected mod.default (the CommonJS "exports" object node\'s interop always attaches, named-export detection aside) to carry an "autoUpdater" property descriptor'
    )
  })
})

describe("the loader's resolution, mod.autoUpdater ?? mod.default.autoUpdater", () => {
  it("resolves to a real updater, and records which branch supplied it", () => {
    assert.ok(
      result.resolvedFrom === "named" || result.resolvedFrom === "default",
      `mod.autoUpdater ?? mod.default.autoUpdater resolved to neither: electron-updater no longer exports autoUpdater by either name (resolvedFrom: ${result.resolvedFrom})`
    )
  })

  it("yields an object whose checkForUpdates, downloadUpdate, quitAndInstall and on are all functions", () => {
    for (const method of ["checkForUpdates", "downloadUpdate", "quitAndInstall", "on"] as const)
      assert.equal(result.resolvedMethods[method], true, `expected the autoUpdater resolved via "${result.resolvedFrom}" to have a callable ${method}`)
  })
})
