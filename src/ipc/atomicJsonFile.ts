import writeFileAtomic from "write-file-atomic"

/**
 * Writes JSON to disk the way every persistence path in this app should: to a
 * same-directory temp file, fsynced, then one `rename()` over the destination.
 *
 * `rename()` is atomic on every platform Node runs this app on. Nothing here
 * ever removes the destination first, so a crash or power loss at any point
 * before the rename leaves the previous good file exactly as it was; a crash
 * after it leaves the new one. There is no point in the cycle where the
 * destination can be observed missing, which the two-step
 * `fs-extra`-style "remove old, then rename new" this replaced could not say:
 * that pattern has a real gap between the two steps, confirmed by kill-testing
 * both in `docs/rift-launcher/library-performance-stability-review-2026-08-25.md`.
 *
 * @param filePath Destination file. Its directory must already exist.
 * @param data Serialized to JSON with `spaces`.
 * @param options.mode Exact file mode for the destination (subject to umask).
 * Omit to let write-file-atomic copy the existing file's mode, or default to
 * the platform's usual mode for a new file when there is no existing one.
 * @param options.spaces `JSON.stringify` spacing. Defaults to none, matching
 * every caller this replaced.
 */
export async function writeJsonAtomic(filePath: string, data: unknown, options: { mode?: number; spaces?: number } = {}): Promise<void> {
  const json = JSON.stringify(data, undefined, options.spaces)
  await writeFileAtomic(filePath, json, options.mode === undefined ? {} : { mode: options.mode })
}
