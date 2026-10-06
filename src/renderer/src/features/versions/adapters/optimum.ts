/**
 * How the Optimum flow's refusals reach the player.
 *
 * Same shape as `describeInstallFailure` next door: one i18n key per reason,
 * and a flag for whether the refusal is also worth a line in the log. The bridge carries a reason from a closed set. A missing-assembly message
 * also interpolates the bounded Optimum assembly name read from CLR metadata.
 */

export interface OptimumFailureFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
  /** Safe interpolation values for a failure message. */
  values?: Record<string, string>
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
    case "not-published":
      return "features.versions.optimumListNotPublished"
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
 *
 * A run the launcher rolled back afterwards is one line whatever stopped it.
 * What a player needs from that sentence is the state of their build, and every
 * one of those runs ends the same way: the original game files are back.
 *
 * That is a claim about the folder, so it is only made once `rolledBack` says it
 * happened. A rollback that fails leaves the run's own reason in place with the
 * flag unset, and the folder still holding the patched assemblies, the Optimum
 * contracts and the `.optimum` folder, which the row reports as missing Optimum
 * files with a Remove Optimum action. Telling that player their files were put
 * back sends them looking for a problem that is not the one they have.
 */
export function describeOptimumFailure(failure: { reason: OptimumPatchFailureReason; rolledBack?: boolean; missingAssembly?: string }): OptimumFailureFeedback {
  if (failure.reason === "missing-assembly" && failure.missingAssembly) {
    // The only refusal whose sentence names a state of the folder rather than
    // the run, so the assembly is only worth naming once the restore is known
    // to have happened. Without it the sentence that is true is the restore one.
    return failure.rolledBack
      ? { messageKey: "features.versions.optimumMissingRequiredAssembly", logged: true, values: { assembly: failure.missingAssembly } }
      : { messageKey: "features.versions.optimumRestoreFailed", logged: true }
  }
  if (failure.rolledBack) return { messageKey: "features.versions.optimumRolledBack", logged: true }

  switch (failure.reason) {
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
