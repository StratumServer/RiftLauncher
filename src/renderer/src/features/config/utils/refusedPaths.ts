/**
 * Takes out of the renderer's config state what SAVE_CONFIG refused, so one refused path stops
 * being sent again with every later save.
 *
 * The renderer saves its whole state on every change. A path main refuses once (a folder the
 * player picked more than ten minutes before it was used, say) would otherwise ride along in all
 * the saves after it and get each of them refused too, Installations, logins and settings
 * included, until the next start threw them all away. Pulled out of ConfigContext.tsx so the
 * decision can be pinned without mounting the provider tree.
 */

export type KeptFolders = Pick<ConfigType, "defaultInstallationsFolder" | "defaultVersionsFolder" | "backupsFolder">

const FOLDER_KEYS = ["defaultInstallationsFolder", "defaultVersionsFolder", "backupsFolder"] as const

export interface DropRefusedPathsResult {
  /** The state without the refused entries. The same object when nothing in it was refused. */
  config: ConfigType
  /** What was dropped, as the player knows it: a version's name, an Installation's name, or the path itself. */
  names: string[]
  /** The refused paths that were actually dropped, so a late answer naming them again can be told apart from a new refusal. */
  dropped: string[]
}

/**
 * @param refusedPaths The paths SAVE_CONFIG named in its `unauthorized-path` answer.
 * @param kept The three folders as main holds them. A refused folder goes back to these, since a
 *   folder setting has no list to be dropped from. Without them a refused folder stays where it is.
 */
export function dropRefusedPaths(config: ConfigType, refusedPaths: readonly string[], kept: KeptFolders | null): DropRefusedPathsResult {
  const refused = new Set(refusedPaths)
  const names: string[] = []
  const dropped: string[] = []
  const isRefused = (path: string, name: string): boolean => {
    if (!refused.has(path)) return false
    names.push(name)
    dropped.push(path)
    return true
  }

  const gameVersions = config.gameVersions.filter((gameVersion) => !isRefused(gameVersion.path, gameVersion.label || gameVersion.version))
  const installations = config.installations
    .filter((installation) => !isRefused(installation.path, installation.name))
    .map((installation) => {
      const backups = installation.backups.filter((backup) => !isRefused(backup.path, backup.path))
      const worldBackups = installation.worldBackups?.filter((backup) => !isRefused(backup.path, backup.path))
      return backups.length === installation.backups.length && worldBackups?.length === installation.worldBackups?.length ? installation : { ...installation, backups, worldBackups }
    })

  const folders: Partial<KeptFolders> = {}
  // Only a folder that really goes back: one that main also holds would be refused again forever.
  if (kept) for (const key of FOLDER_KEYS) if (kept[key] !== config[key] && isRefused(config[key], config[key])) folders[key] = kept[key]

  if (names.length === 0) return { config, names, dropped }
  return { config: { ...config, gameVersions, installations, ...folders }, names, dropped }
}
