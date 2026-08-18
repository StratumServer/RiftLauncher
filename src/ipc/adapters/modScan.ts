import { createHash } from "crypto"
import { app } from "electron"
import fse from "fs-extra"
import { join } from "path"
import yauzl from "yauzl"

import type { DirectoryReader, IconStore, ModArchiveContent, ModArchiveReader, ModArchiveResult, PathBuilder } from "@domain/ports"
import type { CachedIcon } from "@domain/mods/iconCache"
import type { ScanInstalledModsPorts } from "@domain/mods/scanInstalled"
import { MOD_ICON_CACHE_MAX_BYTES, planIconCacheEviction } from "@domain/mods/iconCache"
import { assertSafeFileName } from "@src/ipc/validation"
import { logMessage } from "@src/utils/logManager"

/** Entry inside a mod archive carrying its metadata. */
const MODINFO_ENTRY = "modinfo.json"

/** Entry inside a mod archive carrying its icon. */
const MODICON_ENTRY = "modicon.png"

/** Past this, a `modinfo.json` is not metadata any more. */
const MAX_MODINFO_BYTES = 1 * 1024 * 1024

/** Past this, a mod icon is not an icon any more. */
const MAX_MOD_IMAGE_BYTES = 8 * 1024 * 1024

/** Folder mod icons are cached under, inside the launcher's own user data. */
function modImagesFolder(): string {
  return join(app.getPath("userData"), "Cache", "Images", "Mods")
}

/**
 * Reads one archive with yauzl and hands back only its bytes.
 *
 * Every exit runs through `settle`, which closes the archive and resolves once.
 * That single exit is the point of this function: the previous inline version
 * had one branch that resolved without closing, which left the archive reading
 * on in the background while the scan had already counted it as finished.
 *
 * Only two entries are ever read and nothing is written from an entry name, so
 * an archive from the internet cannot steer this into a path of its choosing.
 */
function readModArchive(archivePath: string): Promise<ModArchiveResult> {
  return new Promise<ModArchiveResult>((resolve) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [readModArchive] Could not open ${archivePath}: ${openErr}`)
        return resolve({ ok: false, problem: "unreadable-archive" })
      }

      const content: ModArchiveContent = {}
      let settled = false

      const settle = (result: ModArchiveResult): void => {
        if (settled) return
        settled = true
        if (zip.isOpen) zip.close()
        resolve(result)
      }

      /** Stops as soon as both entries are in hand, so the rest of the archive is never walked. */
      const advance = (): void => {
        if (content.modinfo !== undefined && content.icon !== undefined) return settle({ ok: true, content })
        if (zip.isOpen) zip.readEntry()
      }

      /** A declared size the archive itself admits is out of bounds, checked before a single byte is read. */
      const declaredSizeAllowed = (entry: yauzl.Entry, limit: number): boolean => Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize >= 0 && entry.uncompressedSize <= limit

      /**
       * Reads one entry into memory under a hard byte cap.
       *
       * The cap is enforced on the bytes as they arrive and not only on the
       * declared size, because the declared size is written by whoever built the
       * archive. Going over settles right there rather than destroying the
       * stream and waiting for an `end` that a destroyed stream never emits.
       */
      const collect = (entry: yauzl.Entry, limit: number, onDone: (bytes: Buffer) => void, onOversize: () => void, onUnreadable: () => void): void => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [readModArchive] Could not read ${entry.fileName} of ${archivePath}: ${streamErr}`)
            return onUnreadable()
          }

          const chunks: Buffer[] = []
          let total = 0

          stream.on("data", (chunk: Buffer) => {
            total += chunk.length
            if (total > limit) {
              stream.destroy()
              onOversize()
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          stream.on("end", () => onDone(Buffer.concat(chunks)))
          stream.on("error", (readErr) => {
            logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [readModArchive] Error reading ${entry.fileName} of ${archivePath}: ${readErr}`)
            onUnreadable()
          })
        })
      }

      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName === MODINFO_ENTRY && content.modinfo === undefined) {
          if (!declaredSizeAllowed(entry, MAX_MODINFO_BYTES)) return settle({ ok: false, problem: "modinfo-too-large" })

          return collect(
            entry,
            MAX_MODINFO_BYTES,
            (bytes) => {
              content.modinfo = bytes.toString("utf-8")
              advance()
            },
            () => settle({ ok: false, problem: "modinfo-too-large" }),
            () => settle({ ok: false, problem: "unreadable-archive" })
          )
        }

        if (entry.fileName === MODICON_ENTRY && content.icon === undefined) {
          if (!declaredSizeAllowed(entry, MAX_MOD_IMAGE_BYTES)) return settle({ ok: false, problem: "icon-too-large" })

          return collect(
            entry,
            MAX_MOD_IMAGE_BYTES,
            (bytes) => {
              content.icon = bytes
              advance()
            },
            () => settle({ ok: false, problem: "icon-too-large" }),
            // An icon that will not read costs the mod its picture, never its
            // place in the list: the metadata may still be perfectly readable.
            () => advance()
          )
        }

        if (zip.isOpen) zip.readEntry()
      })

      zip.on("end", () => settle({ ok: true, content }))
      zip.on("error", (zipErr) => {
        logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [readModArchive] Error walking ${archivePath}: ${zipErr}`)
        settle({ ok: false, problem: "unreadable-archive" })
      })

      if (zip.isOpen) zip.readEntry()
    })
  })
}

/** Wires the archive reader port onto yauzl. */
export function createModArchiveReaderPort(): ModArchiveReader {
  return { read: readModArchive }
}

/**
 * Names an icon by the sha256 of its own bytes.
 *
 * Two mods shipping the same icon collapse onto the same file, and rescanning
 * the same mod again writes to the same name instead of a fresh one, which is
 * what keeps a rescan from growing the cache at all.
 */
function contentAddressedName(bytes: Uint8Array): string {
  return `${createHash("sha256").update(bytes).digest("hex")}.png`
}

/** Wires the icon store port onto the launcher's image cache. */
export function createIconStorePort(): IconStore {
  return {
    store: async (bytes: Uint8Array): Promise<string | undefined> => {
      const imageName = contentAddressedName(bytes)
      try {
        const folder = modImagesFolder()
        await fse.ensureDir(folder)
        const target = join(folder, imageName)
        // The name is the content: whatever already sits at that path is these
        // same bytes, so a rescan has nothing left to write. It is touched
        // instead, which is what makes the sweep's eviction order mean
        // something: an icon that is still installed but never rewritten would
        // otherwise look older than one for a mod uninstalled last week. A
        // failed touch must not cost the mod its icon.
        if (await fse.pathExists(target)) {
          const now = new Date()
          await fse.utimes(target, now, now).catch(() => undefined)
        } else {
          await fse.writeFile(target, bytes)
        }
        return imageName
      } catch (err) {
        logMessage("error", `[back] [mods] [ipc/adapters/modScan.ts] [createIconStorePort] Error saving a mod's icon.`)
        logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [createIconStorePort] Error saving a mod's icon: ${err}`)
        return undefined
      }
    }
  }
}

/**
 * Deletes what the shared mod icon cache no longer earns its keep on.
 *
 * The rule is age and size, never a live set. The cache folder is shared by every installation
 * while a scan only ever reads one of them, so a caller that swept against the names one scan
 * produced would delete the icons every other installation is pointing at, which is what #117
 * reports. What this deletes instead is anything the current store could not have written, then the
 * least recently scanned icons once the folder is over budget. `createIconStorePort().store` moves
 * an icon's timestamp forward every time a scan points at it again, so an icon that is still
 * installed keeps looking young whichever installation holds it.
 *
 * Best effort throughout: this runs at startup and a cache sweep must never be able to break a
 * launch, so every filesystem error is logged and swallowed.
 *
 * @param maxBytes Budget the survivors have to fit in. Only tests pass this.
 */
export async function pruneModIconCache(maxBytes: number = MOD_ICON_CACHE_MAX_BYTES): Promise<void> {
  const folder = modImagesFolder()

  let names: string[]
  try {
    names = await fse.readdir(folder)
  } catch {
    // No cache folder yet, or it just vanished: nothing to sweep either way.
    return
  }

  const entries: CachedIcon[] = []
  for (const name of names) {
    try {
      // A name readdir handed back is already a single component, and this keeps
      // every join below inside modImagesFolder() even so. A name too strange to
      // pass is left alone rather than deleted on a guess.
      assertSafeFileName(name)
      const stats = await fse.stat(join(folder, name))
      if (stats.isFile()) entries.push({ name, bytes: stats.size, modifiedAt: stats.mtimeMs })
    } catch (err) {
      logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [pruneModIconCache] Skipping ${name}: ${err}`)
    }
  }

  const doomed = planIconCacheEviction(entries, maxBytes)
  if (doomed.length === 0) return

  const bytesByName = new Map(entries.map((entry) => [entry.name, entry.bytes]))
  let reclaimed = 0

  // Deleted individually rather than as one recursive removal of the folder:
  // each target stays a single, safe join onto a name readdir itself just handed
  // back, and one file another process is mid-delete on never takes the rest of
  // the sweep down with it.
  await Promise.all(
    doomed.map(async (name) => {
      try {
        await fse.remove(join(folder, name))
        reclaimed += bytesByName.get(name) ?? 0
      } catch (err) {
        logMessage("debug", `[back] [mods] [ipc/adapters/modScan.ts] [pruneModIconCache] Could not remove ${name} from the icon cache: ${err}`)
      }
    })
  )

  logMessage("info", `[back] [mods] [ipc/adapters/modScan.ts] [pruneModIconCache] Removed ${doomed.length} icons from the cache, ${reclaimed} bytes reclaimed.`)
}

/**
 * Wires the directory reader port onto the real folder.
 *
 * Entries the launcher will not open are dropped here rather than in the
 * domain: a name that cannot be safely joined onto a path and a symlink
 * pointing who knows where are both host concerns, and the folder is user
 * managed so both turn up.
 */
export function createModsDirectoryReaderPort(): DirectoryReader {
  return {
    listFileNames: async (path: string): Promise<string[]> => {
      let entries: string[]
      try {
        entries = await fse.readdir(path)
      } catch {
        return []
      }

      const names: string[] = []
      for (const entry of entries) {
        try {
          assertSafeFileName(entry)
          if (!(await fse.lstat(join(path, entry))).isSymbolicLink()) names.push(entry)
        } catch {
          // Ignore invalid or disappearing entries while scanning a user-managed directory.
        }
      }

      return names
    }
  }
}

/** Joins path segments with the host separator. */
export function createPathBuilderPort(): PathBuilder {
  return { join: async (parts: string[]): Promise<string> => join(...parts) }
}

/** Everything the installed-mods scan runs on, wired onto the main process. */
export function createScanInstalledModsPorts(): ScanInstalledModsPorts {
  return {
    directories: createModsDirectoryReaderPort(),
    archives: createModArchiveReaderPort(),
    icons: createIconStorePort(),
    paths: createPathBuilderPort()
  }
}
