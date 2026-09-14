/**
 * What a single "Clear all" takes, and what it has to leave behind.
 *
 * The Activity Center could only be emptied one row at a time, while the
 * notification half right below it already had "Mark all read" and "Clear
 * read". After an installation with a dozen steps the player dismissed a dozen
 * rows by hand.
 *
 * Two things survive it, and both for the same reason: clearing is a tidying
 * gesture, and a tidying gesture must not take something away that the player
 * was in the middle of. A banner on screen is being read right now. A question
 * that has not been answered is still owed an answer, and dropping it would
 * quietly drop the offer with it, which is the exception "Clear read" already
 * makes. Work still running survives too: a task that has not finished is not a
 * leftover, and there is no way to put it back.
 *
 * Everything else goes in one action, and the undo toast is what makes that
 * safe to press.
 */

/** How long the undo toast stays up. Long enough to notice the panel emptying and change your mind. */
export const BULK_CLEAR_UNDO_DURATION = 5_000

/** True for a notification record "Clear all" must leave where it is. */
export function survivesBulkClear(record: Readonly<{ onScreen: boolean; awaitsAnswer: boolean }>): boolean {
  return record.onScreen || record.awaitsAnswer
}

/** True for a task row "Clear all" must leave where it is: anything that has not finished. */
export function taskSurvivesBulkClear(status: string): boolean {
  return status !== "completed" && status !== "failed"
}
