import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { gameExecutableCandidates, toGameOs } from "../../../src/domain/versions/gameExecutable"

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

describe("gameExecutableCandidates", () => {
  it("expects the Windows executable and nothing else on Windows, run directly", () => {
    assert.deepEqual(gameExecutableCandidates("win32"), [{ fileName: "Vintagestory.exe", launchMode: "direct" }])
  })

  it("prefers the native Linux launcher over the mono fallback", () => {
    assert.deepEqual(gameExecutableCandidates("linux"), [
      { fileName: "Vintagestory", launchMode: "direct" },
      { fileName: "Vintagestory.exe", launchMode: "mono" }
    ])
  })

  it("has no candidates on macOS, which the launcher cannot run yet", () => {
    assert.deepEqual(gameExecutableCandidates("darwin"), [])
  })
})
