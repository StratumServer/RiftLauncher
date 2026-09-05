import { useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"

import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"

export type SelectBackgroundActions = {
  /** The bundled scene. Costs nothing and always works, so it never reports a failure. */
  selectDefault: () => void
  /**
   * Selects the scene once its file is on disk, downloading it first when it is not. Selects
   * nothing if that fails, and nothing either if the player has picked something else since.
   */
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

  // The selection the player made last is the one that counts. A pick can take as long as its
  // download does, so two of them are easily in flight at once and they resolve in whatever order
  // the network decides. Every entry point claims the counter before it starts, and a claim that
  // is no longer the current one is dropped where it lands: no repaint, no config write, and no
  // notification either, because the player has already moved off the scene it would be about.
  const latestRequest = useRef(0)
  const claimLatest = useCallback((): (() => boolean) => {
    const request = (latestRequest.current += 1)
    return () => request === latestRequest.current
  }, [])

  const selectDefault = useCallback((): void => {
    claimLatest()
    configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: DEFAULT_BACKGROUND_ID })
  }, [claimLatest, configDispatch])

  const selectFromCatalog = useCallback(
    async (entry: BackgroundType): Promise<void> => {
      const isLatest = claimLatest()
      const result = await window.api.backgroundsManager.ensureBackground(entry.id, entry.file, entry.sha256)
      // The download itself is not cancellable, so it runs to the end and the file it wrote stays
      // in the cache for the next time this scene is picked. Only the outcome is dropped.
      if (!isLatest()) return

      // "current" and "refreshed" both leave the file on disk under this id, which is all the
      // selection needs. Only "failed" leaves the player with nothing to paint.
      if (result === "failed") {
        return addNotification(t("notifications.body.backgroundDownloadFailed"), "error")
      }

      configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: entry.id })
    },
    [addNotification, claimLatest, configDispatch, t]
  )

  const pickCustom = useCallback(async (): Promise<void> => {
    const isLatest = claimLatest()
    const [selectedPath] = await window.api.utils.selectFolderDialog({ type: "file", extensions: ["jpg", "jpeg"] })
    const copied = selectedPath ? await window.api.backgroundsManager.copyCustomBackground(selectedPath) : false
    // One check behind both waits: the file dialog is not owned by the launcher window, so a scene
    // can be picked while it is open, and neither the copy nor its failure is news by then.
    if (!isLatest()) return

    if (!selectedPath) return addNotification(t("notifications.body.noFileSelected"), "error")
    if (!copied) return addNotification(t("notifications.body.backgroundCopyFailed"), "error")

    // Dispatched even when the custom slot was already selected: the action bumps the revision,
    // which is what makes the renderer read the replaced file rather than the one it already has.
    configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: CUSTOM_BACKGROUND_ID })
  }, [addNotification, claimLatest, configDispatch, t])

  const ensureCached = useCallback(async (entry: BackgroundType): Promise<EnsureBackgroundResult> => {
    // Silent on failure on purpose: nothing was asked for. The launcher is showing the bundled
    // scene in the meantime and will try again the next time this section is opened. The caller
    // decides whether a "refreshed" result should still repaint, because by the time this
    // resolves the player may have picked a different scene.
    return window.api.backgroundsManager.ensureBackground(entry.id, entry.file, entry.sha256).catch((): EnsureBackgroundResult => "failed")
  }, [])

  return { selectDefault, selectFromCatalog, pickCustom, ensureCached }
}
