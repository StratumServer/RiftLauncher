import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { buildGameVersionLabel } from "@domain/naming"
import { folderIsInUse } from "@domain/paths"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useGameVersions, useConfigDispatch, useWaitForSave } from "@renderer/features/config/contexts/ConfigContext"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useLookForAVersion.ts] [useLookForAVersion > addVersion]"

export interface UseLookForAVersionResult {
  /** Folder picked through `detectFolder`. */
  folder: string
  /** Version string, either detected on disk by `detectFolder` or typed in by hand when detection failed. */
  versionFound: string
  /** Display label for the registered build; defaults to the detected version. */
  label: string
  /** Opens the OS folder picker and looks for an installed game in what was picked. */
  detectFolder: () => Promise<void>
  /** Overrides `versionFound`, for a build `detectFolder` could not read a version from. */
  setVersionFound: (version: string) => void
  /** Overrides the display label without changing the technical version number. */
  setLabel: (label: string) => void
  /** Registers `versionFound` at `folder` as an already-installed game version. */
  addVersion: () => Promise<void>
}

/** Owns LookForAVersion's whole flow: picking a folder, detecting a version in it, then registering it. */
export function useLookForAVersion(): UseLookForAVersionResult {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const gameVersions = useGameVersions()
  const configDispatch = useConfigDispatch()
  const waitForSave = useWaitForSave()
  const navigate = useNavigate()

  const [folder, setFolder] = useState<string>("")
  const [versionFound, setVersionFound] = useState<string>("")
  const [label, setLabel] = useState<string>("")

  async function detectFolder(): Promise<void> {
    const path = await window.api.utils.selectFolderDialog()
    const selectedPath = path[0]
    if (!selectedPath || selectedPath.length === 0) return

    const res = await window.api.gameManager.lookForAGameVersion(selectedPath)

    setFolder(selectedPath)

    if (!res.exists) {
      setVersionFound("")
      setLabel("")
      addNotification(t("features.versions.noVersionFoundOnThatFolder"), "info")
      return
    }

    setVersionFound(res.installedGameVersion)
    setLabel(buildGameVersionLabel(res.installedGameVersion, res.variant))
  }

  async function addVersion(): Promise<void> {
    try {
      // Trimmed before the guard, not just before the write: a hand-typed version that is
      // only spaces is falsy to a person and truthy to `!versionFound`, so without this it
      // sailed past the guard and got registered whitespace and all, which then failed to
      // match the same version typed cleanly anywhere else.
      const version = versionFound.trim()
      const displayLabel = label.trim() || version

      if (!folder || !version) return addNotification(t("features.versions.missingFolderOrVersion"), "error")

      const platform = (await window.api.utils.getOs()) === "win32" ? "win32" : "posix"

      if (
        folderIsInUse(
          folder,
          gameVersions.map((gv) => gv.path),
          platform
        )
      )
        return addNotification(t("features.versions.folderAlreadyInUse", { version }), "error")

      // Main trusts a picked folder for ten minutes only, and refuses to save a version whose folder
      // it no longer trusts. The same call that looked at the folder after the pick fails once that
      // time is up, so ask again here and send the player back to pick it, rather than list a
      // version that would never be saved.
      try {
        await window.api.gameManager.lookForAGameVersion(folder)
      } catch {
        return addNotification(t("features.versions.pickFolderAgain"), "error")
      }

      const newGameVersion: GameVersionType = {
        id: crypto.randomUUID(),
        version,
        label: displayLabel,
        path: folder,
        linked: true
      }

      const saved = waitForSave((config) => config.gameVersions.some((gameVersion) => gameVersion.id === newGameVersion.id))
      configDispatch({ type: CONFIG_ACTIONS.ADD_GAME_VERSION, payload: newGameVersion })
      if (!(await saved)) {
        // A refusal has already dropped the row; any other failure (the write itself, a read-only
        // session) leaves it listed, to be saved by the next write that works. Take it out so that
        // "wasn't added" is true and the folder can be added again.
        configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { id: newGameVersion.id } })
        return addNotification(t("features.versions.versionNotSaved"), "error")
      }

      addNotification(t("features.versions.versionSuccessfullyAdded", { version }), "success")
      navigate("/versions")
    } catch (err) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error looking for a version.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error looking for a version: ${err}`)
    } finally {
      setFolder("")
      setVersionFound("")
      setLabel("")
    }
  }

  return { folder, versionFound, label, detectFolder, setVersionFound, setLabel, addVersion }
}
