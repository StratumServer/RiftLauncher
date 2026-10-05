/**
 * Which builds Optimum can be offered for, where its overlay comes from, and
 * how its CLI is called.
 *
 * Every URL here is built by the launcher out of fields that have already
 * passed {@link parseOptimumManifest}'s checks, never taken from a URL field in
 * a document downloaded off the internet. That is the whole reason this module
 * exists rather than the manifest carrying a link: a string from GitHub is
 * never used as an address.
 */

import semver from "semver"

import type { OptimumManifest, OptimumRid } from "./manifest"

/** The manifest filename published for one supported platform. */
export function optimumManifestFileName(rid: OptimumRid): string {
  return `optimum-manifest-${rid}.json`
}

/** Where the newest manifest for one supported platform is read from. */
export function optimumManifestDownloadUrl(rid: OptimumRid): string {
  return `https://github.com/StratumServer/Optimum/releases/latest/download/${optimumManifestFileName(rid)}`
}

/**
 * The folder a patched build keeps Optimum's own state in, and the folder under
 * it holding the untouched assemblies.
 *
 * Spelled here rather than beside the verification passes because both sides
 * need it: the main process restores out of it, and the VS Versions page asks
 * whether it is there before offering to.
 */
export const OPTIMUM_STATE_FOLDER = ".optimum"

/** Where the patch keeps its copy of the untouched assemblies, under {@link OPTIMUM_STATE_FOLDER}. */
export const OPTIMUM_VANILLA_FOLDER = "vanilla"

/** The assembly Optimum patches have required since the first published overlay. */
export const OPTIMUM_CONTRACTS_ASSEMBLY = "Optimum.Api.Contracts.dll"

/** The assembly referenced by patched VSEssentials since overlay packaging began. */
export const OPTIMUM_GAME_CONTENT_ASSEMBLY = "Optimum.GameContent.dll"

/**
 * Files that every supported Optimum overlay requires at the game root.
 *
 * Patched VSEssentials has referenced GameContent since overlays first shipped.
 * Releases 0.3.18 and 0.3.19 both omit that file; it is included starting with
 * the release after Optimum#131.
 */
export const OPTIMUM_DEPLOYED_ASSEMBLIES = [OPTIMUM_CONTRACTS_ASSEMBLY, OPTIMUM_GAME_CONTENT_ASSEMBLY] as const

/** Game-relative folders the launcher checks for required assemblies. */
export const OPTIMUM_ASSEMBLY_SEARCH_FOLDERS = ["", "Lib", "Mods"] as const

/**
 * Files required by every Optimum row, including rows whose version or backup
 * state is unknown. The published version number does not change the references
 * VSEssentials carries.
 */
export function requiredOptimumAssemblies(_optimumVersion?: string): readonly string[] {
  return OPTIMUM_DEPLOYED_ASSEMBLIES
}

/**
 * The runtime identifier for a host, or undefined when Optimum publishes no
 * overlay for it.
 *
 * macOS is deliberately absent, and so is every architecture but x64: an
 * overlay is a per-platform payload, and offering one for a platform it was not
 * built for would hand the player a patch that cannot run.
 */
export function hostRid(platform: string, architecture: string): OptimumRid | undefined {
  if (architecture !== "x64") return undefined
  if (platform === "linux") return "linux-x64"
  if (platform === "win32") return "win-x64"
  return undefined
}

/**
 * True when this overlay was published for `gameVersion`.
 *
 * Takes the one field it reads rather than a whole manifest, so the main
 * process can ask it of the document it parsed and the renderer can ask it of
 * the trimmed shape that crosses the bridge, with one rule between them.
 */
export function supportsGameVersion(manifest: Pick<OptimumManifest, "supportedGameVersions">, gameVersion: string): boolean {
  const version = semver.valid(gameVersion)
  return version !== null && manifest.supportedGameVersions.includes(version)
}

/**
 * Where the overlay archive is downloaded from.
 *
 * Built from the tag the version implies and the file name the manifest already
 * had to spell exactly, so the two halves of the address are the two fields the
 * parser refused to guess at.
 */
export function overlayDownloadUrl(manifest: OptimumManifest): string {
  return `https://github.com/StratumServer/Optimum/releases/download/v${manifest.optimumVersion}/${manifest.archive.filename}`
}

/**
 * The cache folder one overlay is staged into, one per version and platform.
 *
 * The archive's single wrapping folder is stepped into on the way out, the same
 * way a game build's `vintagestory/` is, so this folder is what `--overlay` is
 * pointed at rather than a child of it.
 */
export function overlayCacheFolder(manifest: OptimumManifest): string {
  return `${manifest.optimumVersion}-${manifest.rid}`
}

/**
 * True when `manifest` publishes a newer overlay that still supports the build
 * the player has.
 *
 * Both halves matter. A newer overlay that dropped the game version is not an
 * update for that row, it is an overlay for a build the player does not have,
 * and offering it would patch a version Optimum never claimed.
 */
export function isUpdateAvailable(installedOverlayVersion: string, gameVersion: string, manifest: Pick<OptimumManifest, "optimumVersion" | "supportedGameVersions">): boolean {
  const installed = semver.valid(installedOverlayVersion)
  if (!installed) return false
  return semver.gt(manifest.optimumVersion, installed) && supportsGameVersion(manifest, gameVersion)
}

/**
 * The argument list for one patch run.
 *
 * `--no-backup` is never emitted, and that is the one thing about this list
 * worth remembering: without a backup the second run patches an
 * already-patched assembly, and with one every later run patches from
 * `.optimum/vanilla/` instead, which is what makes the update converge rather
 * than compound.
 *
 * Both paths have to be absolute or the CLI refuses the run as `bad-input`.
 */
export function patchArgs(gameDirectory: string, overlayDirectory: string): string[] {
  return ["patch", "--game-dir", gameDirectory, "--overlay", overlayDirectory, "--json"]
}

/** The argument list for the rollback run, which restores the four assemblies out of `.optimum/vanilla/`. */
export function rollbackArgs(gameDirectory: string): string[] {
  return ["patch", "--game-dir", gameDirectory, "--rollback", "--json"]
}

/** The CLI's own name inside the overlay folder. */
export function cliFileName(platform: string): string {
  return platform === "win32" ? "optimum.exe" : "optimum"
}
