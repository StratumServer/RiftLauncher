/**
 * The object guard the launcher narrows an unknown value with.
 *
 * Twelve modules each held a byte-identical private copy of it, and `account/modPaths.ts` a
 * variant returning the record or null (#484). `src/domain/redaction.ts` sets the precedent and
 * its header says why: a predicate duplicated so a pure module can keep its own copy is how two
 * copies drift apart. `src/ipc/validation.ts` re-exports this one, so the host modules and the
 * tests that import it from there keep doing so.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
