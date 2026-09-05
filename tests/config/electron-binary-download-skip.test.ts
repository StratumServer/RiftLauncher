import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Guards the ELECTRON_SKIP_BINARY_DOWNLOAD opt-out added for issue #377.
 *
 * The typecheck and lint jobs run tsc, eslint and prettier and never launch
 * Electron, yet `npm ci` used to fetch the platform binary for them anyway.
 * One hiccup on the download mirror then failed a job whose only work is
 * static analysis. Nothing downstream honours the variable (electron 44's
 * install.js dropped the check, @electron/get 5 never had it), so the guard
 * lives in scripts/fix-native-deps.js and has to stay there.
 *
 * The workflow is read as text on purpose, matching the other config guards
 * here: js-yaml is only a transitive dependency of electron-updater.
 */
describe("electron binary download opt-out", () => {
  const repoRoot = resolve(__dirname, "../..")

  it("makes fix-native-deps.js skip the download when the variable is set", () => {
    const result = spawnSync(process.execPath, [resolve(repoRoot, "scripts/fix-native-deps.js")], {
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
      encoding: "utf8"
    })

    assert.equal(result.status, 0)
    assert.match(result.stdout, /ELECTRON_SKIP_BINARY_DOWNLOAD is set, skipping the electron binary download/)
    assert.doesNotMatch(result.stdout, /running node_modules\/electron\/install\.js/)
  })

  it("sets the variable on the typecheck and lint jobs only", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")
    // Job blocks start at two-space indentation and run to the next one.
    const jobs = new Map<string, string>()
    let current: string | undefined
    for (const line of workflow.split("\n")) {
      const name = /^ {2}(\S+):$/.exec(line)?.[1]
      if (name !== undefined) {
        current = name
        jobs.set(name, "")
        continue
      }
      if (current !== undefined) jobs.set(current, `${jobs.get(current)}${line}\n`)
    }

    const withSkip = [...jobs]
      .filter(([, body]) => body.includes("ELECTRON_SKIP_BINARY_DOWNLOAD"))
      .map(([name]) => name)
      .sort()
    assert.deepEqual(withSkip, ["lint", "typecheck"])
  })

  it("keeps the job names branch protection requires", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")
    for (const job of ["typecheck", "lint", "test", "build"]) {
      assert.match(workflow, new RegExp(`^ {2}${job}:$`, "m"))
    }
  })
})
