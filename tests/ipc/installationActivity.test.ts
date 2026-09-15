import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { clearInstallationPlaying, isInstallationPlaying, markInstallationPlaying, tryAcquireInstallationOperation } from "@src/ipc/installationActivity"

describe("installation activity", () => {
  it("keeps an installation playing until every concurrent launch ends", () => {
    assert.equal(markInstallationPlaying("install"), true)
    assert.equal(markInstallationPlaying("install"), true)
    assert.equal(isInstallationPlaying("install"), true)

    clearInstallationPlaying("install")
    assert.equal(isInstallationPlaying("install"), true)
    clearInstallationPlaying("install")
    assert.equal(isInstallationPlaying("install"), false)
  })

  it("excludes world operations while playing and excludes launches while reserved", () => {
    assert.equal(markInstallationPlaying("install"), true)
    assert.deepEqual(tryAcquireInstallationOperation(["install"]), { ok: false, reason: "playing" })
    clearInstallationPlaying("install")

    const lease = tryAcquireInstallationOperation(["install"])
    assert.equal(lease.ok, true)
    assert.equal(markInstallationPlaying("install"), false)
    assert.deepEqual(tryAcquireInstallationOperation(["install"]), { ok: false, reason: "busy" })
    if (lease.ok) lease.release()
    assert.equal(markInstallationPlaying("install"), true)
    clearInstallationPlaying("install")
  })
})
