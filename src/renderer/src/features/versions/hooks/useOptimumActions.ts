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

  function refuse(reason: OptimumPatchFailureReason): false {
    const { messageKey, logged } = describeOptimumFailure(reason)
    if (logged) {
      window.api.utils.logMessage("error", `${LOG_TAG} Optimum was not applied.`)
      window.api.utils.logMessage("debug", `${LOG_TAG} Optimum was not applied: ${reason}.`)
    }
    addNotification(t(messageKey), "error")
    return false
  }

  async function applyOptimum(target: OptimumTarget, manifest: OptimumManifestInfo): Promise<boolean> {
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

    if (!patched.ok) return refuse(patched.reason)

    // The post-check, and the only thing that decides what the row says: the
    // marker comes off the patched assembly itself, which is the one signal
    // anyone can neither rename nor fake by writing a file.
    const probe = await window.api.gameManager.lookForAGameVersion(target.path)
    if (!probe.exists || !probe.variant) return refuse("output-unverified")

    configDispatch({
      type: CONFIG_ACTIONS.EDIT_GAME_VERSION,
      payload: { id: target.id, updates: { variant: probe.variant, label: buildGameVersionLabel(probe.installedGameVersion, probe.variant) } }
    })
    addNotification(t("features.versions.optimumApplied", { version: probe.variant.version }), "success")
    return true
  }

  async function restoreVanilla(target: OptimumTarget): Promise<boolean> {
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

    if (!restored.ok) return refuse(restored.reason)

    configDispatch({ type: CONFIG_ACTIONS.EDIT_GAME_VERSION, payload: { id: target.id, updates: { variant: undefined, label: buildGameVersionLabel(target.version) } } })
    addNotification(t("features.versions.optimumRestored"), "success")
    return true
  }

  return { applyOptimum, restoreVanilla }
}
