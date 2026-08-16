import { checkInstallationPathExists, logLaunch, preventAppClose, runGame } from "../adapters/launch"

/**
 * The preload-bridge surface MainMenu's PlayHandler and its quick-backup button need.
 *
 * Every dispatch and guard in PlayHandler stays exactly where it was (PR #42's finally-guard
 * included); this only stops the component from calling window.api itself.
 */
export function useLaunchGame(): {
  preventAppClose: typeof preventAppClose
  runGame: typeof runGame
  checkInstallationPathExists: typeof checkInstallationPathExists
  logLaunch: typeof logLaunch
} {
  return { preventAppClose, runGame, checkInstallationPathExists, logLaunch }
}
