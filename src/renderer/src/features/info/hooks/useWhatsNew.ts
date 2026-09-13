import { useEffect, useState } from "react"

import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"
import { CONFIG_ACTIONS, useConfigDispatch, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { fetchReleaseNotes } from "@renderer/features/info/adapters/whatsNew"
import { releaseNotesToBlocks, selectReleasesToShow, type WhatsNewBlock } from "@domain/appUpdate/whatsNew"

export interface WhatsNewRelease {
  version: string
  name: string
  blocks: WhatsNewBlock[]
}

export type WhatsNewStatus = "loading" | "ready" | "unavailable"

interface WhatsNewState {
  releases: WhatsNewRelease[]
  status: WhatsNewStatus
}

const LOADING_STATE: WhatsNewState = { releases: [], status: "loading" }
const NOTHING_TO_SHOW_STATE: WhatsNewState = { releases: [], status: "ready" }

/**
 * The one fetch this feature makes each session, shared by every consumer of {@link useWhatsNew}
 * (the startup dialog and the Info & Help section both call the hook, and neither should trigger
 * its own round trip to GitHub). A module-level promise rather than React state on purpose: it
 * has to survive the dialog and the page mounting and unmounting independently of each other, and
 * it has to be computed from the versions the very first caller saw, not whatever
 * `lastSeenChangelogVersion` has become by the time a later caller renders (see below).
 *
 * Reset only by a full reload of the renderer, which is what "once per session" means here.
 */
let cachedWhatsNew: Promise<WhatsNewState> | null = null

/**
 * Test-only escape hatch: clears the module cache above without reloading the module (which would
 * hand a fresh copy of ConfigContext to a component still rendered against the original, since
 * Vitest's `vi.resetModules()` reloads the whole graph). Never called from production code; every
 * real session gets exactly one renderer module instance, which is what "once per session" means.
 */
export function resetWhatsNewCacheForTests(): void {
  cachedWhatsNew = null
}

async function computeWhatsNew(previousVersion: string, currentVersion: string): Promise<WhatsNewState> {
  // Nothing changed since this version's notes were last shown (or acknowledged this session):
  // no fetch, nothing to show. This is also what a config carrying the very version already
  // running produces, so a second render after "Got it" never re-fetches.
  if (previousVersion === currentVersion) return NOTHING_TO_SHOW_STATE

  try {
    const result = await fetchReleaseNotes()
    if (!result.ok) return { releases: [], status: "unavailable" }

    const releases = selectReleasesToShow(result.releases, previousVersion, currentVersion).map((release) => ({
      version: release.tag.replace(/^v/i, ""),
      name: release.name,
      blocks: releaseNotesToBlocks(release.body)
    }))

    return { releases, status: "ready" }
  } catch {
    return { releases: [], status: "unavailable" }
  }
}

/**
 * The releases to show after an update, reduced to plain blocks, plus how to mark them seen.
 *
 * `releases` and `status` are frozen for the rest of the session the first time a consumer's
 * effect runs with both a running version and a loaded config: that first computation is the one
 * that read `lastSeenChangelogVersion` as it stood before "Got it" could have touched it, and the
 * Info & Help section reusing the same frozen answer later in the session is what lets a player
 * "read them again" rather than watch the section go empty the moment the dialog is dismissed.
 */
export function useWhatsNew(): WhatsNewState & { markSeen: () => void } {
  const { vslVersion } = useAppInfo()
  const { schemaVersion, lastSeenChangelogVersion } = useSettingsConfig()
  const dispatch = useConfigDispatch()
  const [state, setState] = useState<WhatsNewState>(LOADING_STATE)

  useEffect(() => {
    // schemaVersion 0: the stored config has not arrived yet (see configReducer's initialState).
    // Waiting for it is what keeps the very first computation honest about lastSeenChangelogVersion
    // instead of racing it against the reducer's empty-string default.
    if (!vslVersion || schemaVersion === 0) return

    cachedWhatsNew ??= computeWhatsNew(lastSeenChangelogVersion, vslVersion)

    let cancelled = false
    void cachedWhatsNew.then((result) => {
      if (!cancelled) setState(result)
    })

    return (): void => {
      cancelled = true
    }
  }, [vslVersion, schemaVersion, lastSeenChangelogVersion])

  const markSeen = (): void => {
    dispatch({ type: CONFIG_ACTIONS.SET_LAST_SEEN_CHANGELOG_VERSION, payload: vslVersion })
  }

  return { ...state, markSeen }
}
