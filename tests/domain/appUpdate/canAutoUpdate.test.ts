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

  it("allows linux when the package-type marker reads deb, rpm or pacman", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {}, linuxPackageType: "deb" }), { ok: true })
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {}, linuxPackageType: "rpm" }), { ok: true })
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {}, linuxPackageType: "pacman" }), { ok: true })
  })

  it("prefers an AppImage run over a package-type marker left behind on the same host", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: { APPIMAGE: "/opt/RiftLauncher.AppImage" }, linuxPackageType: "deb" }), { ok: true })
  })

  it("refuses linux when APPIMAGE is absent and no supported marker was found, the flatpak case", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {} }), { ok: false, reason: "linux-unsupported-package" })
  })

  it("refuses linux when APPIMAGE is empty and no supported marker was found", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: { APPIMAGE: "" } }), { ok: false, reason: "linux-unsupported-package" })
  })

  it("refuses linux when the package-type marker names something with no Linux updater", () => {
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {}, linuxPackageType: "flatpak" }), { ok: false, reason: "linux-unsupported-package" })
    assert.deepEqual(canAutoUpdate({ platform: "linux", env: {}, linuxPackageType: "snap" }), { ok: false, reason: "linux-unsupported-package" })
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
