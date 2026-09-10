import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { installGameVersion } from "@domain/versions/install"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useGameVersions, useInstallations, useSettingsConfig, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { createInstallPorts, describeInstallFailure, toDownloadableGameVersion } from "@renderer/features/versions/adapters/install"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useInstallVersion.ts] [useInstallVersion > installVersion]"

/**
 * Runs AddVersion's install flow: registers the version optimistically, runs
 * the download/unpack service, then reconciles config on success or discard.
 *
 * `version` is optional because the page can still be waiting on the catalog
 * or have nothing selected; the missing-selection notification is the same
 * one the page used to raise itself.
 */
export function useInstallVersion(): (version: DownloadableGameVersionTypeType | undefined, folder: string) => Promise<void> {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const installedGameVersions = useGameVersions()
  const installations = useInstallations()
  const settings = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const { startDownload, startExtract, startInstall } = useTaskContext()
  const navigate = useNavigate()

  return async function installVersion(version, folder) {
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
    const gameVersionId = crypto.randomUUID()

    const result = await installGameVersion(
      ports,
      {
        platform: await window.api.utils.getOs(),
        version: toDownloadableGameVersion(version),
        targetFolder: folder,
        installedVersions: installedGameVersions.map((gv) => ({ version: gv.version, path: gv.path })),
        foldersInUse: [settings.backupsFolder, ...installedGameVersions.map((gv) => gv.path), ...installations.map((i) => i.path)]
      },
      {
        onRegistered: () => {
          configDispatch({ type: CONFIG_ACTIONS.ADD_GAME_VERSION, payload: { id: gameVersionId, label: version.version, version: version.version, path: folder, _installing: true } })
          navigate("/versions")
        },
        onInstalled: () => configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: gameVersionId, updates: { _installing: undefined } } }),
        onDiscarded: () => configDispatch({ type: CONFIG_ACTIONS.DELETE_GAME_VERSION, payload: { id: gameVersionId } })
      }
    )

    if (result.ok) return

    const { messageKey, logged } = describeInstallFailure(result.reason)

    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Error installing VS Version ${version.version}.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Error installing VS Version ${version.version} in target folder ${folderName}: ${result.reason}.`)
    }

    addNotification(t(messageKey, { version: version.version, folder }), "error")
  }
}
