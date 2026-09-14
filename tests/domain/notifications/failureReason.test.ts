import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { classifyFailure, failureReasonKey, type FailureReason } from "../../../src/domain/notifications/failureReason"

const LOCALES_DIR = join(import.meta.dirname, "..", "..", "..", "src", "renderer", "src", "locales")

const EVERY_REASON: readonly FailureReason[] = ["network", "no-space", "no-permission", "missing-file", "damaged-archive", "timed-out", "unsupported-platform", "unknown"]

function localeString(locale: string, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment], JSON.parse(readFileSync(join(LOCALES_DIR, locale + ".json"), "utf8")))
}

describe("classifyFailure", () => {
  it("reads a refused connection as the network, through the wrapper an IPC call puts around it", () => {
    assert.equal(classifyFailure(new Error("Error invoking remote method 'downloadOnPath': Error: connect ECONNREFUSED 127.0.0.1:443")), "network")
  })

  it("reads a name that would not resolve as the network too", () => {
    assert.equal(classifyFailure(new Error("getaddrinfo ENOTFOUND mods.vintagestory.at")), "network")
  })

  it("reads a full drive as a full drive, not as a generic failure", () => {
    assert.equal(classifyFailure(new Error("ENOSPC: no space left on device, write")), "no-space")
  })

  it("reads a refused write as a permission problem", () => {
    assert.equal(classifyFailure(new Error("EACCES: permission denied, open '/opt/riftlauncher/data'")), "no-permission")
  })

  it("reads a missing file as a missing file", () => {
    assert.equal(classifyFailure(new Error("Installation failed: installer-missing")), "missing-file")
  })

  it("reads an archive that would not open as a damaged archive", () => {
    assert.equal(classifyFailure(new Error("Extraction failed")), "damaged-archive")
  })

  /** The installer's own timeout has to win over the generic one, or a killed run reads as a network stall. */
  it("reads an installer that was killed for running long as a timeout", () => {
    assert.equal(classifyFailure(new Error("Installation failed: installer-timed-out")), "timed-out")
  })

  it("reads an installer that cannot run on this platform as exactly that", () => {
    assert.equal(classifyFailure(new Error("Installation failed: not-windows")), "unsupported-platform")
  })

  it("falls back to unknown rather than guessing, on an error it cannot place", () => {
    assert.equal(classifyFailure(new Error("the transfer died")), "unknown")
    assert.equal(classifyFailure(undefined), "unknown")
    assert.equal(classifyFailure(null), "unknown")
    assert.equal(classifyFailure({ nothing: true }), "unknown")
  })

  it("takes a bare string as the message, since a rejected IPC call can hand one over", () => {
    assert.equal(classifyFailure("ENOSPC"), "no-space")
  })

  /**
   * The rule that matters most here, and the reason this module exists: whatever a player ends
   * up reading is picked by a token, so no path, host name or library sentence can reach a row.
   */
  it("never lets any of the error's own words out, whatever it was handed", () => {
    const leaky = new Error("EACCES: permission denied, open '/home/someone/Vintage Story/mods/secret.zip'")
    assert.ok(EVERY_REASON.includes(classifyFailure(leaky)))
    assert.ok(!failureReasonKey(classifyFailure(leaky)).includes("someone"))
  })
})

describe("failureReasonKey", () => {
  it("names a key under the Activity Center's own namespace for every reason", () => {
    for (const reason of EVERY_REASON) assert.equal(failureReasonKey(reason), "components.activityCenter.failureReasons." + reason)
  })

  it("falls back to the unknown sentence for a record that carries no reason at all", () => {
    assert.equal(failureReasonKey(undefined), "components.activityCenter.failureReasons.unknown")
  })

  it("has a real sentence behind it in en-US and in fr-FR", () => {
    for (const reason of EVERY_REASON) {
      for (const locale of ["en-US", "fr-FR"]) {
        const sentence = localeString(locale, failureReasonKey(reason))
        assert.equal(typeof sentence, "string", `${locale} has no string for ${reason}`)
        assert.ok((sentence as string).length > 0, `${locale} has an empty string for ${reason}`)
      }
    }
  })
})
