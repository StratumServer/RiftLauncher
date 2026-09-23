/**
 * The one way a domain flow says no.
 *
 * Six modules held their own three-line copy of it and `installations/create.ts` two (#484), each
 * differing only in the failure union, which the type parameter carries instead. What comes back is
 * the same `{ ok: false, reason }`, `ok` still the literal every result union discriminates on.
 *
 * A refusal that carries more than a reason keeps its own helper, because those extra fields are
 * part of what the caller has to act on: see `installations/backup.ts` and `installations/restore.ts`.
 */
export function refuse<R>(reason: R): { ok: false; reason: R } {
  return { ok: false, reason }
}
