import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

/**
 * The login handler cannot be imported here: it calls `ipcMain.handle` at module
 * load, which needs a running Electron main process. Its one property worth
 * guarding does not need it running, though, so this reads the source.
 *
 * The property: one LOGIN invocation makes at most the two requests the protocol
 * defines, one for each pass. Retrying a password against the account service is
 * how accounts get locked out, so a loop or a catch-and-try-again slipped into
 * that handler is a real incident, not a style problem. Counting is crude but it
 * fails loudly, and the alternative is trusting a reviewer to notice.
 *
 * The type system covers the other half: `interpretSecondPass` returns a verdict
 * union with no member asking for another request, so the domain cannot lead the
 * handler into a third pass either.
 */
const HANDLER_SOURCE = readFileSync(resolve(__dirname, "../../src/ipc/handlers/accountHandlers.ts"), "utf8")

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("the login handler cannot retry", () => {
  it("reaches the network through one wrapper and nothing else", () => {
    assert.equal(countOccurrences(HANDLER_SOURCE, "requestBoundedTextViaNode("), 1)
  })

  it("calls that wrapper exactly twice, one call site per protocol pass", () => {
    // One definition plus one call site per pass.
    assert.equal(countOccurrences(HANDLER_SOURCE, "requestLoginPass("), 3)
  })

  it("has no loop or retry construct around the passes", () => {
    for (const construct of ["while (", "for (", "do {", "setTimeout(", "setInterval("]) {
      assert.equal(countOccurrences(HANDLER_SOURCE, construct), 0, construct)
    }
  })
})

/**
 * `unreadable-response` used to fall out of `settle`'s switch as a thrown
 * Error, which the handler's own catch block (and, after that, the
 * renderer's) collapsed into the same generic failure as a wrong password.
 * That is the live bug this stage fixes: a real success payload that failed
 * to parse told the player their credentials were wrong. Source-grepped for
 * the same reason as the retry guard above, `settle` cannot be imported
 * without a running Electron main process.
 */
describe("the login handler never reports an unreadable success payload as bad credentials", () => {
  it("no longer throws out of the unreadable-response case", () => {
    const unreadableCase = HANDLER_SOURCE.slice(HANDLER_SOURCE.indexOf('case "unreadable-response"'), HANDLER_SOURCE.indexOf("}\n}", HANDLER_SOURCE.indexOf('case "unreadable-response"')))

    assert.equal(unreadableCase.includes("throw"), false, "the unreadable-response case still throws")
  })

  it("resolves unexpected-response for an unreadable-response verdict, and logs it", () => {
    assert.ok(HANDLER_SOURCE.includes("unexpectedResponseOutcome"), "settle should map unreadable-response through unexpectedResponseOutcome")
    assert.ok(HANDLER_SOURCE.includes('logMessage("error"'), "an unreadable success payload should be logged at error level")
  })
})
