import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { afterAll, describe, it } from "vitest"

/**
 * Two rules stop the architecture from rotting quietly: no-restricted-imports keeps
 * src/domain free of Electron and Node, and rules-of-hooks keeps React hooks out of
 * conditionals. Both moved from ESLint to oxlint when oxlint became the first pass,
 * and a rule that moves between two linters is a rule that can fall between them:
 * switched off on one side, never switched on on the other, and nobody notices
 * because the repository has no violation to miss.
 *
 * So this runs both linters over a seeded violation of each and asserts the pair
 * reports it, and that reporting it makes one of them exit non-zero. Which linter
 * does is left open on purpose: the guard is that the command CI runs says no, not
 * that a particular tool does. Printing the rule name is not enough on its own,
 * because a guard demoted to a warning still prints it while `npm run lint:ci`
 * stays at exit 0.
 *
 * The fixtures live under tests/fixtures/lint (ignored by both configs) and are
 * copied into the tree the configs actually target, because the src/domain guard is
 * scoped by path: a fixture linted where it sits would never match the pattern.
 */

const root = resolve(__dirname, "../..")
const seeded = [
  {
    guard: "no-restricted-imports",
    fixture: "tests/fixtures/lint/domain-imports-electron.ts",
    // Inside src/domain so the guard's own file pattern matches the copy.
    target: "src/domain/__lint-guard-fixture.ts"
  },
  {
    guard: "rules-of-hooks",
    fixture: "tests/fixtures/lint/conditional-hook.tsx",
    target: "src/renderer/src/__lint-guard-fixture.tsx"
  }
]

const targets = seeded.map((entry) => resolve(root, entry.target))

// The .bin shims are .cmd files on Windows, which execFileSync cannot spawn without a
// shell; the packages' own entry points are plain Node scripts everywhere.
function lint(bin: string, args: string[]): { output: string; failed: boolean } {
  try {
    const output = execFileSync(process.execPath, [resolve(root, bin), ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { output, failed: false }
  } catch (error) {
    // Both linters exit non-zero when they find an error, which is the point.
    const failure = error as { stdout?: string; stderr?: string }
    return { output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, failed: true }
  }
}

describe("lint guards", () => {
  afterAll(() => {
    for (const target of targets) rmSync(target, { force: true })
  })

  // 0.8 s on a developer machine, and the work is two short-lived processes, not a
  // long-running test. The generous ceiling is for the Windows runner, where this
  // starts two Node processes while the rest of the suite is still running beside
  // it and the default 5 s was not enough: the same headroom, for the same reason,
  // that vitest.config.ts already gives the renderer-dom project.
  it("reports a src/domain file importing electron and a hook called conditionally", () => {
    for (const entry of seeded) copyFileSync(resolve(root, entry.fixture), resolve(root, entry.target))

    // One fixture at a time, so the non-zero exit belongs to the guard under test
    // rather than to whichever of the two happens to still be an error.
    for (const entry of seeded) {
      const runs = [lint("node_modules/oxlint/bin/oxlint", [entry.target]), lint("node_modules/eslint/bin/eslint.js", [entry.target])]
      const output = runs.map((run) => run.output).join("")

      assert.ok(output.includes(entry.guard), `${entry.guard} fired for no linter on ${entry.target}. Full output:\n${output}`)
      assert.ok(
        runs.some((run) => run.failed),
        `${entry.guard} was reported on ${entry.target} but neither linter failed, so npm run lint:ci would stay green. Full output:\n${output}`
      )
    }
  }, 30_000)
})
