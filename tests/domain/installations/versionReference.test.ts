import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { getInstallationVersionStatus } from "../../../src/domain/installations/versionReference"

const gameVersions = [
  { id: "vanilla", version: "1.22.7" },
  { id: "optimum", version: "1.22.7" },
  { id: "older", version: "1.21.0" }
]

describe("getInstallationVersionStatus", () => {
  it("distinguishes linked, same-number-but-unlinked, missing, and unset references", () => {
    assert.equal(getInstallationVersionStatus({ version: "1.22.7", gameVersionId: "vanilla" }, gameVersions), "linked")
    assert.equal(getInstallationVersionStatus({ version: "1.22.7", gameVersionId: "deleted" }, gameVersions), "unlinked")
    assert.equal(getInstallationVersionStatus({ version: "1.20.0", gameVersionId: null }, gameVersions), "missing")
    assert.equal(getInstallationVersionStatus({ version: "", gameVersionId: null }, gameVersions), "unset")
  })
})
