import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { expectedGameExecutables, toGameOs } from "../../../src/domain/versions/gameExecutable"

describe("toGameOs", () => {
  it("keeps the two platforms the launcher treats specially", () => {
    assert.equal(toGameOs("win32"), "win32")
    assert.equal(toGameOs("darwin"), "darwin")
  })

  it("treats everything else as linux, like the download picker always has", () => {
    assert.equal(toGameOs("linux"), "linux")
    assert.equal(toGameOs("freebsd"), "linux")
    assert.equal(toGameOs("openbsd"), "linux")
    assert.equal(toGameOs(""), "linux")
  })
})

describe("expectedGameExecutables", () => {
  it("expects the Windows executable and nothing else on Windows", () => {
    assert.deepEqual(expectedGameExecutables("win32"), ["Vintagestory.exe"])
  })

  it("accepts either the native launcher or the mono executable on Linux", () => {
    assert.deepEqual(expectedGameExecutables("linux"), ["Vintagestory", "Vintagestory.exe"])
  })

  it("prefers the native Linux launcher over the mono fallback", () => {
    const [first] = expectedGameExecutables("linux")

    assert.equal(first, "Vintagestory")
  })

  it("has no expectation on macOS, which the launcher cannot run yet", () => {
    assert.deepEqual(expectedGameExecutables("darwin"), [])
  })
})
