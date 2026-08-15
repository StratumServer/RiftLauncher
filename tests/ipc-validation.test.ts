import assert from "node:assert/strict"
import { resolve } from "node:path"
import { describe, it } from "vitest"

import { assertAllowedApiUrl, assertAllowedBrowserUrl, assertInteger, assertSafeFileName, assertSafeTaskId, isArchiveSymlink, isSafeArchiveEntry, resolveContainedPath } from "../src/ipc/validation"
import { redactSensitiveText } from "../src/utils/logManager"

describe("IPC boundary validators", () => {
  it("accepts only approved API and browser URLs", () => {
    assert.equal(assertAllowedApiUrl("https://mods.vintagestory.at/api/tags").hostname, "mods.vintagestory.at")
    assert.equal(assertAllowedApiUrl("https://auth3.vintagestory.at/v2/gamelogin").pathname, "/v2/gamelogin")
    assert.equal(assertAllowedBrowserUrl("https://github.com/StratumServer/RiftLauncher/issues").hostname, "github.com")
    assert.equal(assertAllowedBrowserUrl("https://ko-fi.com/zaldaryon").pathname, "/zaldaryon")

    assert.throws(() => assertAllowedApiUrl("http://mods.vintagestory.at/api/tags"), /Invalid URL/)
    assert.throws(() => assertAllowedApiUrl("https://example.com/api/tags"), /URL is not allowed/)
    assert.throws(() => assertAllowedBrowserUrl("javascript:alert(1)"), /Invalid URL/)
  })

  it("confines protocol paths to their intended root", () => {
    assert.equal(resolveContainedPath("/tmp/icons", "/nested/icon.png"), resolve("/tmp/icons", "nested", "icon.png"))
    assert.equal(resolveContainedPath("/tmp/icons", "/%2e%2e/secret.png"), null)
    assert.equal(resolveContainedPath("/tmp/icons", "/nested/%2e%2e/secret.png"), null)
  })

  it("rejects unsafe archive entries and symlinks", () => {
    assert.equal(isSafeArchiveEntry("mods/modinfo.json"), true)
    assert.equal(isSafeArchiveEntry("/etc/passwd"), false)
    assert.equal(isSafeArchiveEntry("mods/../../outside.txt"), false)
    assert.equal(isSafeArchiveEntry("C:\\Windows\\system32"), false)
    assert.equal(isArchiveSymlink(0o120777 << 16), true)
    assert.equal(isArchiveSymlink(0o100644 << 16), false)
  })

  it("bounds task IDs, filenames, and numeric inputs", () => {
    assert.equal(assertSafeTaskId("download:123"), "download:123")
    assert.equal(assertSafeFileName("archive.zip"), "archive.zip")
    assert.equal(assertInteger(4, "compression level", 0, 9), 4)
    assert.throws(() => assertSafeTaskId("../escape"), /Invalid task id/)
    assert.throws(() => assertSafeFileName("../escape"), /Invalid file name/)
    assert.throws(() => assertInteger(10, "compression level", 0, 9), /Invalid compression level/)
  })

  it("redacts credentials and absolute paths from diagnostics", () => {
    const redacted = redactSensitiveText("password=secret token=abc123 /home/user/private/config.json")
    assert.equal(redacted.includes("secret"), false)
    assert.equal(redacted.includes("abc123"), false)
    assert.equal(redacted.includes("/home/user"), false)
    assert.equal(redacted.includes("[REDACTED]"), true)
    assert.equal(redacted.includes("[PATH]"), true)
  })
})
