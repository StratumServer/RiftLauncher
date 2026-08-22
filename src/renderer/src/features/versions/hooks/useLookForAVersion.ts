import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useGameVersions, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useLookForAVersion.ts] [useLookForAVersion > addVersion]"

export interface UseLookForAVersionResult {
  /** Folder picked through `detectFolder`. */
  folder: string
  /** Version string, either detected on disk by `detectFolder` or typed in by hand when detection failed. */
  versionFound: string
  /** Opens the OS folder picker and looks for an installed game in what was picked. */
  detectFolder: () => Promise<void>
  /** Overrides `versionFound`, for a build `detectFolder` could not read a version from. */
  setVersionFound: (version: string) => void
  /** Registers `versionFound` at `folder` as an already-installed game version. */
  addVersion: () => Promise<void>
}

/** Owns LookForAVersion's whole flow: picking a folder, detecting a version in it, then registering it. */
export function useLookForAVersion(): UseLookForAVersionResult {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const configDispatch = useConfigDispatch()
  const navigate = useNavigate()

  const [folder, setFolder] = useState<string>("")
  const [versionFound, setVersionFound] = useState<string>("")

  async function detectFolder(): Promise<void> {
    const path = await window.api.utils.selectFolderDialog()
    const selectedPath = path[0]
    if (!selectedPath || selectedPath.length === 0) return

    const res = await window.api.gameManager.lookForAGameVersion(selectedPath)

    setFolder(selectedPath)

    if (!res.exists) {
      setVersionFound("")
      addNotification(t("features.versions.noVersionFoundOnThatFolder"), "info")
      return
    }

    setVersionFound(res.installedGameVersion)
  }

  async function addVersion(): Promise<void> {
    try {
      // Trimmed before the guard, not just before the write: a hand-typed version that is
      // only spaces is falsy to a person and truthy to `!versionFound`, so without this it
      // sailed past the guard and got registered whitespace and all, which then failed to
      // match the same version typed cleanly anywhere else.
      const version = versionFound.trim()

      if (!folder || !version) return addNotification(t("features.versions.missingFolderOrVersion"), "error")

      if (gameVersions.some((gv) => gv.version === version)) return addNotification(t("features.versions.versionAlreadyInstalled", { version }), "error")

      const newGameVersion: GameVersionType = {
        version,
        path: folder,
        linked: true
      }

      configDispatch({ type: CONFIG_ACTIONS.ADD_GAME_VERSION, payload: newGameVersion })
      addNotification(t("features.versions.versionSuccessfullyAdded", { version }), "success")
      navigate("/versions")
    } catch (err) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error looking for a version.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error looking for a version: ${err}`)
    } finally {
      setFolder("")
      setVersionFound("")
    }
  }

  return { folder, versionFound, detectFolder, setVersionFound, addVersion }
}
