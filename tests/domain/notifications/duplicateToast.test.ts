import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { duplicateToastId, type RepeatableToast } from "../../../src/domain/notifications/duplicateToast"

function toast(id: string, body: string, type = "info", hasActions = false): RepeatableToast {
  return { id, body, type, hasActions }
}

describe("duplicateToastId", () => {
  it("finds the banner a new message would only repeat", () => {
    const shown = [toast("a", "Disabled Prospect Together"), toast("b", "Disabled Caminus")]
    assert.equal(duplicateToastId(shown, { body: "Disabled Caminus", type: "info", hasActions: false }), "b")
  })

  it("folds into one still waiting behind the stack, not only into one on screen", () => {
    const shown = [toast("onscreen", "Something else"), toast("waiting", "Disabled Caminus")]
    assert.equal(duplicateToastId(shown, { body: "Disabled Caminus", type: "info", hasActions: false }), "waiting")
  })

  it("takes the first match, so a message folds into the one that has been up longest", () => {
    const shown = [toast("first", "Disabled Caminus"), toast("second", "Disabled Caminus")]
    assert.equal(duplicateToastId(shown, { body: "Disabled Caminus", type: "info", hasActions: false }), "first")
  })

  /**
   * Two sentences that differ only in an interpolated value are two different messages: the
   * body a call site hands over is what its key and values produced, so comparing bodies is
   * comparing key and values.
   */
  it("keeps a message whose interpolated value differs as a message of its own", () => {
    const shown = [toast("a", "Disabled Caminus")]
    assert.equal(duplicateToastId(shown, { body: "Disabled Prospect Together", type: "info", hasActions: false }), undefined)
  })

  it("keeps the same sentence at a different severity apart, since they do not read the same", () => {
    const shown = [toast("a", "Could not reach the server", "error")]
    assert.equal(duplicateToastId(shown, { body: "Could not reach the server", type: "warning", hasActions: false }), undefined)
  })

  /** Two questions that read alike are still two answers owed, and folding one drops it silently. */
  it("never folds a question into anything, nor anything into a question", () => {
    const question = toast("q", "Install the update?", "info", true)
    assert.equal(duplicateToastId([question], { body: "Install the update?", type: "info", hasActions: true }), undefined)
    assert.equal(duplicateToastId([question], { body: "Install the update?", type: "info", hasActions: false }), undefined)
    assert.equal(duplicateToastId([toast("plain", "Install the update?")], { body: "Install the update?", type: "info", hasActions: true }), undefined)
  })

  it("has nothing to fold into when nothing is up", () => {
    assert.equal(duplicateToastId([], { body: "Disabled Caminus", type: "info", hasActions: false }), undefined)
  })
})
