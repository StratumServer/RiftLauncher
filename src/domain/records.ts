/**
 * The object guard every parser in the launcher narrows unknown JSON with.
 *
 * It lived as a byte-identical private copy in eleven modules before this file existed (#484).
 * `src/domain/redaction.ts` sets the precedent and its header says why: a predicate duplicated so
 * a pure module can keep its own copy is how two copies drift apart. `src/ipc/validation.ts`
 * re-exports it unchanged, so the host and the tests that import it from there keep doing so.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
