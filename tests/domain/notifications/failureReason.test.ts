import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"

import { REASON_NEEDLES, classifyFailure, failureReasonKey, type FailureReason } from "../../../src/domain/notifications/failureReason"

const LOCALES_DIR = join(import.meta.dirname, "..", "..", "..", "src", "renderer", "src", "locales")

const EVERY_REASON: readonly FailureReason[] = ["network", "no-space", "no-permission", "missing-file", "damaged-archive", "timed-out", "unsupported-platform", "unknown"]

function localeString(locale: string, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment], JSON.parse(readFileSync(join(LOCALES_DIR, locale + ".json"), "utf8")))
}

/**
 * Every token the mapper knows, against the cause it is allowed to claim and
 * the sentence a player ends up reading for it.
 *
 * Written out rather than derived from the module, because the point of the
 * table is that somebody decided what each token means. The first assertion
 * below holds it to the module, so a needle added without that decision fails
 * here rather than quietly telling a player the wrong thing.
 */
const EVERY_NEEDLE: ReadonlyArray<readonly [string, FailureReason]> = [
  ["installer-timed-out", "timed-out"],
  ["installer-missing", "missing-file"],
  ["not-windows", "unsupported-platform"],
  ["ENOSPC", "no-space"],
  ["EDQUOT", "no-space"],
  ["EACCES", "no-permission"],
  ["EPERM", "no-permission"],
  ["EROFS", "no-permission"],
  ["ENOTFOUND", "network"],
  ["EAI_AGAIN", "network"],
  ["ECONNREFUSED", "network"],
  ["ECONNRESET", "network"],
  ["ECONNABORTED", "network"],
  ["ENETUNREACH", "network"],
  ["EHOSTUNREACH", "network"],
  ["ERR_INTERNET_DISCONNECTED", "network"],
  ["ERR_NAME_NOT_RESOLVED", "network"],
  ["ERR_CONNECTION_REFUSED", "network"],
  ["getaddrinfo", "network"],
  ["ETIMEDOUT", "timed-out"],
  ["ESOCKETTIMEDOUT", "timed-out"],
  ["end of central directory", "damaged-archive"],
  ["invalid or unsupported zip", "damaged-archive"],
  ["invalid signature", "damaged-archive"]
]

/**
 * Messages a player can hit that name no single cause. Each one is emitted for
 * several different failures, so claiming one of them would send a player after
 * the wrong fix: the generic sentence and the log are the honest answer.
 */
const SAYS_NOTHING_ON_ITS_OWN = ["Extraction failed", "Extraction failed: read error", "EMFILE: too many open files", "EIO: i/o error, read", "ENOENT: no such file or directory"]

describe("the tokens the mapper knows", () => {
  it("claims exactly the causes the table allows, and no others", () => {
    assert.deepEqual(
      REASON_NEEDLES.map(([needle, reason]) => [needle, reason]),
      EVERY_NEEDLE.map(([needle, reason]) => [needle, reason])
    )
  })

  it("places every token on its cause, with a sentence behind it in en-US and fr-FR", () => {
    for (const [needle, reason] of EVERY_NEEDLE) {
      assert.equal(classifyFailure(new Error(`Task failed: ${needle}`)), reason, `${needle} should read as ${reason}`)
      for (const locale of ["en-US", "fr-FR"]) {
        const sentence = localeString(locale, failureReasonKey(reason))
        assert.equal(typeof sentence, "string", `${locale} has no sentence for ${needle}`)
        assert.ok((sentence as string).trim().length > 0, `${locale} has an empty sentence for ${needle}`)
      }
    }
  })

  it("leaves a message that names no single cause on the generic sentence", () => {
    for (const message of SAYS_NOTHING_ON_ITS_OWN) assert.equal(classifyFailure(new Error(message)), "unknown", `${message} names no single cause`)
  })

  /** The same generic sentence with real evidence appended is still placed by that evidence. */
  it("still places a generic failure that carries a code it recognises", () => {
    assert.equal(classifyFailure(new Error("Extraction failed: EACCES: permission denied")), "no-permission")
    assert.equal(classifyFailure(new Error("Extraction failed: ENOSPC: no space left on device")), "no-space")
    assert.equal(classifyFailure(new Error("Extraction failed: invalid signature")), "damaged-archive")
  })

  it("gives each cause its own sentence, so two tokens never read alike", () => {
    for (const locale of ["en-US", "fr-FR"]) {
      const sentences = EVERY_REASON.map((reason) => localeString(locale, failureReasonKey(reason)) as string)
      assert.equal(new Set(sentences).size, EVERY_REASON.length, `${locale} repeats a sentence across two causes`)
    }
  })
})

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

  it("does not guess that a generic extraction failure is a damaged archive", () => {
    assert.equal(classifyFailure(new Error("Extraction failed")), "unknown")
    assert.equal(classifyFailure(new Error("Extraction failed: EACCES")), "no-permission")
    assert.equal(classifyFailure(new Error("Extraction failed: ENOSPC")), "no-space")
  })

  it("does not call file descriptor exhaustion a permission problem", () => {
    assert.equal(classifyFailure(new Error("EMFILE: too many open files")), "unknown")
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
