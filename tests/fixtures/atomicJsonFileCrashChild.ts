// Spawned by tests/ipc/atomicJsonFile.test.ts to prove write-file-atomic survives a crash
// between the temp write and the rename. Runs the real src/ipc/atomicJsonFile.ts adapter
// under tsx, not write-file-atomic directly, so the crash trial exercises the exact code
// path the app ships, not just the dependency it wraps.
//
// Patches fs.rename to self-SIGKILL the instant write-file-atomic is about to call it,
// which it only reaches after the temp file's real open, write, fsync, close (and chmod,
// since a mode is given) have all genuinely completed. Deterministic: it kills at the same
// real point on every run, not a timing race.
import fs from "node:fs"

import { writeJsonAtomic } from "../../src/ipc/atomicJsonFile"

const [, , destPath, killAt] = process.argv

if (killAt === "before-rename") {
  const originalRename = fs.rename
  fs.rename = ((...args: unknown[]): unknown => {
    process.kill(process.pid, "SIGKILL")
    return (originalRename as unknown as (...a: unknown[]) => unknown).apply(fs, args)
  }) as unknown as typeof fs.rename
}

async function main(): Promise<void> {
  await writeJsonAtomic(destPath as string, { marker: "NEW-CONTENT" }, { mode: 0o600 })
  if (killAt === "after-rename") process.kill(process.pid, "SIGKILL")
  process.exit(0)
}

void main()
