/**
 * Builds the command that starts one installation of Vintage Story.
 *
 * This is the decision EXECUTE_GAME has always made inline: pick the executable
 * {@link gameExecutableCandidates} expects for the host platform, decide whether
 * it runs directly or through `mono`, and put the installation's data folder and
 * start parameters behind it. Reusing that table keeps the launch path in
 * lockstep with {@link ./detect} and {@link ./install}, so the three can never
 * drift on what a Vintage Story folder looks like or how its executable runs.
 *
 * Nothing here starts anything. The plan is data: a command, its arguments, the
 * environment variables this platform adds, and the folder the process runs in.
 * The host spawns it through the `GameProcess` port, which is also where the
 * executable is checked for being a real file rather than a symlink pointing
 * somewhere else.
 *
 * ## Parity notes
 *
 * Three details are inherited rather than chosen, and are pinned by tests
 * because changing any of them changes what a player's game does:
 *
 * - The start parameters go in as ONE argument, whatever they contain. They are
 *   not split on spaces, so `--foo --bar` reaches the game as a single argv
 *   entry. They are also always passed, so an installation with none gives the
 *   game one empty argument.
 * - Under `mono` the executable path leads the argument list, ahead of
 *   `--dataPath`.
 * - {@link MESA_GL_THREAD_VARIABLE} is set for the native Linux launcher only.
 *   The mono fallback never got it, and neither did Windows.
 */

import type { PathBuilder } from "../ports"
import { gameExecutableCandidates } from "./gameExecutable"
import type { GameOs } from "./gameExecutable"

/**
 * The variable the launcher sets for the "Mesa GL thread" checkbox.
 *
 * Lowercase, because that is the name Mesa's driconf override actually reads
 * from the environment. The launcher inherited the uppercase spelling,
 * MESA_GLTHREAD, from VS Launcher; Linux environment variables are case
 * sensitive, so that spelling set a variable Mesa never looked at, meaning
 * the checkbox has in all likelihood never done anything. Mesa 23.1+ already
 * enables glthread by default for many applications, so this mostly matters
 * on older Mesa or for apps Mesa does not whitelist.
 */
export const MESA_GL_THREAD_VARIABLE = "mesa_glthread"

/**
 * Why no command was built.
 *
 * `unsupported-platform` covers macOS, where the launcher cannot run the game
 * yet, and every platform it does not recognise at all. `no-executable` means
 * the version folder holds none of {@link gameExecutableCandidates}.
 */
export type BuildGameLaunchPlanFailure = "unsupported-platform" | "no-executable"

/** Everything the host needs to start the game, and nothing it has to decide. */
export interface GameLaunchPlan {
  /** What is spawned: the game itself, or `mono` when the game needs a loader. */
  command: string
  /** Arguments passed to `command`, in order. */
  args: string[]
  /**
   * The game file itself, which is {@link command} unless the plan runs it
   * through `mono`. Named separately so the host can check the real executable
   * without having to work out which of the two it is.
   */
  executablePath: string
  /** Variables this platform adds. Merged on top of whatever the host already gives the process. */
  env: Record<string, string>
  /** Folder the game runs in, which is the version folder. */
  cwd: string
}

export type BuildGameLaunchPlanResult = { ok: true; plan: GameLaunchPlan } | { ok: false; reason: BuildGameLaunchPlanFailure }

export interface BuildGameLaunchPlanPorts {
  paths: PathBuilder
}

export interface BuildGameLaunchPlanInput {
  /** Host platform, as the host spells it. */
  platform: string
  /** Folder the game version is installed in. */
  versionFolder: string
  /** Names directly inside that folder, as listed by the host. */
  fileNames: readonly string[]
  /** The installation's data folder, which the game is pointed at with `--dataPath`. */
  installationPath: string
  /** Extra arguments the user typed for this installation. Passed through untouched. */
  startParams: string
  /** True when the installation asks for {@link MESA_GL_THREAD_VARIABLE}. */
  mesaGlThread: boolean
}

/**
 * The platforms the launcher can start the game on.
 *
 * Deliberately NOT `toGameOs`, which the download and detection paths use to
 * treat every unknown platform as Linux. Guessing is fine when it only picks a
 * URL to try; here it would spawn a process on a system the launcher has never
 * been run on. macOS is left out for the same reason it always has been: no
 * macOS launch has ever been implemented.
 */
function launchableOs(platform: string): GameOs | undefined {
  if (platform === "linux") return "linux"
  if (platform === "win32") return "win32"
  return undefined
}

/**
 * Works out how to start one installed version.
 *
 * @param ports Host capabilities the work runs on.
 * @param input The version folder and its contents, the installation, and the host platform.
 * @returns The plan to spawn, or the reason there is none.
 */
export async function buildGameLaunchPlan(ports: BuildGameLaunchPlanPorts, input: BuildGameLaunchPlanInput): Promise<BuildGameLaunchPlanResult> {
  const os = launchableOs(input.platform)
  if (!os) return { ok: false, reason: "unsupported-platform" }

  const candidate = gameExecutableCandidates(os).find((entry) => input.fileNames.includes(entry.fileName))
  if (!candidate) return { ok: false, reason: "no-executable" }

  const executablePath = await ports.paths.join([input.versionFolder, candidate.fileName])
  const gameArgs = [`--dataPath=${input.installationPath}`, input.startParams]
  const runsUnderMono = candidate.launchMode === "mono"

  return {
    ok: true,
    plan: {
      command: runsUnderMono ? "mono" : executablePath,
      args: runsUnderMono ? [executablePath, ...gameArgs] : gameArgs,
      executablePath,
      env: !runsUnderMono && os === "linux" && input.mesaGlThread ? { [MESA_GL_THREAD_VARIABLE]: "true" } : {},
      cwd: input.versionFolder
    }
  }
}
