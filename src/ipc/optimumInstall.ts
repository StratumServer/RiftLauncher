/**
 * Turning a downloaded overlay archive into a patched game folder, and taking
 * that back off again.
 *
 * Electron lives one file up, in handlers/optimumHandlers.ts. Everything here
 * takes its paths as arguments so the whole flow can be driven from a test with
 * a fake CLI in a temporary folder.
 */

import fse from "fs-extra"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

import { readOptimumAssemblyReferences } from "@domain/optimum/assemblyReferences"
import type { OptimumManifest } from "@domain/optimum/manifest"
import { cliFileName, OPTIMUM_CONTRACTS_ASSEMBLY, OPTIMUM_GAME_CONTENT_ASSEMBLY, OPTIMUM_STATE_FOLDER, OPTIMUM_VANILLA_FOLDER, supportsGameVersion } from "@domain/optimum/plan"
import { readRecordedPatchedHashes, sha256File, verifyPatchedOutput, verifyStagedOverlay } from "@src/ipc/optimumOverlay"
import { isOptimumRuntimeAvailable, runOptimumCli } from "@src/ipc/optimumPatch"
import { getErrorMessage, logMessage } from "@src/utils/logManager"

/** Same shape as the other main-process modules, so a support log traces back to this file. */
const LOG_PREFIX = "[back] [ipc] [ipc/optimumInstall.ts]"

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
    // Module scope is the boot path for the main process, and this worker chunk is only
    // needed once someone installs Optimum. Loaded here so it stays off that path.
    const { runExtraction } = await import("@src/ipc/workers/extraction")
    await runExtraction({ filePath: archivePath, outputPath: overlayDirectory, deleteArchive: false, unwrapSingleRootFolder: true })
  } catch (error) {
    // The staging folder goes either way, but an archive the reader refused and a worker chunk that
    // failed to load are the same refusal from the outside, so the cause is recorded rather than
    // folded into the reason the player sees.
    logMessage("debug", `${LOG_PREFIX} [OVERLAY] Could not extract the downloaded overlay archive.`)
    logMessage("debug", `${LOG_PREFIX} [OVERLAY] ${getErrorMessage(error)}`)
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

  // The patch sources every assembly from `.optimum/vanilla/` once it exists, so a
  // folder the game was updated in place over would be patched from the older
  // build, and the record it writes would make that look intended.
  if ((await readLiveBuild(gameDirectory)) !== "patched") return refuse("build-changed")

  const staged = await stageOverlay(manifest, archivePath, overlayDirectory)
  if (!staged.ok) return staged

  await makeOverlayRunnable(overlayDirectory, platform)

  // Asked before anything promises the player a patch: the overlay is
  // framework-dependent net10.0, so a machine without the runtime has to be told
  // rather than shown a run that dies halfway.
  if (!(await isOptimumRuntimeAvailable(overlayDirectory, platform))) return refuse("runtime-missing")

  const run = await runOptimumCli({ overlayDirectory, gameDirectory, mode: "patch", stderrLogPath, onProgress, platform })
  if (!run.ok) return rollBackFailedRun(gameDirectory, run)

  const verification = await verifyPatchedOutput(gameDirectory, manifest)
  if (!verification.ok) {
    if (verification.reason === "missing-assembly") {
      logMessage("error", `${LOG_PREFIX} [OVERLAY] ${verification.target} references missing ${verification.assembly}.`)
      return rollBackFailedRun(gameDirectory, { ...refuse("missing-assembly"), missingAssembly: verification.assembly })
    }
    return rollBackFailedRun(gameDirectory, refuse("output-unverified"))
  }

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
async function rollBackFailedRun(gameDirectory: string, failure: { ok: false; reason: OptimumPatchFailureReason; missingAssembly?: string }): Promise<OptimumPatchResult> {
  const restored = await restoreVanillaBuild(gameDirectory)
  return restored.ok ? { ...failure, rolledBack: true } : failure
}

/**
 * What the live assemblies are, measured against the backups in `.optimum/vanilla/`.
 *
 * A linked official install can be updated in place after Optimum was added: the
 * installer rewrites the game and leaves `.optimum/` where it was, so the backups
 * are the older build's. Writing them back, or patching from them (the patch
 * takes its source from the backup whenever one exists), would put old core
 * assemblies next to the new executable and assets.
 *
 * Each live assembly that has a backup is `patched` when it is gone or unreadable
 * (nothing newer to protect), already equals its backup, hashes to what the patch
 * recorded, or is a managed image that references an Optimum assembly. The last
 * one is what a patch that was killed between two files leaves: a new overlay's
 * assembly next to the old overlay's, under a record that was never rewritten, so
 * its hash matches nothing. A managed image without such a reference that is not
 * the backup is a build the patch never saw: `updated`. Anything else, including
 * a mix of the two, is `unrecognized`.
 */
async function readLiveBuild(gameDirectory: string): Promise<"patched" | "updated" | "unrecognized"> {
  const vanillaFolder = join(gameDirectory, VANILLA_FOLDER)
  const recorded = await readRecordedPatchedHashes(gameDirectory)
  const hash = (path: string): Promise<string | undefined> => sha256File(path).catch(() => undefined)

  let patched = false
  let updated = false
  for (const entry of VANILLA_BACKUPS) {
    const backup = await hash(join(vanillaFolder, entry.backup))
    if (backup === undefined) continue

    const path = join(gameDirectory, entry.live)
    const live = await hash(path)
    if (live === undefined || live === backup) continue
    if (live === recorded.get(entry.live)) {
      patched = true
      continue
    }

    const references = readOptimumAssemblyReferences(await fse.readFile(path).catch(() => Buffer.alloc(0)))
    if (!references) return "unrecognized"
    if (references.length > 0) patched = true
    else updated = true
  }

  if (!updated) return "patched"
  return patched ? "unrecognized" : "updated"
}

/**
 * Copies `from` over `to` without ever leaving `to` half written.
 *
 * The copy goes to a sibling first and is renamed over the target, so a launcher
 * killed mid-copy, or a copy that fails and has libuv unlink its destination
 * (ENOSPC), leaves the target whole: the file that was there, which a second
 * attempt then accepts as the patched build it still is.
 */
async function replaceFile(from: string, to: string): Promise<void> {
  const temporary = `${to}.restore-${randomUUID()}`
  try {
    // fse.copy made the parent folder; a game folder with no Mods/ must still restore.
    await fse.ensureDir(dirname(to))
    await fse.copyFile(from, temporary)
    await fse.rename(temporary, to)
  } catch (error) {
    await fse.remove(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * Puts the four assemblies back, takes the two Optimum assemblies the patch left
 * at the game root back out, and takes the launcher's own marks off.
 *
 * The contracts assembly is always removed. `Optimum.GameContent.dll` is put
 * back from the copy of an earlier file in the vanilla folder when there is one,
 * as in Optimum's own rollback (`RestoreGameContentAsset` in `GamePatcher.cs`),
 * and removed when there is not: the patch writes a marker instead of a copy
 * when the build had no such file, and a build patched by an overlay that never
 * shipped it has nothing to remove. A file with neither is the one place the two
 * differ, Optimum's rollback leaving it and this taking it out, since the file
 * is Optimum's. It is done before the state folder goes, since the copy lives
 * there, so a failure leaves the backups for a second try.
 *
 * Partial by construction, and the dialog says so: the overlaid shaders, the
 * merged language keys and anything else written into `assets/` stay until the
 * build is reinstalled. Undoing those would mean keeping a pristine copy of a
 * gigabyte-sized install, which is not worth the disk to avoid one honest
 * sentence.
 *
 * @param gameDirectory The game folder, already through `assertManagedPath`.
 * @param options `onlyIfPatched` is what Remove Optimum passes. A failed patch
 *   rolling itself back does not, since its live files may be half written. Then
 *   a build the game was updated over in place (every assembly a managed image
 *   with no Optimum reference) is not written over: the backups only hold the
 *   older build, so they are dropped with the Optimum assemblies and `buildUpdated`
 *   says the files were already original. A mix of patched and updated files, or
 *   one that is not a managed image, is refused with `build-unrecognized`.
 */
export async function restoreVanillaBuild(gameDirectory: string, options: { onlyIfPatched?: boolean } = {}): Promise<OptimumPatchResult> {
  const vanillaFolder = join(gameDirectory, VANILLA_FOLDER)

  const present = await Promise.all(VANILLA_BACKUPS.map((entry) => fse.pathExists(join(vanillaFolder, entry.backup))))
  // The same condition the CLI's own rollback refuses on: with neither root
  // assembly backed up there is nothing to restore from, and copying the two mod
  // assemblies alone would leave a build that is neither patched nor vanilla.
  if (VANILLA_BACKUPS.some((entry, index) => entry.required && !present[index])) return refuse("backup-missing")

  const live = options.onlyIfPatched ? await readLiveBuild(gameDirectory) : "patched"
  if (live === "unrecognized") return refuse("build-unrecognized")
  const updated = live === "updated"

  try {
    for (const [index, entry] of VANILLA_BACKUPS.entries()) {
      if (updated || !present[index]) continue
      await replaceFile(join(vanillaFolder, entry.backup), join(gameDirectory, entry.live))
    }

    await fse.remove(join(gameDirectory, OPTIMUM_CONTRACTS_ASSEMBLY))

    const gameContentBackup = join(vanillaFolder, OPTIMUM_GAME_CONTENT_ASSEMBLY)
    const gameContent = join(gameDirectory, OPTIMUM_GAME_CONTENT_ASSEMBLY)
    if (!updated && (await fse.pathExists(gameContentBackup))) await replaceFile(gameContentBackup, gameContent)
    else await fse.remove(gameContent)

    await fse.remove(join(gameDirectory, OPTIMUM_STATE_FOLDER))
  } catch {
    return refuse("restore-failed")
  }

  return updated ? { ok: true, buildUpdated: true } : { ok: true }
}
