import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { BULK_CLEAR_UNDO_DURATION, survivesBulkClear, taskSurvivesBulkClear } from "../../../src/domain/notifications/bulkClear"

describe("survivesBulkClear", () => {
  it("takes an ordinary record, read or not", () => {
    assert.equal(survivesBulkClear({ onScreen: false, awaitsAnswer: false }), false)
  })

  /** A banner on screen is being read right now, and tidying must not pull it out mid-sentence. */
  it("leaves the banner on screen where it is", () => {
    assert.equal(survivesBulkClear({ onScreen: true, awaitsAnswer: false }), true)
  })

  /** The same exception "Clear read" already makes: an unanswered question is still owed an answer. */
  it("leaves a question that has not been answered", () => {
    assert.equal(survivesBulkClear({ onScreen: false, awaitsAnswer: true }), true)
  })

  it("leaves a question on screen, which is both reasons at once", () => {
    assert.equal(survivesBulkClear({ onScreen: true, awaitsAnswer: true }), true)
  })
})

describe("taskSurvivesBulkClear", () => {
  it("takes the rows that are only leftovers", () => {
    assert.equal(taskSurvivesBulkClear("completed"), false)
    assert.equal(taskSurvivesBulkClear("failed"), false)
  })

  it("leaves work that is still running, because there is no way to put it back", () => {
    assert.equal(taskSurvivesBulkClear("pending"), true)
    assert.equal(taskSurvivesBulkClear("in-progress"), true)
  })
})

describe("BULK_CLEAR_UNDO_DURATION", () => {
  it("gives the undo long enough to be noticed and pressed, and not so long it outstays the panel", () => {
    assert.equal(BULK_CLEAR_UNDO_DURATION, 5_000)
  })
})
