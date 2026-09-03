import fse from "fs-extra"
import { join, resolve } from "node:path"

import { logMessage } from "@src/utils/logManager"

/** A week leaves plenty of time for a slow or interrupted download to be resumed manually. */
export const ORPHANED_TEMP_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * write-file-atomic@8 uses a numeric hash suffix, for example
 * `config.json.1234567890`. Keep this list tied to files RiftLauncher writes
 * itself, rather than treating every dotted file as disposable.
 */
export const ATOMIC_JSON_TEMP_FILE_PATTERN =
  /^(?:config(?:\.pre-migration\.bak)?\.json|account-secrets(?:\.json|(?:\.pre-migration|\.unreadable(?:\.v\d+)?)\.bak\.json)|clientsettings\.json|[a-f0-9]{64}\.json)\.\d+$/i

/** The temporary sibling created by `runDownload`. */
export const DOWNLOAD_PART_FILE_PATTERN = /^.+\.\d+\.\d+\.part$/

/** The staging directory created by `runExtraction` beside the destination. */
export const EXTRACTION_STAGING_PATTERN = /^\.riftlauncher-extract-/

export type TemporaryFileKind = "atomic-json" | "download-part" | "extraction-staging"

export interface TemporaryFileSweepTarget {
  /** Directory to inspect. A missing directory is an ordinary first-run state. */
  path: string
  /** Names that are safe to consider in this directory. */
  kinds: readonly TemporaryFileKind[]
  /** Download destinations contain version and installation subdirectories. */
  recursive?: boolean
}

export interface TemporaryFileSweepOptions {
  /** Injectable clock for deterministic age tests. */
  nowMs?: number
  /** Only tests override the production retention window. */
  maxAgeMs?: number
  /** Tests can capture the debug evidence without replacing electron-log. */
  log?: (mode: ErrorTypes, message: string) => void
}

function matchesKind(name: string, kind: TemporaryFileKind): boolean {
  if (kind === "atomic-json") return ATOMIC_JSON_TEMP_FILE_PATTERN.test(name)
  if (kind === "download-part") return DOWNLOAD_PART_FILE_PATTERN.test(name)
  return EXTRACTION_STAGING_PATTERN.test(name)
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function sweepDirectory(target: TemporaryFileSweepTarget, options: Required<Pick<TemporaryFileSweepOptions, "nowMs" | "maxAgeMs" | "log">>, folder: string = target.path): Promise<number> {
  let entries: fse.Dirent[]
  try {
    entries = await fse.readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not inspect ${folder}: ${error}`)
    return 0
  }

  let removed = 0

  for (const entry of entries) {
    const entryPath = join(folder, entry.name)

    if (target.recursive && entry.isDirectory()) {
      removed += await sweepDirectory(target, options, entryPath)
      continue
    }

    // Extraction staging folders are directories, not files: remove them
    // recursively when they match and are old enough.
    if (entry.isDirectory() && target.kinds.includes("extraction-staging") && matchesKind(entry.name, "extraction-staging")) {
      let stats: fse.Stats
      try {
        stats = await fse.lstat(entryPath)
      } catch (error) {
        if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not inspect ${entryPath}: ${error}`)
        continue
      }
      if (stats.isSymbolicLink() || options.nowMs - stats.mtimeMs <= options.maxAgeMs) continue
      try {
        await fse.remove(entryPath)
        removed += 1
        options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Removed orphaned staging folder ${entryPath}.`)
      } catch (error) {
        if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not remove ${entryPath}: ${error}`)
      }
      continue
    }

    if (!entry.isFile() || !target.kinds.some((kind) => matchesKind(entry.name, kind))) continue

    let stats: fse.Stats
    try {
      // lstat keeps a symlink out of the deletion path, even if an entry changes
      // between readdir and this check.
      stats = await fse.lstat(entryPath)
    } catch (error) {
      if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not inspect ${entryPath}: ${error}`)
      continue
    }

    if (!stats.isFile() || stats.isSymbolicLink() || options.nowMs - stats.mtimeMs <= options.maxAgeMs) continue

    try {
      await fse.unlink(entryPath)
      removed += 1
      options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Removed orphaned temporary file ${entryPath}.`)
    } catch (error) {
      if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not remove ${entryPath}: ${error}`)
    }
  }

  return removed
}

/**
 * Removes only old temporary files in directories the launcher explicitly owns.
 * This is one startup pass. It does not install a timer or a background worker.
 */
export async function sweepOrphanedTempFiles(targets: readonly TemporaryFileSweepTarget[], options: TemporaryFileSweepOptions = {}): Promise<number> {
  const resolved: Required<Pick<TemporaryFileSweepOptions, "nowMs" | "maxAgeMs" | "log">> = {
    nowMs: options.nowMs ?? Date.now(),
    maxAgeMs: options.maxAgeMs ?? ORPHANED_TEMP_FILE_MAX_AGE_MS,
    log: options.log ?? logMessage
  }

  let removed = 0
  for (const target of targets) removed += await sweepDirectory({ ...target, path: resolve(target.path) }, resolved)
  return removed
}

/**
 * Returns the three startup areas described by issue #266. Download files are
 * siblings of their final destination today, so the known installation and
 * version roots are the download staging area and need a symlink-safe walk.
 */
export function getOrphanedTempFileSweepTargets(userDataPath: string, config: ConfigType): TemporaryFileSweepTarget[] {
  const targets: TemporaryFileSweepTarget[] = [
    { path: userDataPath, kinds: ["atomic-json"] },
    { path: join(userDataPath, "Cache", "ModCatalog"), kinds: ["atomic-json"] }
  ]
  const seenPaths = new Set<string>()
  const downloadRoots = [
    config.defaultInstallationsFolder,
    config.defaultVersionsFolder,
    ...config.installations.map((installation) => installation.path),
    ...config.gameVersions.map((version) => version.path)
  ]

  for (const downloadRoot of downloadRoots) {
    if (!downloadRoot) continue
    const path = resolve(downloadRoot)
    if (seenPaths.has(path)) continue
    seenPaths.add(path)
    targets.push({ path, kinds: ["atomic-json", "download-part"], recursive: true })
  }

  // Extraction staging folders sit beside the destination, which is the
  // installation or version folder itself. The sweep walks the parent of each
  // configured path to find and remove old staging folders.
  const stagingParents = [
    config.defaultInstallationsFolder,
    config.defaultVersionsFolder,
    ...config.installations.map((installation) => installation.path),
    ...config.gameVersions.map((version) => version.path)
  ]

  for (const stagingParent of stagingParents) {
    if (!stagingParent) continue
    const path = resolve(stagingParent)
    if (seenPaths.has(path)) continue
    seenPaths.add(path)
    targets.push({ path, kinds: ["extraction-staging"] })
  }

  return targets
}
