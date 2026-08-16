import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { canAutoUpdate } from "../../../src/domain/appUpdate/canAutoUpdate"

describe("canAutoUpdate", () => {
  it("allows win32", () => {
    assert.deepEqual(canAutoUpdate({ platform: "win32", env: {} }), { ok: true })
  })

  it("allows linux when the process runs from an AppImage", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: { APPIMAGE: "/opt/RiftLauncher.AppImage" } }), { ok: true })
  })

  it("refuses linux when APPIMAGE is absent, the deb case", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {} }), { ok: false, reason: "linux-not-appimage" })
  })

  it("refuses linux when APPIMAGE is empty", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: { APPIMAGE: "" } }), { ok: false, reason: "linux-not-appimage" })
  })

  it("refuses when UPDATE is the string false, on any platform", () => {
    assert.deepEqual(canAutoUpdate({ platform: "win32", env: { UPDATE: "false" } }), { ok: false, reason: "updates-disabled" })
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: { UPDATE: "false", APPIMAGE: "/opt/RiftLauncher.AppImage" } }), { ok: false, reason: "updates-disabled" })
  })

  it("ignores other UPDATE values", () => {
    assert.deepEqual(canAutoUpdate({ platform: "win32", env: { UPDATE: "true" } }), { ok: true })
    assert.deepEqual(canAutoUpdate({ platform: "win32", env: { UPDATE: "" } }), { ok: true })
  })

  it("refuses darwin, where nothing is published", () => {
    assert.deepEqual(canAutoUpdate({ platform: "darwin", env: {} }), { ok: false, reason: "unsupported-platform" })
  })

  it("refuses any other platform", () => {
    assert.deepEqual(canAutoUpdate({ platform: "freebsd", env: {} }), { ok: false, reason: "unsupported-platform" })
  })
})
