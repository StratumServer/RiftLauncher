import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { folderIsInUse } from "@domain/paths"
import { installGameVersion } from "@domain/versions/install"
import { isInterruptedInstall } from "@domain/versions/interruptedInstall"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useGameVersions, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { createInstallPorts, describeInstallFailure, toDownloadableGameVersion } from "@renderer/features/versions/adapters/install"
import { useFoldersInUse } from "@renderer/features/versions/hooks/useFoldersInUse"
import { useOptimumActions } from "@renderer/features/versions/hooks/useOptimumActions"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useInstallVersion.ts] [useInstallVersion > installVersion]"

/**
 * Runs AddVersion's install flow: registers the version optimistically, runs
 * the download/unpack service, then reconciles config on success or discard.
 *
 * `version` is optional because the page can still be waiting on the catalog
 * or have nothing selected; the missing-selection notification is the same
 * one the page used to raise itself.
 *
 * `optimum` is the published overlay when the player picked that build instead
 * of the official one. The vanilla install runs first and unchanged either way:
 * Optimum patches a build the launcher downloaded itself, so a refused patch
 * leaves a working official build on the list rather than nothing at all.
 */
export function useInstallVersion(): (version: DownloadableGameVersionTypeType | undefined, folder: string, optimum?: OptimumManifestInfo) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installedGameVersions = useGameVersions()
  const foldersInUse = useFoldersInUse()
  const configDispatch = useConfigDispatch()
  const { startDownload, startExtract, startInstall } = useTaskContext()
  const { applyOptimum } = useOptimumActions()
  const navigate = useNavigate()

  return async function installVersion(version, folder, optimum) {
    if (!version) return addNotification(t("features.versions.noVersionSelected"), "error")

    const folderName = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder
    const ports = createInstallPorts({
      startDownload,
      startExtract,
      startInstall,
      taskName: `${t("features.versions.gameVersionTaskName", { version: version.version })} (${folderName})`,
      downloadDescription: t("features.versions.gameVersionDownloadDesc", { version: version.version }),
      unpackDescription: t("features.versions.gameVersionExtractDesc", { version: version.version })
    })
    const platform = await window.api.utils.getOs()
    const pathPlatform = platform === "win32" ? "win32" : "posix"

    // The same version into the same folder as an install that was cut off: that row is picked
    // up again instead of refused as "already installed", and keeps its id so the Installations
    // pointing at it stay pointed at it.
    const interrupted = installedGameVersions.find((gv) => isInterruptedInstall(gv) && gv.version === version.version && folderIsInUse(folder, [gv.path], pathPlatform))
    const gameVersionId = interrupted?.id ?? crypto.randomUUID()
    const others = interrupted ? installedGameVersions.filter((gv) => gv.id !== interrupted.id) : installedGameVersions

    const result = await installGameVersion(
      ports,
      {
        platform,
        version: toDownloadableGameVersion(version),
        targetFolder: folder,
        installedVersions: others.map((gv) => ({ version: gv.version, path: gv.path })),
        foldersInUse: interrupted ? foldersInUse.filter((used) => !folderIsInUse(used, [interrupted.path], pathPlatform)) : foldersInUse
      },
      {
        onRegistered: () => {
          // `incomplete` is what reaches config.json: it stays until the install is seen to finish.
          if (interrupted) configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: gameVersionId, updates: { _installing: true } } })
          else
            configDispatch({
              type: CONFIG_ACTIONS.ADD_GAME_VERSION,
              payload: { id: gameVersionId, label: version.version, version: version.version, path: folder, _installing: true, incomplete: true }
            })
          navigate("/versions")
        },
        onInstalled: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: gameVersionId, updates: { _installing: undefined, incomplete: undefined } } }),
        // A row picked up again stays on the list as an interrupted install, so a second failure
        // does not strand the Installations that still point at it.
        onDiscarded: () =>
          configDispatch(
            interrupted
              ? { type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: gameVersionId, updates: { _installing: undefined } } }
              : { type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { id: gameVersionId } }
          )
      }
    )

    if (result.ok) {
      if (optimum) await applyOptimum({ id: gameVersionId, path: folder, version: version.version }, optimum)
      return
    }

    const { messageKey, logged } = describeInstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error installing VS Version ${version.version}.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error installing VS Version ${version.version}: ${result.reason}.`)
    }

    addNotification(t(messageKey, { version: version.version, folder }), "error")
  }
}
