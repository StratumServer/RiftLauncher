import fse from "fs-extra"
import { basename, dirname, join, resolve } from "node:path"

import { isRestoreStagingWorkspaceName } from "@src/ipc/validation"
import { DOWNLOAD_TEMP_FILE_NAMESPACE } from "@src/ipc/workers/download"
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Only names `runDownload` creates are owned by this sweep. The legacy
 * unnamespaced shape is deliberately not matched because generic numeric
 * `.part` files may belong to another tool and broad matching risks deleting
 * its data.
 */
export const DOWNLOAD_PART_FILE_PATTERN = new RegExp(`^.+\\.${escapeRegExp(DOWNLOAD_TEMP_FILE_NAMESPACE)}\\.\\d+\\.\\d+\\.part$`)

/** The staging directory `runExtraction` creates inside the destination folder. */
export const EXTRACTION_STAGING_PATTERN = /^\.riftlauncher-extract-/

export type TemporaryFileKind = "atomic-json" | "download-part" | "extraction-staging" | "restore-workspace"

/**
 * Kinds that name a folder rather than a file. They are checked before the
 * recursive branch, so the sweep never walks into one of them.
 */
const DIRECTORY_KINDS: readonly TemporaryFileKind[] = ["extraction-staging", "restore-workspace"]

export interface TemporaryFileSweepTarget {
  /** Directory to inspect. A missing directory is an ordinary first-run state. */
  path: string
  /** Names that are safe to consider in this directory. */
  kinds: readonly TemporaryFileKind[]
  /** Download destinations contain version and installation subdirectories. */
  recursive?: boolean
  /**
   * Installation folder names whose abandoned restore workspaces may sit in this
   * directory. Only used by the `restore-workspace` kind, which refuses to match
   * anything that is not named after a configured installation.
   */
  installationNames?: readonly string[]
}

export interface TemporaryFileSweepOptions {
  /** Injectable clock for deterministic age tests. */
  nowMs?: number
  /** Only tests override the production retention window. */
  maxAgeMs?: number
  /** Tests can capture the debug evidence without replacing electron-log. */
  log?: (mode: ErrorTypes, message: string) => void
}

function matchesKind(name: string, kind: TemporaryFileKind, target: TemporaryFileSweepTarget): boolean {
  if (kind === "atomic-json") return ATOMIC_JSON_TEMP_FILE_PATTERN.test(name)
  if (kind === "download-part") return DOWNLOAD_PART_FILE_PATTERN.test(name)
  if (kind === "restore-workspace") return (target.installationNames ?? []).some((installationName) => isRestoreStagingWorkspaceName(installationName, name))
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

    // Extraction staging folders and abandoned restore workspaces are
    // directories, not files: remove them recursively when they match and are
    // old enough. This runs before the recursive branch on purpose. A recursive
    // target claims any directory and walks into it, so a folder checked after
    // that branch is never reached. Every exit here continues, so the sweep also
    // stays out of a folder whose work is still in flight.
    const directoryKind = entry.isDirectory() ? DIRECTORY_KINDS.find((kind) => target.kinds.includes(kind) && matchesKind(entry.name, kind, target)) : undefined

    if (directoryKind) {
      let stats: fse.Stats
      try {
        stats = await fse.lstat(entryPath)
      } catch (error) {
        if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not inspect ${entryPath}: ${error}`)
        continue
      }
      if (stats.isSymbolicLink() || options.nowMs - stats.mtimeMs <= options.maxAgeMs) continue
      const label = directoryKind === "restore-workspace" ? "abandoned restore workspace" : "orphaned staging folder"
      try {
        await fse.remove(entryPath)
        removed += 1
        options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Removed ${label} ${entryPath}.`)
      } catch (error) {
        if (!isMissing(error)) options.log("debug", `[back] [maintenance] [orphanedTempFiles.ts] Could not remove ${entryPath}: ${error}`)
      }
      continue
    }

    if (target.recursive && entry.isDirectory()) {
      removed += await sweepDirectory(target, options, entryPath)
      continue
    }

    if (!entry.isFile() || !target.kinds.some((kind) => matchesKind(entry.name, kind, target))) continue

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
 * Returns the startup areas described by issues #266 and #353. Download files
 * are siblings of their final destination and extraction staging folders are
 * children of it, so the known installation and version roots cover both, with
 * a symlink-safe recursive walk that reaches a staging folder one level down in
 * a version or installation folder.
 *
 * A restore workspace is a sibling of the installation folder rather than a
 * child of it, and an installation can live anywhere, so each installation also
 * contributes its parent folder. That folder is inspected for the one name the
 * restore builds out of that installation's own folder name, and nothing else.
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
    targets.push({ path, kinds: ["atomic-json", "download-part", "extraction-staging"], recursive: true })
  }

  for (const installation of config.installations) {
    if (!installation.path) continue
    const parent = resolve(dirname(installation.path))
    const name = basename(installation.path)
    if (!name) continue

    // The parent is usually the installations root, which is already a target.
    // Folding the kind into that one target matters: the restore workspace has
    // to be judged before the recursive walk claims it as an ordinary folder.
    const existing = targets.find((target) => resolve(target.path) === parent)
    if (!existing) {
      targets.push({ path: parent, kinds: ["restore-workspace"], installationNames: [name] })
      continue
    }

    if (!existing.kinds.includes("restore-workspace")) existing.kinds = [...existing.kinds, "restore-workspace"]
    existing.installationNames = [...(existing.installationNames ?? []), name]
  }

  return targets
}
