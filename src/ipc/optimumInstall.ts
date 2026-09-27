/**
 * Turning a downloaded overlay archive into a patched game folder, and taking
 * that back off again.
 *
 * Electron lives one file up, in handlers/optimumHandlers.ts. Everything here
 * takes its paths as arguments so the whole flow can be driven from a test with
 * a fake CLI in a temporary folder.
 */

import fse from "fs-extra"
import { join } from "node:path"

import type { OptimumManifest } from "@domain/optimum/manifest"
import { cliFileName, OPTIMUM_STATE_FOLDER, OPTIMUM_VANILLA_FOLDER, supportsGameVersion } from "@domain/optimum/plan"
import { OPTIMUM_CONTRACTS_ASSEMBLY, sha256File, verifyPatchedOutput, verifyStagedOverlay } from "@src/ipc/optimumOverlay"
import { isOptimumRuntimeAvailable, runOptimumCli } from "@src/ipc/optimumPatch"
import { runExtraction } from "@src/ipc/workers/extraction"

/**
 * What the patch backs up, and where.
 *
 * The two root assemblies keep a `.vanilla` suffix in the backup and the two
 * mod assemblies do not, which is Optimum's own asymmetry rather than a choice
 * made here. The launcher restores from this table instead of asking the CLI
 * to: a player removing Optimum should not have to be online, have the overlay
 * still staged, or have a .NET runtime installed, and the restore is four file
 * copies whichever side does them.
 */
const VANILLA_BACKUPS = [
  { backup: "VintagestoryLib.vanilla.dll", live: "VintagestoryLib.dll", required: true },
  { backup: "VintagestoryAPI.vanilla.dll", live: "VintagestoryAPI.dll", required: true },
  { backup: join("Mods", "VSEssentials.dll"), live: join("Mods", "VSEssentials.dll"), required: false },
  { backup: join("Mods", "VSSurvivalMod.dll"), live: join("Mods", "VSSurvivalMod.dll"), required: false }
] as const

/** Where the patch keeps its copy of the untouched assemblies, relative to the game folder. */
const VANILLA_FOLDER = join(OPTIMUM_STATE_FOLDER, OPTIMUM_VANILLA_FOLDER)

function refuse(reason: OptimumPatchFailureReason): { ok: false; reason: OptimumPatchFailureReason } {
  return { ok: false, reason }
}

/**
 * Stages the downloaded archive and proves every file in it.
 *
 * Re-verifies the archive's own hash before unpacking rather than trusting that
 * the download that put it there was this session's: a file left in the cache
 * by an earlier run, under an earlier manifest, would otherwise be unpacked on
 * the strength of a check that happened to something else.
 *
 * @returns the overlay folder, or the reason it is not usable.
 */
async function stageOverlay(manifest: OptimumManifest, archivePath: string, overlayDirectory: string): Promise<{ ok: true } | { ok: false; reason: OptimumPatchFailureReason }> {
  // Already staged and still intact: the update path and a second install of the
  // same overlay both land here, and neither needs the archive read again.
  if (await verifyStagedOverlay(overlayDirectory, manifest)) return { ok: true }

  try {
    const stats = await fse.lstat(archivePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== manifest.archive.size) return refuse("overlay-unverified")
    if ((await sha256File(archivePath)) !== manifest.archive.sha256) return refuse("overlay-unverified")
  } catch {
    return refuse("overlay-unverified")
  }

  await fse.remove(overlayDirectory)

  try {
    // The same reader the game builds go through, including its refusal of links,
    // absolute names and anything that is not a plain file. `unwrapSingleRootFolder`
    // steps into the archive's own `Optimum-v<version>-<rid>-overlay/` the way the
    // game install steps into `vintagestory/`.
    await runExtraction({ filePath: archivePath, outputPath: overlayDirectory, deleteArchive: false, unwrapSingleRootFolder: true })
  } catch {
    await fse.remove(overlayDirectory)
    return refuse("overlay-unverified")
  }

  if (!(await verifyStagedOverlay(overlayDirectory, manifest))) {
    // A staging folder that did not check out is not left lying around for the
    // next run to find and, having been written by the launcher itself, trust.
    await fse.remove(overlayDirectory)
    return refuse("overlay-unverified")
  }

  return { ok: true }
}

/**
 * Restores the execute bit on the two files that need it.
 *
 * Both are named in `files[]` and were hashed against it a moment ago, so this
 * makes nothing runnable that the manifest did not already vouch for. It is
 * needed because the archive is unpacked through the launcher's own extraction,
 * which publishes a tree rather than preserving modes.
 */
async function makeOverlayRunnable(overlayDirectory: string, platform: string): Promise<void> {
  if (platform === "win32") return

  for (const name of [cliFileName(platform), join("patcher", "Optimum.Patcher")]) {
    const path = join(overlayDirectory, name)
    if (await fse.pathExists(path)) await fse.chmod(path, 0o755)
  }
}

export interface ApplyOverlayOptions {
  manifest: OptimumManifest
  /** The archive as it was downloaded, still in the cache root. */
  archivePath: string
  /** Folder the overlay is staged into. */
  overlayDirectory: string
  /** The game folder, already through `assertManagedPath`. */
  gameDirectory: string
  /** The version the launcher has registered for that folder, which is the gate the CLI does not enforce. */
  gameVersion: string
  /** File the child's stderr is streamed into. */
  stderrLogPath?: string
  onProgress?: (progress: number) => void
  platform?: string
}

/**
 * Downloads-already-done half of the install: stage, verify, preflight, patch,
 * verify again.
 *
 * Never throws for anything a player can reach: each refusal is one token.
 */
export async function applyOptimumOverlay(options: ApplyOverlayOptions): Promise<OptimumPatchResult> {
  const { manifest, archivePath, overlayDirectory, gameDirectory, gameVersion, stderrLogPath, onProgress, platform = process.platform } = options

  // `supportedGameVersions` is advisory metadata the CLI never reads, so this is
  // the only thing standing between a player and a patch aimed at a build
  // Optimum never claimed.
  if (!supportsGameVersion(manifest, gameVersion)) return refuse("unsupported-version")

  const staged = await stageOverlay(manifest, archivePath, overlayDirectory)
  if (!staged.ok) return staged

  await makeOverlayRunnable(overlayDirectory, platform)

  // Asked before anything promises the player a patch: the overlay is
  // framework-dependent net10.0, so a machine without the runtime has to be told
  // rather than shown a run that dies halfway.
  if (!(await isOptimumRuntimeAvailable(overlayDirectory, platform))) return refuse("runtime-missing")

  const run = await runOptimumCli({ overlayDirectory, gameDirectory, mode: "patch", stderrLogPath, onProgress, platform })
  if (!run.ok) return rollBackFailedRun(gameDirectory, run)

  if (!(await verifyPatchedOutput(gameDirectory, manifest))) return rollBackFailedRun(gameDirectory, refuse("output-unverified"))

  return { ok: true }
}

/**
 * Puts a folder back after a run that did not finish.
 *
 * The patch replaces the four assemblies one at a time and backs each one up
 * before it does, so a run that stopped partway leaves a build carrying two
 * overlay versions at once and a `.optimum/manifest.json` that matches neither.
 * The launcher owns that backup already, so the honest answer to a failed run is
 * to use it rather than to report that the build was left as it was.
 *
 * The reason the run gave is what the player is told either way. `rolledBack`
 * only says which sentence is true about the folder afterwards, and a build with
 * no backup to restore from (a run that failed before it wrote anything) keeps
 * the plain refusal.
 */
async function rollBackFailedRun(gameDirectory: string, failure: { ok: false; reason: OptimumPatchFailureReason }): Promise<OptimumPatchResult> {
  const restored = await restoreVanillaBuild(gameDirectory)
  return restored.ok ? { ...failure, rolledBack: true } : failure
}

/**
 * Puts the four assemblies back and takes the launcher's own marks off.
 *
 * Partial by construction, and the dialog says so: the overlaid shaders, the
 * merged language keys and anything else written into `assets/` stay until the
 * build is reinstalled. Undoing those would mean keeping a pristine copy of a
 * gigabyte-sized install, which is not worth the disk to avoid one honest
 * sentence.
 *
 * @param gameDirectory The game folder, already through `assertManagedPath`.
 */
export async function restoreVanillaBuild(gameDirectory: string): Promise<OptimumPatchResult> {
  const vanillaFolder = join(gameDirectory, VANILLA_FOLDER)

  const present = await Promise.all(VANILLA_BACKUPS.map((entry) => fse.pathExists(join(vanillaFolder, entry.backup))))
  // The same condition the CLI's own rollback refuses on: with neither root
  // assembly backed up there is nothing to restore from, and copying the two mod
  // assemblies alone would leave a build that is neither patched nor vanilla.
  if (VANILLA_BACKUPS.some((entry, index) => entry.required && !present[index])) return refuse("backup-missing")

  try {
    for (const [index, entry] of VANILLA_BACKUPS.entries()) {
      if (!present[index]) continue
      await fse.copy(join(vanillaFolder, entry.backup), join(gameDirectory, entry.live), { overwrite: true })
    }

    await fse.remove(join(gameDirectory, OPTIMUM_CONTRACTS_ASSEMBLY))
    await fse.remove(join(gameDirectory, OPTIMUM_STATE_FOLDER))
  } catch {
    return refuse("restore-failed")
  }

  return { ok: true }
}
