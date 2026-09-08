import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { installGuideUrl, pickPlayOutcomeNotification } from "../../src/renderer/src/utils/playOutcomeNotifications"

describe("pickPlayOutcomeNotification on a successful exit", () => {
  it("shows nothing when the game exited with code 0", () => {
    assert.equal(pickPlayOutcomeNotification({ ok: true, exitCode: 0 }, "linux"), null)
  })

  it("shows nothing when the game exited with no code at all", () => {
    assert.equal(pickPlayOutcomeNotification({ ok: true, exitCode: null }, "linux"), null)
  })

  it("warns when the game exited with a non-zero code", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: true, exitCode: 1 }, "linux"), { key: "notifications.body.gameExitedWithErrors" })
  })
})

describe("pickPlayOutcomeNotification on a refusal", () => {
  it("keys unsupported-platform to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "unsupported-platform" }, "linux"), { key: "notifications.body.gameLaunchUnsupportedPlatform" })
  })

  it("keys no-executable to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "no-executable" }, "linux"), { key: "notifications.body.gameLaunchNoExecutable" })
  })

  it("keys session-write-failed to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "session-write-failed" }, "linux"), { key: "notifications.body.gameLaunchSessionWriteFailed" })
  })

  it("keys invalid-request to its own sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "invalid-request" }, "linux"), { key: "notifications.body.gameLaunchInvalidEnvironment" })
  })

  it("keys missing-dotnet to its own sentence, with the guide for the player's OS as an action", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "missing-dotnet" }, "win32"), {
      key: "notifications.body.gameLaunchMissingDotnet",
      link: { url: "https://riftlauncher.stratumvs.dev/docs/get-started/installation/windows", labelKey: "notifications.actions.openInstallGuide" }
    })
    assert.equal(pickPlayOutcomeNotification({ ok: false, reason: "missing-dotnet" }, "linux")?.link?.url, "https://riftlauncher.stratumvs.dev/docs/get-started/installation/linux")
  })

  /**
   * Zaldaryon's catch on the first cut: the link always went to the Linux page, so a Windows
   * player was sent to instructions for another OS. macOS has no .NET section of its own and
   * the OS is empty until the async read resolves, so both get the index rather than a wrong page.
   */
  it("sends an OS without a .NET page of its own, or one not read yet, to the install index", () => {
    assert.equal(installGuideUrl("darwin"), "https://riftlauncher.stratumvs.dev/docs/get-started/installation/")
    assert.equal(installGuideUrl(""), "https://riftlauncher.stratumvs.dev/docs/get-started/installation/")
    assert.notEqual(installGuideUrl("win32"), installGuideUrl("linux"))
  })

  it("gives every other reason a bare message, so only missing-dotnet grows an action", () => {
    const reasons: GameExecutionFailureReason[] = ["unsupported-platform", "no-executable", "session-write-failed", "invalid-request", "launch-failed"]
    for (const reason of reasons) assert.equal(pickPlayOutcomeNotification({ ok: false, reason }, "linux")?.link, undefined)
  })

  it("keys launch-failed to the generic executing-game sentence", () => {
    assert.deepEqual(pickPlayOutcomeNotification({ ok: false, reason: "launch-failed" }, "linux"), { key: "notifications.body.errorExecutingGame" })
  })
})
