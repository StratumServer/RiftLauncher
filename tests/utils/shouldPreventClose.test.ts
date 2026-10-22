import assert from "node:assert/strict"
import { afterEach, describe, it, vi } from "vitest"

vi.mock("@src/utils/logManager", () => ({ logMessage: vi.fn() }))

import { isQuitGoingToBeVetoed, setCloseVetoWindowProbe, setShouldPreventClose } from "@src/utils/shouldPreventClose"

describe("isQuitGoingToBeVetoed", () => {
  afterEach(() => {
    setShouldPreventClose("remove", "task", "done")
    setCloseVetoWindowProbe(() => true)
  })

  it("is false while no close guard is held", () => {
    assert.equal(isQuitGoingToBeVetoed(), false)
  })

  it("is true while a guard is held and a window is there to veto the quit", () => {
    setShouldPreventClose("add", "task", "held")
    assert.equal(isQuitGoingToBeVetoed(), true)
  })

  it("is false while a guard is held but the window is gone, because nothing is left to veto the quit", () => {
    setShouldPreventClose("add", "task", "held")
    setCloseVetoWindowProbe(() => false)
    assert.equal(isQuitGoingToBeVetoed(), false)
  })
})
