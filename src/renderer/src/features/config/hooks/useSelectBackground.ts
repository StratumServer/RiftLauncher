import { useCallback } from "react"
import { useTranslation } from "react-i18next"

import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

export type SelectBackgroundActions = {
  /** The bundled scene. Costs nothing and always works, so it never reports a failure. */
  selectDefault: () => void
  /** Selects the scene once its file is on disk, downloading it first when it is not. Selects nothing if that fails. */
  selectFromCatalog: (entry: BackgroundType) => Promise<void>
  /** Picks a JPEG off the player's disk, copies it into the cache and selects it. */
  pickCustom: () => Promise<void>
  /**
   * Downloads the cached file for a selected catalog scene when it is missing or the branch has
   * replaced it, and reports what it did. Dispatches nothing: the caller owns the repaint, because
   * only the caller knows whether the entry is still the one the player has selected.
   */
  ensureCached: (entry: BackgroundType) => Promise<EnsureBackgroundResult>
}

/**
 * The three ways to change the background, and the repair for the fourth case.
 *
 * A scene is only downloaded when it is chosen, so opening the settings page costs one small
 * manifest and nothing else. The selection is only written to the config once the file is on
 * disk: selecting first would leave the player looking at the bundled default with no idea why.
 */
export function useSelectBackground(): SelectBackgroundActions {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()

  const selectDefault = useCallback((): void => {
    configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: DEFAULT_BACKGROUND_ID })
  }, [configDispatch])

  const selectFromCatalog = useCallback(
    async (entry: BackgroundType): Promise<void> => {
      const result = await window.api.backgroundsManager.ensureBackground(entry.id, entry.file, entry.sha256)
      // "current" and "refreshed" both leave the file on disk under this id, which is all the
      // selection needs. Only "failed" leaves the player with nothing to paint.
      if (result === "failed") {
        return addNotification(t("notifications.body.backgroundDownloadFailed"), "error")
      }

      configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: entry.id })
    },
    [addNotification, configDispatch, t]
  )

  const pickCustom = useCallback(async (): Promise<void> => {
    const [selectedPath] = await window.api.utils.selectFolderDialog({ type: "file", extensions: ["jpg", "jpeg"] })
    if (!selectedPath) return addNotification(t("notifications.body.noFileSelected"), "error")

    if (!(await window.api.backgroundsManager.copyCustomBackground(selectedPath))) {
      return addNotification(t("notifications.body.backgroundCopyFailed"), "error")
    }

    // Dispatched even when the custom slot was already selected: the action bumps the revision,
    // which is what makes the renderer read the replaced file rather than the one it already has.
    configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: CUSTOM_BACKGROUND_ID })
  }, [addNotification, configDispatch, t])

  const ensureCached = useCallback(async (entry: BackgroundType): Promise<EnsureBackgroundResult> => {
    // Silent on failure on purpose: nothing was asked for. The launcher is showing the bundled
    // scene in the meantime and will try again the next time this section is opened. The caller
    // decides whether a "refreshed" result should still repaint, because by the time this
    // resolves the player may have picked a different scene.
    return window.api.backgroundsManager.ensureBackground(entry.id, entry.file, entry.sha256).catch((): EnsureBackgroundResult => "failed")
  }, [])

  return { selectDefault, selectFromCatalog, pickCustom, ensureCached }
}
