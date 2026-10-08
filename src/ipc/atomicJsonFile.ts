import writeFileAtomic from "write-file-atomic"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EPERM", "EBUSY"])
const RENAME_RETRY_WINDOW_MS = 3_000
const INITIAL_RENAME_RETRY_DELAY_MS = 50
const MAX_RENAME_RETRY_DELAY_MS = 250

/**
 * write-file-atomic serializes each rename, then releases its queue if the rename fails. Keep
 * this outer queue around the whole retry window so a later save cannot land before an older
 * save's retry and then be overwritten by it.
 */
const pendingAtomicWrites = new Map<string, Promise<void>>()

function atomicWriteQueueKey(filePath: string): string {
  const absolutePath = resolve(filePath)
  return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
}

function queueAtomicWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const key = atomicWriteQueueKey(filePath)
  const previous = pendingAtomicWrites.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(write)
  pendingAtomicWrites.set(key, current)

  const release = (): void => {
    if (pendingAtomicWrites.get(key) === current) pendingAtomicWrites.delete(key)
  }
  void current.then(release, release)

  return current
}

function isTransientRenameError(error: unknown): error is NodeJS.ErrnoException {
  if (typeof error !== "object" || error === null) return false
  const { code, syscall } = error as NodeJS.ErrnoException
  return syscall === "rename" && TRANSIENT_RENAME_CODES.has(code ?? "")
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function writeWithRenameRetry(filePath: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const deadline = performance.now() + RENAME_RETRY_WINDOW_MS
  let retryDelay = INITIAL_RENAME_RETRY_DELAY_MS

  for (;;) {
    try {
      // write-file-atomic mutates its options when it reads the existing file's mode, so each
      // attempt needs a fresh object.
      await writeFileAtomic(filePath, data, mode === undefined ? {} : { mode })
      return
    } catch (error) {
      if (!isTransientRenameError(error)) throw error

      const remaining = deadline - performance.now()
      if (remaining <= 0) throw error
      await wait(Math.min(retryDelay, remaining))
      if (performance.now() >= deadline) throw error

      retryDelay = Math.min(retryDelay * 2, MAX_RENAME_RETRY_DELAY_MS)
    }
  }
}

function writeAtomic(filePath: string, data: string | Uint8Array, mode?: number): Promise<void> {
  return queueAtomicWrite(filePath, () => writeWithRenameRetry(filePath, data, mode))
}

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
  await writeAtomic(filePath, json, options.mode)
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
  await writeAtomic(filePath, Buffer.from(text, "utf8"), options.mode)
}
