import { DEFAULT_RECEIVE_BETA_UPDATES } from "../appUpdate/betaUpdates"
import { DEFAULT_BACKGROUND_ID } from "../backgrounds"
import { DEFAULT_MODDB_VISIBILITY_ANSWER } from "../moddbVisibility"

/**
 * Everything a fresh config holds that does not depend on the host.
 *
 * The four fields left out are the ones only the main process can answer: the schema version,
 * which the migration runner owns, and the three folder paths, which come from Electron's appData
 * location. The main process spreads this into its default config and the renderer spreads it into
 * the reducer's initial state, so the two cannot drift apart field by field the way they had.
 */
export const DEFAULT_CONFIG_BASE: Omit<ConfigType, "schemaVersion" | "defaultInstallationsFolder" | "defaultVersionsFolder" | "backupsFolder"> = {
  lastUsedInstallation: null,
  window: {
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
    maximized: false
  },
  accounts: [],
  activeAccountId: null,
  installations: [],
  gameVersions: [],
  favMods: [],
  suspendedModUpdates: [],
  background: DEFAULT_BACKGROUND_ID,
  moddbVisibilityAnswer: DEFAULT_MODDB_VISIBILITY_ANSWER,
  receiveBetaUpdates: DEFAULT_RECEIVE_BETA_UPDATES,
  customIcons: []
}

/**
 * The compression level a backup uses when nobody picked one.
 *
 * 6 is what every Installation created in the launcher gets, since it is what the add form
 * proposes, and 6 is also zlib's own default, as it was 7-Zip's back when a backup was a zip
 * written by one. The 0 to 9 scale means the same thing to both, so the number carried over
 * untouched. It used to be spelled 4 in the config normalizer
 * and in the compress IPC handler, which meant an Installation from before the setting existed
 * quietly compressed at a different level than the form said it would.
 */
export const DEFAULT_COMPRESSION_LEVEL = 6
