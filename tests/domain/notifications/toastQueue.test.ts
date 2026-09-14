import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  BACKLOG_TOAST_DURATION,
  MAX_CENTER_HISTORY,
  MAX_TOAST_BACKLOG,
  MAX_VISIBLE_TOASTS,
  backlogToastDuration,
  capNotificationRecords,
  waitingBehindStack
} from "../../../src/domain/notifications/toastQueue"

/** A record shaped the way the provider's records are, reduced to what these two rules read. */
function record(id: string, toastOnly: boolean): { id: string; toastOnly: boolean } {
  return { id, toastOnly }
}

const isToastOnly = (entry: { toastOnly: boolean }): boolean => entry.toastOnly

function records(centerCount: number, toastCount: number): Array<{ id: string; toastOnly: boolean }> {
  return [...Array.from({ length: centerCount }, (_, index) => record("c" + index, false)), ...Array.from({ length: toastCount }, (_, index) => record("t" + index, true))]
}

describe("backlogToastDuration", () => {
  it("leaves a toast with an empty queue behind it its whole turn", () => {
    assert.equal(backlogToastDuration(8_000, 0), 8_000)
  })

  it("shortens a toast that has something waiting behind it", () => {
    assert.equal(backlogToastDuration(8_000, 1), BACKLOG_TOAST_DURATION)
  })

  it("never lengthens a toast that was already shorter than the backlog turn", () => {
    assert.equal(backlogToastDuration(1_200, 3), 1_200)
  })

  it("keeps a question open whatever is waiting, because the player still has to answer it", () => {
    assert.equal(backlogToastDuration(null, 9), null)
  })

  it("treats a negative waiting count as nothing waiting rather than shortening on it", () => {
    assert.equal(backlogToastDuration(4_500, -1), 4_500)
  })

  it("shortens what is left of a banner already on screen to the backlog turn", () => {
    assert.equal(backlogToastDuration(8_000, 1, 400), BACKLOG_TOAST_DURATION)
  })

  it("never lengthens a banner that has less left than the backlog turn", () => {
    assert.equal(backlogToastDuration(8_000, 1, 7_500), 500)
  })

  it("never returns a negative turn for a banner that has already outstayed it", () => {
    assert.equal(backlogToastDuration(4_500, 2, 6_000), 0)
  })

  it("still keeps a question open however much of a notional turn has elapsed", () => {
    assert.equal(backlogToastDuration(null, 3, 5_000), null)
  })

  /**
   * The measured case from the audit. Five errors fired in one tick used to take 40 s to drain
   * with the last one appearing 32 s in; under these rules the four behind the first serve
   * BACKLOG_TOAST_DURATION each and the last of them is on screen inside ten seconds.
   */
  it("puts the last of a five error burst on screen in under ten seconds", () => {
    let elapsed = 0
    for (let waiting = 4; waiting > 0; waiting -= 1) elapsed += backlogToastDuration(8_000, waiting) ?? 0
    assert.ok(elapsed < 10_000, `the last of the burst waits ${elapsed} ms`)
  })
})

describe("waitingBehindStack", () => {
  it("counts nothing as waiting while the stack still has a free place for it", () => {
    assert.equal(waitingBehindStack(1, 0), 0)
    assert.equal(waitingBehindStack(1, MAX_VISIBLE_TOASTS - 1), 0)
  })

  it("counts nothing as waiting when the queue exactly fills the free places", () => {
    assert.equal(waitingBehindStack(MAX_VISIBLE_TOASTS, 0), 0)
  })

  it("counts only what is still queued once the stack is full", () => {
    assert.equal(waitingBehindStack(MAX_VISIBLE_TOASTS + 2, 0), 2)
    assert.equal(waitingBehindStack(2, MAX_VISIBLE_TOASTS), 2)
  })

  it("never reads a stack somehow over its own limit as negative waiting", () => {
    assert.equal(waitingBehindStack(0, MAX_VISIBLE_TOASTS + 1), 0)
    assert.equal(waitingBehindStack(3, MAX_VISIBLE_TOASTS + 1), 3)
  })
})

describe("capNotificationRecords", () => {
  it("returns the very same array when both budgets have room, so React can bail out", () => {
    const kept = records(3, 2)
    assert.equal(capNotificationRecords(kept, isToastOnly), kept)
  })

  it("caps center history at fifty and drops the oldest first", () => {
    const capped = capNotificationRecords(records(MAX_CENTER_HISTORY + 3, 0), isToastOnly)
    assert.equal(capped.length, MAX_CENTER_HISTORY)
    assert.equal(capped[0]?.id, "c3")
  })

  it("with nothing on screen keeps a full backlog plus the whole stack about to fill", () => {
    const capped = capNotificationRecords(records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 3), isToastOnly)
    assert.equal(capped.length, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
    assert.equal(capped[0]?.id, "t3")
  })

  /**
   * The burst that lands on an empty overlay. Every free place in the stack is filled on the
   * next render, so the cap has to leave room for all of them: budgeting for one meant a burst
   * of three had its second and third dropped before either ever reached the screen.
   */
  it("keeps a burst that exactly fills the stack, with nothing on screen yet", () => {
    const burst = records(0, MAX_VISIBLE_TOASTS)
    assert.equal(capNotificationRecords(burst, isToastOnly), burst)
  })

  it("gives back a place in the toast budget for every banner already up", () => {
    const isPinned = (entry: { id: string }): boolean => entry.id === "t0" || entry.id === "t1"
    const full = records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
    assert.equal(capNotificationRecords(full, isToastOnly, isPinned), full)
    assert.equal(capNotificationRecords(records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 1), isToastOnly, isPinned).length, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
  })

  /**
   * The regression Zaldaryon caught on the first cut of this rule. A toast-only record leaves
   * the list when it is dismissed, so the oldest survivor is the one being read; trimming
   * oldest first unmounted it mid-sentence and left the overlay blank until its timer ran out.
   */
  it("never drops the pinned toast on screen, and drops the oldest waiting one instead", () => {
    const isPinned = (entry: { id: string }): boolean => entry.id === "t0"
    const capped = capNotificationRecords(records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 2), isToastOnly, isPinned)
    assert.deepEqual(
      capped.map((entry) => entry.id),
      ["t0", "t3", "t4", "t5", "t6", "t7", "t8"]
    )
  })

  /**
   * The review's second catch: the default presentation is `both`, so the toast on screen is
   * also a center entry, and once history is over capacity it is the oldest one there.
   */
  it("never drops a pinned center record either, and drops the oldest unpinned one instead", () => {
    const isPinned = (entry: { id: string }): boolean => entry.id === "c0"
    const capped = capNotificationRecords(records(MAX_CENTER_HISTORY + 1, 0), isToastOnly, isPinned)
    assert.equal(capped.length, MAX_CENTER_HISTORY + 1)
    assert.equal(capped[0]?.id, "c0")
    assert.equal(
      capped.some((entry) => entry.id === "c1"),
      true
    )
    assert.equal(
      capNotificationRecords(records(MAX_CENTER_HISTORY + 2, 0), isToastOnly, isPinned).some((entry) => entry.id === "c1"),
      false
    )
  })

  it("keeps exactly the on screen toast, the places still free and a full backlog when one is pinned", () => {
    const isPinned = (entry: { id: string }): boolean => entry.id === "t0"
    const full = records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
    assert.equal(capNotificationRecords(full, isToastOnly, isPinned), full)
    assert.equal(capNotificationRecords(records(0, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 1), isToastOnly, isPinned).length, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
  })

  it("counts a pinned center record as a banner on screen, so it takes a place in the stack too", () => {
    const isPinned = (entry: { id: string }): boolean => entry.id === "c0"
    const capped = capNotificationRecords(records(1, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS), isToastOnly, isPinned)
    assert.equal(capped.filter((entry) => entry.toastOnly).length, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS - 1)
    assert.equal(capped[0]?.id, "c0")
  })

  it("never lets a pile of queued toasts push real history out", () => {
    const capped = capNotificationRecords(records(4, 40), isToastOnly)
    assert.deepEqual(
      capped.filter((entry) => !entry.toastOnly).map((entry) => entry.id),
      ["c0", "c1", "c2", "c3"]
    )
  })

  it("trims both budgets in one pass when both are over", () => {
    const capped = capNotificationRecords(records(MAX_CENTER_HISTORY + 2, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS + 2), isToastOnly)
    assert.equal(capped.filter((entry) => !entry.toastOnly).length, MAX_CENTER_HISTORY)
    assert.equal(capped.filter((entry) => entry.toastOnly).length, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
  })

  it("leaves a list sitting exactly on both budgets alone", () => {
    const kept = records(MAX_CENTER_HISTORY, MAX_TOAST_BACKLOG + MAX_VISIBLE_TOASTS)
    assert.equal(capNotificationRecords(kept, isToastOnly), kept)
  })
})
