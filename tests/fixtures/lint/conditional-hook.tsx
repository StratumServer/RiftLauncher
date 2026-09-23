// Deliberately broken fixture for tests/config/lint-guards.test.ts: a hook behind a
// condition, which rules-of-hooks has to reject. Both lint configs ignore this folder.
import { useState } from "react"

export function ConditionalHook(enabled: boolean): number {
  if (enabled) {
    const [value] = useState(0)
    return value
  }
  return 0
}
