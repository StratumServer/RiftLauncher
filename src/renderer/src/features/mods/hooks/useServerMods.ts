import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { createFileSystemPort } from "@renderer/adapters/fileSystem"
import { fetchServerMods } from "@renderer/features/moddb/adapters/modsManager"
import { logMods } from "@renderer/features/moddb/adapters/log"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useServerMods.ts]"

export interface ServerMods {
  /** One group per server folder, already sorted by the host. Empty while the first scan runs. */
  groups: ServerModGroupType[]
  /** There is more under ModsByServer than came back, a scan cap having bitten. */
  truncated: boolean
  loading: boolean
  refresh: () => Promise<void>
  /** Deletes one server's folder whole, then rescans. Nothing else on the page writes that tree. */
  remove: (group: ServerModGroupType) => Promise<void>
  /** The folder a removal is in flight for, or null. */
  removing: string | null
}

/**
 * The Mods the game downloaded to play on a server, grouped by that server.
 *
 * Loaded after mount rather than with the page: these arrive collapsed and nothing on the first
 * screen depends on them, so a folder of twenty servers must not hold up the Mods the player came
 * to manage. Nothing here touches `installedMods`: the Installation's Mod count, the selection and
 * Update all all read that list, and none of them may ever reach into a server's folder.
 *
 * Removal is the whole folder in one call, not `removeMods` from batch.ts, which is built for a
 * list of archives the player picked. The path is the one the host handed back, echoed to
 * DELETE_PATH, which checks the grant again before anything is removed.
 */
export function useServerMods(installation: InstallationType | undefined): ServerMods {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()

  const [groups, setGroups] = useState<ServerModGroupType[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const installationPath = installation?.path

  // The scan is asynchronous and the page can be left or switched mid-flight, so a late answer for
  // an Installation the player has moved on from is dropped rather than painted over the new one.
  const wanted = useRef(installationPath)
  wanted.current = installationPath

  const refresh = useCallback(async (): Promise<void> => {
    if (!installationPath) {
      setGroups([])
      setTruncated(false)
      return
    }

    setLoading(true)
    try {
      const scan = await fetchServerMods(installationPath)
      if (wanted.current !== installationPath) return
      setGroups(scan.groups)
      setTruncated(scan.truncated === true)
    } catch {
      logMods("error", `${LOG_TAG} [refresh] Could not read the Mods downloaded from servers.`)
      if (wanted.current === installationPath) {
        setGroups([])
        setTruncated(false)
      }
    } finally {
      if (wanted.current === installationPath) setLoading(false)
    }
  }, [installationPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = useCallback(
    async (group: ServerModGroupType): Promise<void> => {
      setRemoving(group.path)
      try {
        const removed = await createFileSystemPort()
          .remove(group.path)
          .catch(() => false)

        if (removed) {
          addNotification(t("features.mods.serverModsRemoved"), "success")
        } else {
          logMods("error", `${LOG_TAG} [remove] Could not remove a server's Mods.`)
          addNotification(t("features.mods.serverModsRemoveError"), "error")
        }

        await refresh()
      } finally {
        setRemoving(null)
      }
    },
    [addNotification, refresh, t]
  )

  return { groups, truncated, loading, refresh, remove, removing }
}
