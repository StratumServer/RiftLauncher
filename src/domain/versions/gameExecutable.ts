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
 * File names that prove the game landed in a folder, in the order the launcher
 * looks for them.
 *
 * Windows only ever ships `Vintagestory.exe`. Linux ships the native
 * `Vintagestory` launcher and, on older builds, the `Vintagestory.exe` that
 * runs under mono, so either one counts. macOS returns nothing: the launcher
 * cannot run a macOS version yet, so it has no expectation to hold a fresh
 * install to.
 */
export function expectedGameExecutables(os: GameOs): readonly string[] {
  switch (os) {
    case "win32":
      return ["Vintagestory.exe"]
    case "linux":
      return ["Vintagestory", "Vintagestory.exe"]
    case "darwin":
      return []
  }
}

/**
 * How a found executable has to be started.
 *
 * `direct` means the file itself is run. `mono` means the file is a .NET
 * binary that Linux has no loader for, so `mono` has to be put in front of it.
 */
export type GameExecutableLaunchMode = "direct" | "mono"

/** One name from {@link expectedGameExecutables}, paired with how it is launched once found. */
export interface GameExecutableCandidate {
  fileName: string
  launchMode: GameExecutableLaunchMode
}

/**
 * {@link expectedGameExecutables}, paired with how each entry is launched.
 *
 * Windows' `Vintagestory.exe` and Linux's native `Vintagestory` both run
 * directly. The one exception is `Vintagestory.exe` on Linux: it is the same
 * .NET build Windows ships, kept as a fallback for the older versions that
 * never got a native Linux launcher, and Linux can only run it through `mono`.
 * This is strictly additional information: the file names and their order
 * are still exactly what {@link expectedGameExecutables} returns, so a
 * caller that already verifies against that list keeps seeing the same
 * candidates.
 */
export function gameExecutableCandidates(os: GameOs): readonly GameExecutableCandidate[] {
  return expectedGameExecutables(os).map((fileName) => ({
    fileName,
    launchMode: os === "linux" && fileName.endsWith(".exe") ? "mono" : "direct"
  }))
}
