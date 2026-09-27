/**
 * When a new message is only a repeat of one the player can already see.
 *
 * Toggling a mod off and straight back on, or a retry that fails the same way
 * twice, put the same sentence on screen twice: two banners saying one thing,
 * and with a stack that is two of its three places spent on the same word. The
 * second one carries no information the first did not, so it refreshes the
 * first instead, which restarts its turn and marks it as having happened twice.
 *
 * Same message means same translation key and same interpolation values. The
 * provider is handed the finished sentence rather than the key, and that
 * sentence is exactly what the key and its values produce, so comparing bodies
 * compares key and values: two different keys that render the same sentence in
 * the player's language are the same sentence to the player too.
 *
 * A banner carrying a question is never folded, in either direction. Two
 * questions that read alike are still two answers owed, and folding one away
 * would silently drop the one the player never got to answer.
 */
export interface RepeatableToast {
  id: string
  body: string
  type: string
  hasActions: boolean
}

/**
 * The id of the banner a new message would only repeat, or undefined when it
 * is something new and deserves a place of its own.
 *
 * `shown` is every toast on screen or still waiting, because both are messages
 * the player is about to read: folding into a waiting one keeps the queue from
 * carrying the same sentence twice.
 */
export function duplicateToastId(shown: readonly RepeatableToast[], incoming: Omit<RepeatableToast, "id">): string | undefined {
  if (incoming.hasActions) return undefined
  return shown.find((candidate) => !candidate.hasActions && candidate.type === incoming.type && candidate.body === incoming.body)?.id
}
