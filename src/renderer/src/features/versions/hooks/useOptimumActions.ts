import { useTranslation } from "react-i18next"

import { buildGameVersionLabel } from "@domain/naming"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { TASK_NOTIFICATION_POLICIES, useTaskContext } from "@renderer/contexts/TaskManagerContext"
import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { describeOptimumFailure } from "@renderer/features/versions/adapters/optimum"

const LOG_TAG = "[front] [versions] [features/versions/hooks/useOptimumActions.ts]"

/** The registered build an Optimum action acts on. */
export interface OptimumTarget {
  id: string
  path: string
  version: string
}

export interface OptimumActions {
  /**
   * Downloads the published overlay, patches `target` with it, and registers the
   * result as the Optimum variant of that build.
   *
   * Two tasks, both visible: the overlay download and the patch. Resolves true
   * when the row now reads as Optimum.
   */
  applyOptimum(target: OptimumTarget, manifest: OptimumManifestInfo): Promise<boolean>
  /** Puts the vanilla assemblies back and takes the variant off the row. Resolves true when it did. */
  restoreVanilla(target: OptimumTarget): Promise<boolean>
}

/**
 * The two things a player can do to a build with Optimum, wired onto the task
 * manager and the config.
 *
 * Registration is the part worth reading twice. What ends up on the row does
 * not come from the manifest, or from the patch's own answer, or from anything
 * this hook decided: the launcher probes the folder afterwards with the same
 * LOOK_FOR_A_GAME_VERSION it uses for a build someone points it at by hand, and
 * a folder that does not answer with Optimum's marker is not registered as
 * Optimum, whatever the patch said.
 */
export function useOptimumActions(): OptimumActions {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const { startDownload, startOptimumPatch } = useTaskContext()
  const configDispatch = useConfigDispatch()

  function refuse(failure: { reason: OptimumPatchFailureReason; rolledBack?: boolean }): false {
    const { messageKey, logged } = describeOptimumFailure(failure)
    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Optimum was not applied.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Optimum was not applied: ${failure.reason}.`)
    }
    addNotification(t(messageKey), "error")
    return false
  }

  /**
   * Marks the build as being written to, the same way installing one does.
   *
   * A patch rewrites four assemblies over as much as twenty minutes, and for
   * that whole time the row must read as busy: `MainMenu` refuses Play on this
   * flag, and the VS Versions page refuses to delete the folder, to remove
   * Optimum from it or to start a second patch against it. The install flow
   * clears its own `_installing` as soon as the vanilla build is unpacked, which
   * is before the patch it goes on to start, so this is what covers that half.
   */
  function markBusy(id: string, busy: boolean): void {
    configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id, updates: { _installing: busy ? true : undefined } } })
  }

  async function applyOptimum(target: OptimumTarget, manifest: OptimumManifestInfo): Promise<boolean> {
    markBusy(target.id, true)
    try {
      return await downloadAndPatch(target, manifest)
    } finally {
      markBusy(target.id, false)
    }
  }

  async function downloadAndPatch(target: OptimumTarget, manifest: OptimumManifestInfo): Promise<boolean> {
    const taskName = t("features.versions.optimumTaskName", { version: manifest.optimumVersion })

    let downloaded = false
    await startDownload(
      taskName,
      t("features.versions.optimumDownloadDesc", { version: manifest.optimumVersion }),
      TASK_NOTIFICATION_POLICIES.aggregate,
      manifest.downloadUrl,
      manifest.downloadFolder,
      manifest.archiveFileName,
      (status) => {
        downloaded = status
      }
    )

    if (!downloaded) {
      addNotification(t("features.versions.optimumDownloadFailed"), "error")
      return false
    }

    let patched: OptimumPatchResult = { ok: false, reason: "engine-internal" }
    await startOptimumPatch(
      taskName,
      t("features.versions.optimumPatchDesc", { version: manifest.optimumVersion }),
      TASK_NOTIFICATION_POLICIES.aggregate,
      "apply",
      target.path,
      target.version,
      (result) => {
        patched = result
      }
    )

    if (!patched.ok) {
      // A run the main process rolled back leaves a plain vanilla build behind,
      // so a row that was reading as Optimum before the update is not any more.
      if (patched.rolledBack) configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: target.id, updates: { variant: undefined, label: buildGameVersionLabel(target.version) } } })
      return refuse(patched)
    }

    // The post-check, and the only thing that decides what the row says: the
    // marker comes off the patched assembly itself, which is the one signal
    // anyone can neither rename nor fake by writing a file.
    const probe = await window.api.gameManager.lookForAGameVersion(target.path)
    // Nothing is rolled back here: the patch itself checked out file by file, so
    // what failed is the launcher's reading of the folder. Remove Optimum stays
    // reachable on that row, because the backup is there.
    if (!probe.exists || !probe.variant) return refuse({ reason: "output-unverified" })

    configDispatch({
      type: CONFIG_ACTIONS.EDIT_GAME_VERSION,
      payload: { id: target.id, updates: { variant: probe.variant, label: buildGameVersionLabel(probe.installedGameVersion, probe.variant) } }
    })
    addNotification(t("features.versions.optimumApplied", { version: probe.variant.version }), "success")
    return true
  }

  async function restoreVanilla(target: OptimumTarget): Promise<boolean> {
    markBusy(target.id, true)
    try {
      return await putVanillaBack(target)
    } finally {
      markBusy(target.id, false)
    }
  }

  async function putVanillaBack(target: OptimumTarget): Promise<boolean> {
    let restored: OptimumPatchResult = { ok: false, reason: "engine-internal" }
    await startOptimumPatch(
      t("features.versions.optimumRestoreTaskName"),
      t("features.versions.optimumRestoreDesc"),
      TASK_NOTIFICATION_POLICIES.aggregate,
      "restore",
      target.path,
      target.version,
      (result) => {
        restored = result
      }
    )

    if (!restored.ok) return refuse(restored)

    configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: target.id, updates: { variant: undefined, label: buildGameVersionLabel(target.version) } } })
    addNotification(t("features.versions.optimumRestored"), "success")
    return true
  }

  return { applyOptimum, restoreVanilla }
}
