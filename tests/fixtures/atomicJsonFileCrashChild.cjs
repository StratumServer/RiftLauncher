// Spawned by tests/ipc/atomicJsonFile.test.ts to prove write-file-atomic survives a crash
// between the temp write and the rename. Calls write-file-atomic directly (not through the
// TypeScript adapter, to avoid needing a TS runtime in a standalone child process); the
// adapter itself is a thin JSON.stringify plus pass-through, so this still exercises the
// real dependency the adapter wraps.
//
// Patches fs.rename to self-SIGKILL the instant write-file-atomic is about to call it,
// which it only reaches after the temp file's real open, write, fsync, close (and chmod,
// since a mode is given) have all genuinely completed. Deterministic: it kills at the same
// real point on every run, not a timing race.
const fs = require("fs")
const writeFileAtomic = require("write-file-atomic")

const [, , destPath, killAt] = process.argv

if (killAt === "before-rename") {
  const originalRename = fs.rename
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- fs.rename's own overloaded return type, not worth restating in a plain .cjs fixture
  fs.rename = function patchedRename(...args) {
    process.kill(process.pid, "SIGKILL")
    return originalRename.apply(fs, args)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain .cjs fixture, not part of the typed src/ tree
async function main() {
  await writeFileAtomic(destPath, JSON.stringify({ marker: "NEW-CONTENT" }), { mode: 0o600 })
  if (killAt === "after-rename") process.kill(process.pid, "SIGKILL")
  process.exit(0)
}

main()
