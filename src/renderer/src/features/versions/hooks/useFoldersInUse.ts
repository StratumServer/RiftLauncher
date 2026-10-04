import { useMemo } from "react"

import { useGameVersions, useInstallations, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"

/**
 * Every folder the launcher already has a use for: the backups folder, each VS Version and each
 * Installation. A new VS Version may not land on one of them, so the install refuses them and the
 * folder suggestion steers clear of them, both off this one list.
 */
export function useFoldersInUse(): string[] {
  const settings = useSettingsConfig()
  const gameVersions = useGameVersions()
  const installations = useInstallations()

  return useMemo(() => [settings.backupsFolder, ...gameVersions.map((gv) => gv.path), ...installations.map((i) => i.path)], [settings.backupsFolder, gameVersions, installations])
}
