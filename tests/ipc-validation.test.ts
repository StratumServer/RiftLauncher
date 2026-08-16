import assert from "node:assert/strict"
import { resolve } from "node:path"
import { describe, it } from "vitest"

import {
  assertAllowedApiUrl,
  assertAllowedBrowserUrl,
  assertInteger,
  assertSafeFileName,
  assertSafeTaskId,
  isArchiveSymlink,
  isPathGranted,
  isPathWithin,
  isRestoreWorkspaceName,
  isSafeArchiveEntry,
  isSafeTarEntryType,
  isTarGzName,
  resolveContainedPath
} from "../src/ipc/validation"
import { redactSensitiveText } from "../src/utils/logManager"

describe("IPC boundary validators", () => {
  it("accepts only approved API and browser URLs", () => {
    assert.equal(assertAllowedApiUrl("https://mods.vintagestory.at/api/tags").hostname, "mods.vintagestory.at")
    assert.equal(assertAllowedApiUrl("https://auth3.vintagestory.at/v2/gamelogin").pathname, "/v2/gamelogin")
    assert.equal(assertAllowedBrowserUrl("https://github.com/StratumServer/RiftLauncher/issues").hostname, "github.com")
    assert.equal(assertAllowedBrowserUrl("https://discord.gg/vQm6z2urZs").pathname, "/vQm6z2urZs")

    assert.throws(() => assertAllowedApiUrl("http://mods.vintagestory.at/api/tags"), /Invalid URL/)
    assert.throws(() => assertAllowedApiUrl("https://example.com/api/tags"), /URL is not allowed/)
    assert.throws(() => assertAllowedBrowserUrl("javascript:alert(1)"), /Invalid URL/)
    assert.throws(() => assertAllowedBrowserUrl("https://discord.gg/RtWpYBRRUz"), /URL is not allowed/)
    assert.throws(() => assertAllowedBrowserUrl("https://ko-fi.com/zaldaryon"), /URL is not allowed/)
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

  it("recognises the gzipped tars the game ships, whatever the case", () => {
    assert.equal(isTarGzName("vs_client_linux-x64_1.22.6.tar.gz"), true)
    assert.equal(isTarGzName("vs_archive_1.9.14.TAR.GZ"), true)
    assert.equal(isTarGzName("build.tgz"), true)

    assert.equal(isTarGzName("carrycapacity-1.7.0.zip"), false)
    assert.equal(isTarGzName("vs_install_win-x64_1.22.6.exe"), false)
    assert.equal(isTarGzName("payload.tar"), false)
    assert.equal(isTarGzName("tar.gz.zip"), false)
    assert.equal(isTarGzName(undefined), false)
  })

  it("lets only plain files and folders through the tar reader", () => {
    assert.equal(isSafeTarEntryType("File"), true)
    assert.equal(isSafeTarEntryType("Directory"), true)
    assert.equal(isSafeTarEntryType("OldFile"), true)

    assert.equal(isSafeTarEntryType("SymbolicLink"), false)
    assert.equal(isSafeTarEntryType("Link"), false)
    assert.equal(isSafeTarEntryType("CharacterDevice"), false)
    assert.equal(isSafeTarEntryType(undefined), false)
  })

  it("bounds task IDs, filenames, and numeric inputs", () => {
    assert.equal(assertSafeTaskId("download:123"), "download:123")
    assert.equal(assertSafeFileName("archive.zip"), "archive.zip")
    assert.equal(assertSafeFileName("vs_client_linux-x64_1.22.6.tar.gz"), "vs_client_linux-x64_1.22.6.tar.gz")
    assert.equal(assertSafeFileName("vs_install_win-x64_1.22.6.exe"), "vs_install_win-x64_1.22.6.exe")
    assert.equal(assertSafeFileName("carrycapacity-1.7.0.zip"), "carrycapacity-1.7.0.zip")
    assert.equal(assertInteger(4, "compression level", 0, 9), 4)
    assert.throws(() => assertSafeTaskId("../escape"), /Invalid task id/)
    assert.throws(() => assertSafeFileName("../escape"), /Invalid file name/)
    assert.throws(() => assertInteger(10, "compression level", 0, 9), /Invalid compression level/)
  })

  it("admits only the two generated restore workspace names beside an installation", () => {
    const token = "0f8fad5b-d9cb-469f-a165-70867728950e"

    assert.equal(isRestoreWorkspaceName("My Install", `My Install-restoring-${token}`), true)
    assert.equal(isRestoreWorkspaceName("My Install", `My Install-replaced-${token}`), true)

    assert.equal(isRestoreWorkspaceName("My Install", "My Install"), false)
    assert.equal(isRestoreWorkspaceName("My Install", "Other Install-restoring-" + token), false)
    assert.equal(isRestoreWorkspaceName("My Install", "My Install-restoring-notauuid"), false)
    assert.equal(isRestoreWorkspaceName("My Install", `My Install-restoring-${token}-extra`), false)
    assert.equal(isRestoreWorkspaceName("My Install", `My Install-removed-${token}`), false)
    assert.equal(isRestoreWorkspaceName("My Install", `My Install Saves-restoring-${token}`), false)
    assert.equal(isRestoreWorkspaceName("", `-restoring-${token}`), false)
  })

  it("contains a path to its root, and never to a sibling or a parent", () => {
    const root = resolve("/games/Installations")

    assert.equal(isPathWithin(root, root), true)
    assert.equal(isPathWithin(root, resolve(root, "Main/Mods/amod.zip")), true)
    assert.equal(isPathWithin(root, root, false), false)

    assert.equal(isPathWithin(root, resolve("/games")), false)
    assert.equal(isPathWithin(root, resolve("/games/InstallationsBackup")), false)
    assert.equal(isPathWithin(root, resolve(root, "../escape")), false)
  })

  it("reaches under a folder grant and stops at the path of a file grant", () => {
    const folder = resolve("/games/Installations")
    const archive = resolve("/archives/Main_2026.zip")
    const grants = [
      { path: folder, descendants: true },
      { path: archive, descendants: false }
    ]

    assert.equal(isPathGranted(grants, folder), true)
    assert.equal(isPathGranted(grants, resolve(folder, "Main")), true)
    assert.equal(isPathGranted(grants, archive), true)

    assert.equal(isPathGranted(grants, resolve(archive, "payload")), false)
    assert.equal(isPathGranted(grants, resolve("/archives")), false)
    assert.equal(isPathGranted([], folder), false)
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
