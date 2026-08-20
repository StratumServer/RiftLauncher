/**
 * Turning a downloaded Inno Setup installer into a game folder, without the
 * worker plumbing.
 *
 * The reading of the format lives in `src/domain/inno`, which knows nothing of
 * Node. This is the other half: the file handle, the digest, the writes, and the
 * same safety discipline the archive extraction already follows. The payload
 * lands in a temporary folder, the tree is validated there, and only then is it
 * copied into the destination, so an installer that declares a hostile path
 * never gets to write a byte where the launcher keeps its files.
 *
 * @see src/domain/inno/extract.ts for what is read and why the installer is not
 * run.
 */

import { createHash } from "crypto"
import fse from "fs-extra"
import { mkdtempSync } from "fs"
import { open } from "fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "os"

// Relative so the module stays importable from a plain test run, like extraction.ts.
import { extractInnoPayload } from "../../domain/inno/extract"
import { isInnoFormatError } from "../../domain/inno/errors"
import type { InnoInstallerFile } from "../../domain/inno/ports"
import { assertNoSymlinkComponents, copyTree, validateTree } from "./extraction"

/**
 * How an attempt ended.
 *
 * `format-refused` is not a failure of the install, it is the agreed signal that
 * sends the caller back to running the installer: everything the reader declines
 * to read goes through it, from an unknown version to a digest that does not
 * land, so there is only ever one path back.
 */
export type InnoExtractionVerdict = "extracted" | "format-refused"

export interface InnoExtractionOptions {
  /** The downloaded installer. */
  filePath: string
  /** Folder the game ends up in. Created when missing. */
  outputPath: string
  /** Whether the installer is deleted once the game landed. */
  deleteInstaller: boolean
  /** Called with 0 to 100 as the work advances. */
  onProgress?: (progress: number) => void
}

export interface InnoExtractionOutcome {
  verdict: InnoExtractionVerdict
  /** Why the reader declined, present only on `format-refused`. */
  reason?: string
  filesWritten?: number
  bytesWritten?: number
}

/** Reads the installer through a file handle, one range at a time. */
function installerFile(handle: fse.promises.FileHandle, size: number): InnoInstallerFile {
  return {
    size,
    read: async (offset, length): Promise<Uint8Array> => {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    }
  }
}

/**
 * Writes one file under `root`.
 *
 * The domain already refused anything that could climb out, and this checks it
 * again against the resolved path. Two checks for one rule is deliberate: the
 * first is a rule about the format, the second is a rule about this filesystem,
 * and they answer to different things.
 */
function payloadSink(root: string): { writeFile(relativePath: string, contents: Uint8Array): Promise<void> } {
  const resolvedRoot = resolve(root)
  const created = new Set<string>()

  return {
    writeFile: async (relativePath, contents): Promise<void> => {
      const destination = resolve(resolvedRoot, ...relativePath.split("/"))
      const inside = relative(resolvedRoot, destination)
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Installer payload escaped its root")

      const parent = dirname(destination)
      if (!created.has(parent)) {
        await fse.ensureDir(parent)
        created.add(parent)
      }

      await fse.writeFile(destination, contents)
    }
  }
}

/**
 * Extracts one installer's payload into one folder.
 *
 * @param options Installer, destination, and how to report progress.
 * @returns Whether the game was laid down, or why the reader declined.
 * @throws When the destination cannot be written, or when the extracted tree
 * fails the same checks an archive has to pass.
 */
export async function runInnoExtraction(options: InnoExtractionOptions): Promise<InnoExtractionOutcome> {
  const { filePath, outputPath, deleteInstaller, onProgress } = options
  let temporaryRoot: string | undefined

  try {
    assertNoSymlinkComponents(outputPath)
    fse.ensureDirSync(outputPath)
    if (fse.lstatSync(outputPath).isSymbolicLink()) throw new Error("Extraction destination is a symbolic link")

    temporaryRoot = mkdtempSync(join(tmpdir(), "riftlauncher-inno-"))
    const payloadRoot = join(temporaryRoot, "payload")
    fse.ensureDirSync(payloadRoot)

    const handle = await open(filePath, "r")
    let filesWritten: number
    let bytesWritten: number
    try {
      const stats = await handle.stat()
      const result = await extractInnoPayload(
        {
          installer: installerFile(handle, stats.size),
          digest: { hash: (bytes) => createHash("sha256").update(bytes).digest() },
          sink: payloadSink(payloadRoot)
        },
        // Capped at 99: the last point belongs to the copy out of the temporary
        // folder, which is not free on a folder holding twenty thousand files.
        { onProgress: (fraction) => onProgress?.(Math.min(99, Math.floor(fraction * 99))) }
      )
      filesWritten = result.filesWritten
      bytesWritten = result.bytesWritten
    } catch (error) {
      if (isInnoFormatError(error)) return { verdict: "format-refused", reason: error.message }
      throw error
    } finally {
      await handle.close()
    }

    validateTree(payloadRoot)
    copyTree(payloadRoot, outputPath)

    if (deleteInstaller) {
      assertNoSymlinkComponents(filePath)
      const installerStats = fse.lstatSync(filePath)
      if (!installerStats.isFile() || installerStats.isSymbolicLink()) throw new Error("Installer path is unsafe")
      fse.unlinkSync(filePath)
    }

    onProgress?.(100)
    return { verdict: "extracted", filesWritten, bytesWritten }
  } finally {
    if (temporaryRoot) fse.removeSync(temporaryRoot)
  }
}
