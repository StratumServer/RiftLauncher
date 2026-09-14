/**
 * How the Optimum flow's refusals reach the player.
 *
 * Same shape as `describeInstallFailure` next door: one i18n key per reason,
 * and a flag for whether the refusal is also worth a line in the log. Nothing
 * here ever renders a string the CLI wrote, because nothing here is ever handed
 * one: what crosses the bridge is a token out of a closed set.
 */

export interface OptimumFailureFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/**
 * Why the manifest could not be read, in one calm line.
 *
 * All three are normal states rather than errors: the page disables the Optimum
 * choice and says which one it is, instead of showing a failure for something
 * the player did not ask for.
 */
export function describeOptimumManifestFailure(reason: OptimumManifestFailureReason): string {
  switch (reason) {
    case "unsupported-system":
      return "features.versions.optimumNoBuildForSystem"
    case "unreadable":
      return "features.versions.optimumListUnreadable"
    case "unreachable":
      return "features.versions.optimumListUnreachable"
  }
}

/**
 * Why a patch or a restore did not happen.
 *
 * The CLI's own tokens are grouped where grouping them tells the player the
 * same thing: `decompile-failed`, `assemble-failed` and `verification-failed`
 * are all "Optimum could not patch this build", and none of them is something a
 * player acts on differently. The ones that are kept apart are the ones that
 * point at something they can do: install a runtime, pick another version, try
 * again later.
 */
export function describeOptimumFailure(reason: OptimumPatchFailureReason): OptimumFailureFeedback {
  switch (reason) {
    case "runtime-missing":
      return { messageKey: "features.versions.optimumRuntimeMissing", logged: false }
    case "unsupported-version":
      return { messageKey: "features.versions.optimumNoBuildForVersion", logged: false }
    case "manifest-unavailable":
      return { messageKey: "features.versions.optimumListUnreachable", logged: false }
    case "overlay-unverified":
      return { messageKey: "features.versions.optimumOverlayUnverified", logged: true }
    case "cancelled":
    case "timed-out":
      return { messageKey: "features.versions.optimumPatchStopped", logged: true }
    case "backup-missing":
      return { messageKey: "features.versions.optimumNoVanillaBackup", logged: false }
    case "restore-failed":
      return { messageKey: "features.versions.optimumRestoreFailed", logged: true }
    case "output-unverified":
      return { messageKey: "features.versions.optimumOutputUnverified", logged: true }
    default:
      return { messageKey: "features.versions.optimumPatchFailed", logged: true }
  }
}
