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
