/**
 * What an installed Vintage Story folder looks like, per platform.
 *
 * The names come from the launcher itself: EXECUTE_GAME and
 * LOOK_FOR_A_GAME_VERSION already decide how to run a version by reading the
 * folder, and this module states the same expectation as plain data so the
 * install flow can check it before calling the job done.
 */

/** The platforms the launcher builds a download decision for. */
export type GameOs = "win32" | "darwin" | "linux"

/**
 * Narrows a host platform string down to the three the launcher knows.
 *
 * Everything that is neither Windows nor macOS is treated as Linux, which is
 * what the add-version page has always done when picking a download URL.
 */
export function toGameOs(platform: string): GameOs {
  if (platform === "win32") return "win32"
  if (platform === "darwin") return "darwin"
  return "linux"
}

/**
 * How a found executable has to be started.
 *
 * `direct` means the file itself is run. `mono` means the file is a .NET
 * binary that Linux has no loader for, so `mono` has to be put in front of it.
 */
export type GameExecutableLaunchMode = "direct" | "mono"

/** A file name that proves the game landed in a folder, paired with how it is launched. */
export interface GameExecutableCandidate {
  fileName: string
  launchMode: GameExecutableLaunchMode
}

/**
 * File names that prove the game landed in a folder, in the order the launcher
 * looks for them, each paired with how it has to be started.
 *
 * Windows only ever ships `Vintagestory.exe`, which runs directly. Linux ships
 * the native `Vintagestory` launcher and, on older builds, the same .NET
 * `Vintagestory.exe` Windows ships, kept as a fallback for the versions that
 * never got a native Linux launcher; Linux can only run that one through
 * `mono`. macOS returns nothing: the launcher cannot run a macOS version yet,
 * so it has no expectation to hold a fresh install to.
 */
export function gameExecutableCandidates(os: GameOs): readonly GameExecutableCandidate[] {
  switch (os) {
    case "win32":
      return [{ fileName: "Vintagestory.exe", launchMode: "direct" }]
    case "linux":
      return [
        { fileName: "Vintagestory", launchMode: "direct" },
        { fileName: "Vintagestory.exe", launchMode: "mono" }
      ]
    case "darwin":
      return []
  }
}
