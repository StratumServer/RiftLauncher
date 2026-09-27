import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * Guards against sonarcloud silently vanishing from the checks list.
 *
 * sonarcloud gained `needs: [test-matrix]` so it can download that job's
 * coverage artifact instead of regenerating it. But GitHub Actions applies
 * an implicit `success()` to any `if:` that names none of
 * success()/always()/failure()/cancelled() when the job also has `needs`
 * (see the `test` job's own comment two jobs above, which relies on the
 * same rule). Without `always()`, a single failed or cancelled test-matrix
 * leg (say, a Windows-only flake) makes the whole sonarcloud job SKIP
 * outright, even though the ubuntu-latest leg already uploaded a usable
 * coverage-report artifact. On dev, sonarcloud had no `needs` and always
 * attempted its own independent test:coverage run regardless of anything
 * else in the workflow.
 */
describe("ci sonarcloud job", () => {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8")
  const sonarcloudBlock = /^ {2}sonarcloud:$([\s\S]*?)(?=^ {2}\S+:$)/m.exec(workflow)?.[1]

  it("still has a coverage artifact to read from test-matrix", () => {
    assert.ok(sonarcloudBlock, "sonarcloud job not found in ci.yml")
    assert.match(sonarcloudBlock!, /needs:\s*\[test-matrix\]/)
  })

  it("keeps attempting to run even when a test-matrix leg fails or is cancelled", () => {
    // A plain `if:` with `needs` defaults to success(): only always() (or an
    // explicit failure()/cancelled()) stops a red test-matrix leg from
    // skipping this job outright instead of letting continue-on-error do its
    // job of turning a real failure into an informational miss.
    const ifLine = /^ {4}if:\s*(.+)$/m.exec(sonarcloudBlock!)?.[1]
    assert.ok(ifLine, "sonarcloud job has no if: condition")
    assert.match(ifLine!, /always\(\)/)
  })
})
