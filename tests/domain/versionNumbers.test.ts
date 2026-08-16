import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { compareVersions } from "../../src/domain/versionNumbers"

describe("compareVersions", () => {
  it("orders by each numeric segment in turn", () => {
    assert.ok(compareVersions("1.2.3", "1.2.4") < 0)
    assert.ok(compareVersions("1.3.0", "1.2.9") > 0)
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0)
  })

  it("treats equal versions as equal", () => {
    assert.equal(compareVersions("1.20.4", "1.20.4"), 0)
  })

  it("treats a missing segment as zero, so 1.2 and 1.2.0 tie", () => {
    assert.equal(compareVersions("1.2", "1.2.0"), 0)
    assert.ok(compareVersions("1.2", "1.2.1") < 0)
    assert.ok(compareVersions("1.2.1", "1.2") > 0)
  })

  it("ignores the pre-release suffix rather than ranking it", () => {
    assert.equal(compareVersions("1.20.0-rc.1", "1.20.0"), 0)
    assert.equal(compareVersions("1.20.0-rc.1", "1.20.0-rc.9"), 0)
    assert.ok(compareVersions("1.20.0-rc.1", "1.19.8") > 0)
  })

  it("sorts a list newest first when used as a comparator", () => {
    const sorted = ["1.19.8", "1.20.4", "1.2.0", "1.20.10"].sort((a, b) => compareVersions(b, a))

    assert.deepEqual(sorted, ["1.20.10", "1.20.4", "1.19.8", "1.2.0"])
  })
})
