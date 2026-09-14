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

import { expectedOverlayFolderName, type OptimumManifest, type OptimumRid } from "./manifest"

/** Where the manifest of the newest published overlay is read from. One fixed address, no listing call. */
export const OPTIMUM_MANIFEST_URL = "https://github.com/StratumServer/Optimum/releases/latest/download/optimum-manifest.json"

/** The name the manifest is saved under in the cache. */
export const OPTIMUM_MANIFEST_FILE_NAME = "optimum-manifest.json"

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

/** True when this overlay was published for `gameVersion`. */
export function supportsGameVersion(manifest: OptimumManifest, gameVersion: string): boolean {
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

/** The cache folder one overlay is staged into, one per version and platform. */
export function overlayCacheFolder(manifest: OptimumManifest): string {
  return `${manifest.optimumVersion}-${manifest.rid}`
}

/** The folder the archive unpacks into, which is what `--overlay` is pointed at. */
export function overlayFolderName(manifest: OptimumManifest): string {
  return expectedOverlayFolderName(manifest.optimumVersion, manifest.rid)
}

/**
 * True when `manifest` publishes a newer overlay that still supports the build
 * the player has.
 *
 * Both halves matter. A newer overlay that dropped the game version is not an
 * update for that row, it is an overlay for a build the player does not have,
 * and offering it would patch a version Optimum never claimed.
 */
export function isUpdateAvailable(installedOverlayVersion: string, gameVersion: string, manifest: OptimumManifest): boolean {
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
