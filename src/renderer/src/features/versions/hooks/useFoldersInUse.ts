import { useMemo } from "react"

import { isInterruptedInstall } from "@domain/versions/interruptedInstall"
import { useGameVersions, useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"

/**
 * Every folder the launcher already has a use for: the backups folder, each VS Version and each
 * Installation. A new VS Version may not land on one of them, so the install refuses them and the
 * folder suggestion steers clear of them, both off this one list.
 *
 * `reusableVersion` names a VS Version whose interrupted installs (#710) are left off the list: the
 * folder of a cut off install is not taken by anyone, and the suggestion lands on it so Install
 * picks that row up again instead of adding a second one beside it.
 */
export function useFoldersInUse(reusableVersion?: string): string[] {
  const settings = useSettingsConfig()
  const gameVersions = useGameVersions()
  const installations = useInstallations()

  return useMemo(
    () => [
      settings.backupsFolder,
      ...gameVersions.filter((gv) => !(reusableVersion !== undefined && gv.version === reusableVersion && isInterruptedInstall(gv))).map((gv) => gv.path),
      ...installations.map((i) => i.path)
    ],
    [settings.backupsFolder, gameVersions, installations, reusableVersion]
  )
}
