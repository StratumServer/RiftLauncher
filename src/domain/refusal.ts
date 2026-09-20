/**
 * The one way a domain flow says no.
 *
 * Seven modules held their own three-line copy before this file existed (#484), differing only in
 * the failure union, which the type parameter carries instead. The shape on the wire is unchanged:
 * `{ ok: false, reason }`, with `ok` still the literal the result unions discriminate on.
 *
 * A refusal that carries more than a reason keeps its own helper, because the extra fields are part
 * of what the caller has to act on: see `installations/backup.ts` and `installations/restore.ts`.
 */
export function refuse<R>(reason: R): { ok: false; reason: R } {
  return { ok: false, reason }
}
