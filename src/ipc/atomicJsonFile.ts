import writeFileAtomic from "write-file-atomic"

/**
 * Writes JSON to disk the way every persistence path in this app should: to a
 * same-directory temp file, fsynced, then one `rename()` over the destination.
 *
 * `rename()` is atomic on every platform Node runs this app on. Nothing here
 * ever removes the destination first, so a crash at any point before the
 * rename leaves the previous good file exactly as it was; a crash after it
 * leaves the new one. There is no point in the cycle where the destination
 * can be observed missing, which the two-step `fs-extra`-style "remove old,
 * then rename new" this replaced could not say.
 *
 * Not claimed: durability across power loss. write-file-atomic fsyncs the
 * temp file's descriptor but never fsyncs the parent directory after the
 * rename, so the rename itself is not guaranteed to have reached the platter.
 *
 * @param filePath Destination file. Its directory must already exist.
 * @param data Serialized to JSON with `spaces`.
 * @param options.mode Exact file mode for the destination (subject to umask).
 * Omit to let write-file-atomic copy the existing file's mode, or default to
 * the platform's usual mode for a new file when there is no existing one.
 * @param options.spaces `JSON.stringify` spacing. Defaults to none; the
 * modpack export passes 2, because that file is one a player reads and edits.
 */
export async function writeJsonAtomic(filePath: string, data: unknown, options: { mode?: number; spaces?: number } = {}): Promise<void> {
  const json = JSON.stringify(data, undefined, options.spaces)
  await writeFileAtomic(filePath, json, options.mode === undefined ? {} : { mode: options.mode })
}

/**
 * The longest name `write-file-atomic` adds beside a destination before opening anything:
 * one dot plus the ten digits its `readUInt32BE(0)` can reach
 * (`node_modules/write-file-atomic/lib/index.js:29-38`). A caller that has to decide whether
 * Windows can open a path at all has to leave this much room, because the temp file beside the
 * destination is the first thing opened, not the destination.
 */
export const ATOMIC_WRITE_TEMP_SUFFIX_MAX = 11

/**
 * The same write for text that is not JSON.
 *
 * A mod config is copied out of somebody's `ModConfig` folder verbatim and put back verbatim, so
 * `writeJsonAtomic` would be the wrong tool twice over: it would reformat what the game reads and it
 * would call `Buffer.from(text, "utf8")` for us, which silently replaces every byte that is not
 * valid UTF-8 rather than failing. Everything above about the temp file, the fsync and the single
 * `rename()` over the destination applies unchanged.
 *
 * @param filePath Destination file. Its directory must already exist.
 * @param text Bytes exactly as they should land, encoded UTF-8 on the way in.
 * @param options.mode Exact file mode for the destination (subject to umask).
 */
export async function writeTextAtomic(filePath: string, text: string, options: { mode?: number } = {}): Promise<void> {
  await writeFileAtomic(filePath, Buffer.from(text, "utf8"), options.mode === undefined ? {} : { mode: options.mode })
}
