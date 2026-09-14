/**
 * How long a toast holds the screen, and how many may wait behind it.
 *
 * The overlay presents one banner at a time and drains the rest in order. Until
 * this module existed every queued toast served its full duration, and nothing
 * bounded the queue, so a burst pushed the last message far past the event it
 * was reporting: five errors fired together took 40 s to drain, and a modpack
 * import with a completion toast per mod took minutes. A message that lands
 * three minutes late is not a notification any more, it is a puzzle.
 *
 * The two rules below are the whole fix. A toast that has something waiting
 * behind it gets a shorter turn, and a queue longer than the player can follow
 * drops its oldest entries rather than making them all late.
 */

/** Longest a toast stays up while another one is waiting for the screen. */
export const BACKLOG_TOAST_DURATION = 2_000

/**
 * Most banners the overlay stacks at once, newest at the bottom.
 *
 * One at a time meant a burst could only be read by shortening every turn in
 * it, which is the trade the backlog rule above makes. Three banners let a
 * burst of three be read at leisure, side by side, and only what comes after
 * that pays the backlog turn. Three and not more because the region is a
 * fixed-width column at the bottom right of the main area: a fourth banner
 * starts eating the page behind it, and a stack nobody can take in at a glance
 * is the same puzzle as a message that arrives late.
 */
export const MAX_VISIBLE_TOASTS = 3

/**
 * Most toasts kept behind the one on screen. Four at
 * `BACKLOG_TOAST_DURATION` each puts the last of a burst about eight seconds
 * out, which is close enough to the event to still read as its consequence.
 */
export const MAX_TOAST_BACKLOG = 4

/** Most records the Activity Center keeps. Toast-only entries do not count against it, nor does the toast on screen while it is up. */
export const MAX_CENTER_HISTORY = 50

/**
 * The turn a toast gets, given how many are waiting behind it and how much of
 * its turn has already gone.
 *
 * `null` means the toast has no timer at all, which is how a question that
 * needs an answer is kept on screen. A backlog never overrides that: the
 * player still has to answer it.
 *
 * `elapsed` is 0 at hand-off, where `duration` is the whole turn. It is used
 * when something lands behind a banner that is already up: the turn is then
 * whatever is left, capped at `BACKLOG_TOAST_DURATION`, and never negative.
 * The cap can only shorten, never lengthen: a banner already inside the
 * backlog turn keeps what it has.
 */
export function backlogToastDuration(duration: number | null, waiting: number, elapsed = 0): number | null {
  if (duration === null || waiting <= 0) return duration
  return Math.max(0, Math.min(duration - elapsed, BACKLOG_TOAST_DURATION))
}

/**
 * How many queued toasts are really waiting, given how much of the stack is
 * taken.
 *
 * A queued toast that a free place is about to take is not a backlog: it is
 * about to be on screen beside the others. Counting it as one shortened every
 * banner already up the moment a second message arrived, even though both had a
 * place. Only what is still queued once the stack is full has to be hurried
 * along.
 */
export function waitingBehindStack(queued: number, visible: number): number {
  return Math.max(0, queued - Math.max(0, MAX_VISIBLE_TOASTS - visible))
}

/**
 * Trims a record list to both budgets, oldest first, and returns the very same
 * array when nothing has to go so React can bail out of the render.
 *
 * The two budgets are separate on purpose. Center history is what the player
 * scrolls back through and is worth fifty entries. Toast-only records are
 * transient, exist solely to be shown once, and must never push real history
 * out; capping them at the backlog is also what stops a dropped toast from
 * sitting in the record list forever with no way to ever reach the screen.
 *
 * A pinned record is never dropped and counts against neither budget. The
 * provider pins every toast on screen, whatever its presentation: a toast-only
 * record leaves the list the moment it is dismissed, so without the pin the
 * oldest survivor is always the one being read, and a `both` record on screen
 * is also the oldest center entry once history fills up. Either cap would
 * unmount it mid-sentence.
 *
 * The toast budget also allows for the free places in the stack. Whatever is
 * not on screen yet takes one on the next render, so a burst arriving at an
 * empty overlay must keep `MAX_VISIBLE_TOASTS` of its own on top of the
 * backlog, or the cap drops records that were about to be shown.
 */
export function capNotificationRecords<T>(records: readonly T[], isToastOnly: (record: T) => boolean, isPinned: (record: T) => boolean = () => false): readonly T[] {
  let centerCount = 0
  let pinnedToasts = 0
  let waitingToasts = 0
  for (const record of records) {
    if (isPinned(record)) {
      pinnedToasts += 1
      continue
    }
    if (isToastOnly(record)) waitingToasts += 1
    else centerCount += 1
  }
  let centerExcess = centerCount - MAX_CENTER_HISTORY
  // Every free place in the stack is filled on the next render, so that many
  // more may wait. A pinned record of any presentation is something on screen.
  let toastExcess = waitingToasts - (MAX_TOAST_BACKLOG + Math.max(0, MAX_VISIBLE_TOASTS - pinnedToasts))
  if (centerExcess <= 0 && toastExcess <= 0) return records

  return records.filter((record) => {
    // Pinned means on screen, whatever its presentation: a `both` record is
    // center history too, and the history cap must not unmount it either.
    if (isPinned(record)) return true
    if (isToastOnly(record)) {
      if (toastExcess <= 0) return true
      toastExcess -= 1
      return false
    }
    if (centerExcess <= 0) return true
    centerExcess -= 1
    return false
  })
}
