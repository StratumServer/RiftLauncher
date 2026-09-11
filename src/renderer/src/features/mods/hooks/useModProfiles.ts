import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { logMods } from "@renderer/features/moddb/adapters/log"
import { createModBatchPorts, fetchInstalledMods, fetchModProfiles, saveModProfiles } from "@renderer/features/moddb/adapters/modsManager"
import { resolveModsFolder } from "@renderer/features/mods/adapters/folder"

import { setModsEnabled } from "@domain/mods/batch"
import { modsFolderInUse } from "@domain/mods/install"
import {
  beginModProfileSwitch,
  createModProfile,
  deleteModProfile,
  duplicateModProfile,
  emptyModProfilesDocument,
  finishModProfileSwitch,
  planModProfileSwitch,
  renameModProfile,
  validateModProfileName
} from "@domain/mods/profiles"
import type { ModProfileNameProblem } from "@domain/mods/profiles"

const LOG_TAG = "[front] [mods] [features/mods/hooks/useModProfiles.ts]"

// A profile name is the player's own text and React already escapes what it renders, so i18next's
// HTML escaping would only show "A & B" as "A &amp; B".
const RAW_NAME = { interpolation: { escapeValue: false } }

/** `ready` is the only state that allows a write. The other three leave the file exactly as it is. */
export type ModProfilesStatus = "loading" | "ready" | "newer-format" | "unreadable" | "unavailable"

export interface ModProfiles {
  status: ModProfilesStatus
  profiles: readonly ModProfile[]
  /** The profile the Mods folder is in, if any. The folder, not this record, says what is on. */
  activeProfile: ModProfile | undefined
  /** A write or a switch is in flight. Everything else waits for it. */
  working: boolean
  /** The profile a switch is applying, while it runs. */
  switchingTo: string | null
  /** Saves the folder as a new, active profile. Resolves the name problem, or null once it was handled. */
  create(name: string): Promise<ModProfileNameProblem | null>
  rename(id: string, name: string): Promise<ModProfileNameProblem | null>
  remove(id: string): Promise<void>
  duplicate(id: string): Promise<void>
  /** Renames archives until the folder matches the profile. Ends in exactly one notification. */
  switchTo(id: string): Promise<void>
}

/**
 * One Installation's Mod profiles: the file, and the five things the dialog does with it.
 *
 * Every capture and every switch reads the folder fresh, with no ModDB lookup and no search or filter
 * applied: a profile is the whole set of Mods, so recording or applying only the rows on screen would
 * leave a folder that matches no profile.
 *
 * A switch writes twice. First the outgoing profile takes the folder as it is and no profile is
 * active; then the renames; then, only if every one went through, the target becomes active. A switch
 * that stops half way leaves a valid folder that belongs to nobody, both stored sets intact, and a
 * retry that renames only what is still wrong.
 *
 * No write starts while a backup, a restore or Update all has the folder, and a scan that could not
 * read the folder records and applies nothing: its empty list is not what the folder holds.
 *
 * Known limits: a download already in flight when a switch starts still lands enabled, and so becomes
 * part of the profile being switched to. Updating one Mod from its row removes the old archive before
 * the new one lands without marking the folder busy, so a profile created or duplicated in that window
 * leaves that Mod out. Everything that starts during a switch is refused, because the switch holds
 * `_updatingMods`.
 */
export function useModProfiles(installation: InstallationType | undefined): ModProfiles {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()

  const [status, setStatus] = useState<ModProfilesStatus>("loading")
  const [document, setDocument] = useState<ModProfilesDocument>(emptyModProfilesDocument)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  // The ref is the guard and the state only paints it: a second press lands before React has
  // rendered the first one's state.
  const workingRef = useRef(false)
  const [working, setWorking] = useState(false)

  const installationPath = installation?.path

  useEffect(() => {
    if (!installationPath) return
    let current = true
    setStatus("loading")
    setDocument(emptyModProfilesDocument())

    fetchModProfiles(installationPath).then(
      (read) => {
        if (!current) return
        if (read.ok) setDocument(read.document)
        setStatus(read.ok ? "ready" : read.reason === "refused" ? "unavailable" : read.reason)
        if (!read.ok) logMods("info", `${LOG_TAG} [load] Profiles are off for this Installation: ${read.reason}.`)
      },
      () => {
        if (!current) return
        setStatus("unavailable")
        logMods("error", `${LOG_TAG} [load] Could not read the profiles.`)
      }
    )

    return (): void => {
      current = false
    }
  }, [installationPath])

  /** A raw scan of the whole folder: no ModDB, no search, no filter. Undefined, after one error, when the folder could not be read. */
  async function scanFolder(path: string): Promise<InstalledModType[] | undefined> {
    const scan = await fetchInstalledMods(await resolveModsFolder(path))
    if (!scan.unreadable) return scan.mods
    logMods("error", `${LOG_TAG} [scanFolder] The Mods folder could not be read, so nothing was recorded or changed.`)
    addNotification(t("features.mods.profilesFolderUnreadable"), "error")
    return undefined
  }

  /** Writes `next`. False when it did not land, and a file the host will not overwrite turns profiles off. */
  async function save(path: string, next: ModProfilesDocument): Promise<boolean> {
    const result = await saveModProfiles(path, next).catch((): ModProfilesSaveResult => ({ ok: false, reason: "refused" }))
    if (result.ok) {
      setDocument(next)
      return true
    }

    logMods("error", `${LOG_TAG} [save] Saving the profiles was refused: ${result.reason}.`)
    if (result.reason === "newer-format" || result.reason === "unreadable") setStatus(result.reason)
    return false
  }

  /** One write at a time, and none unless the file is one this build may write. */
  async function exclusive(task: (path: string) => Promise<void>): Promise<void> {
    if (!installationPath || status !== "ready" || workingRef.current) return
    // A capture now would miss a Mod Update all has removed and not yet replaced, and a write during a
    // restore lands in a folder about to be swapped out.
    if (installation && modsFolderInUse(installation)) return addNotification(t("features.mods.cantChangeProfilesWhileInUse"), "error")
    workingRef.current = true
    setWorking(true)

    try {
      await task(installationPath)
    } catch {
      logMods("error", `${LOG_TAG} [exclusive] A profile change stopped unexpectedly.`)
      addNotification(t("features.mods.profilesSaveFailed"), "error")
    } finally {
      workingRef.current = false
      setWorking(false)
    }
  }

  async function saveOrSay(path: string, next: ModProfilesDocument): Promise<void> {
    if (!(await save(path, next))) addNotification(t("features.mods.profilesSaveFailed"), "error")
  }

  async function create(name: string): Promise<ModProfileNameProblem | null> {
    const check = validateModProfileName(name, document.profiles)
    if (!check.ok) return check.problem
    await exclusive(async (path) => {
      const mods = await scanFolder(path)
      if (mods) await saveOrSay(path, createModProfile(document, crypto.randomUUID(), check.name, mods))
    })
    return null
  }

  async function rename(id: string, name: string): Promise<ModProfileNameProblem | null> {
    const check = validateModProfileName(name, document.profiles, id)
    if (!check.ok) return check.problem
    await exclusive((path) => saveOrSay(path, renameModProfile(document, id, check.name)))
    return null
  }

  async function remove(id: string): Promise<void> {
    await exclusive((path) => saveOrSay(path, deleteModProfile(document, id)))
  }

  async function duplicate(id: string): Promise<void> {
    // Only the active profile's copy needs the folder: every other profile's stored set is its record.
    await exclusive(async (path) => {
      const mods = id === document.activeProfileId ? await scanFolder(path) : []
      if (mods) await saveOrSay(path, duplicateModProfile(document, id, crypto.randomUUID(), mods))
    })
  }

  async function applyProfile(path: string, target: ModProfile): Promise<void> {
    const mods = await scanFolder(path)
    if (!mods) return
    const begun = beginModProfileSwitch(document, mods)
    if (!(await save(path, begun))) {
      logMods("error", `${LOG_TAG} [switchTo] Stopped before any rename: the outgoing profile could not be recorded.`)
      return addNotification(t("features.mods.profileSwitchNotStarted"), "error")
    }

    const plan = planModProfileSwitch(target, mods)
    const results = await setModsEnabled(createModBatchPorts(), plan.changes)

    // Results come back in the order the changes went in.
    const failed = results.filter((result) => !result.ok).length
    const turnedOn = plan.changes.filter((change, index) => change.enabled && results[index]?.ok).length
    const turnedOff = results.length - failed - turnedOn
    logMods("info", `${LOG_TAG} [switchTo] Profile switch: ${turnedOn} on, ${turnedOff} off, ${failed} failed, ${plan.missing} missing, ${plan.unresolved} unresolved.`)

    // Nothing is rolled back. Every rename is atomic, so the folder is valid, and with no profile
    // active the next switch cannot record this mix into either profile.
    if (failed > 0) return addNotification(t("features.mods.profileSwitchPartial", { profile: target.name, failed, ...RAW_NAME }), "warning")

    if (!(await save(path, finishModProfileSwitch(begun, target.id)))) {
      return addNotification(t("features.mods.profileSwitchNotRecorded", { profile: target.name, ...RAW_NAME }), "warning")
    }

    const skipped = plan.missing + plan.unresolved
    const counts = { profile: target.name, on: turnedOn, off: turnedOff, ...RAW_NAME }
    addNotification(skipped > 0 ? t("features.mods.profileSwitchedWithSkipped", { ...counts, skipped }) : t("features.mods.profileSwitched", counts), "success")
  }

  async function switchTo(id: string): Promise<void> {
    const target = document.profiles.find((profile) => profile.id === id)
    // The active profile is the folder already, so using it again has nothing to do.
    if (!installation || !target || id === document.activeProfileId) return
    // A game running on these archives, or anything else rewriting them, would see half a profile.
    if (installation._playing || modsFolderInUse(installation)) return addNotification(t("features.mods.cantSwitchProfileWhileInUse"), "error")

    const installationId = installation.id
    await exclusive(async (path) => {
      setSwitchingTo(id)
      // Holds Play, Update all, imports, the batch and every single-Mod action off the folder, and
      // keeps the scan waiting until the renames are done. Clearing it rescans.
      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installationId, updates: { _updatingMods: true } } })
      try {
        await applyProfile(path, target)
      } finally {
        configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installationId, updates: { _updatingMods: false } } })
        setSwitchingTo(null)
      }
    })
  }

  return {
    status,
    profiles: document.profiles,
    activeProfile: document.profiles.find((profile) => profile.id === document.activeProfileId),
    working,
    switchingTo,
    create,
    rename,
    remove,
    duplicate,
    switchTo
  }
}
