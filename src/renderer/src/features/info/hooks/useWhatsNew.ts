import { useEffect, useRef, useState } from "react"

import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"
import { CONFIG_ACTIONS, useConfigDispatch, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { fetchReleaseNotes } from "@renderer/features/info/adapters/whatsNew"
import { releaseNotesToBlocks, selectLatestReleases, selectReleasesToShow, type WhatsNewBlock } from "@domain/appUpdate/whatsNew"

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
const UNAVAILABLE_STATE: WhatsNewState = { releases: [], status: "unavailable" }

/**
 * The one fetch this feature makes each session, shared by both consumers: the startup dialog
 * ({@link useWhatsNew}) and the Info & Help section ({@link useLatestReleases}) ask for the same
 * release list, and whichever of them needs it first is the only one that goes to GitHub.
 *
 * A module-level promise rather than React state, because the dialog and the page mount and
 * unmount independently of each other. It holds the raw response and nothing derived from it: the
 * two consumers want different slices of the same list, and #442 tied them to one derived answer,
 * which is how Info & Help ended up empty on every launch after the first.
 *
 * Reset only by a full reload of the renderer, which is what "once per session" means here.
 */
let cachedReleaseNotes: Promise<FetchReleaseNotesResult> | null = null

function fetchOnce(): Promise<FetchReleaseNotesResult> {
  cachedReleaseNotes ??= fetchReleaseNotes().catch((): FetchReleaseNotesResult => ({ ok: false, reason: "offline" }))
  return cachedReleaseNotes
}

/**
 * Test-only escape hatch: clears the module cache above without reloading the module (which would
 * hand a fresh copy of ConfigContext to a component still rendered against the original, since
 * Vitest's `vi.resetModules()` reloads the whole graph). Never called from production code; every
 * real session gets exactly one renderer module instance, which is what "once per session" means.
 */
export function resetWhatsNewCacheForTests(): void {
  cachedReleaseNotes = null
}

function toWhatsNewReleases(releases: readonly WhatsNewReleaseInfo[]): WhatsNewRelease[] {
  return releases.map((release) => ({ version: release.tag.replace(/^v/i, ""), name: release.name, blocks: releaseNotesToBlocks(release.body) }))
}

/**
 * The releases the startup dialog should interrupt a player with, plus how to mark them seen.
 *
 * The window is (last seen, running version], so this answers with something exactly once per
 * update, and with nothing at all when the two versions already match, which is also the one case
 * where it makes no request. The version it compares against is frozen on the first run that sees
 * a loaded config, so "Got it" writing the running version does not empty the dialog out from
 * under its own closing animation.
 *
 * A successful fetch that matches no release (a development build, or a version whose release is
 * not published yet) writes the running version to the config anyway: there is nothing to show
 * and there never will be, so the next launch should not ask GitHub again. A failed fetch writes
 * nothing, because that answer may well be different next time.
 */
export function useWhatsNew(): WhatsNewState & { previousVersion: string; markSeen: () => void } {
  const { vslVersion } = useAppInfo()
  const { schemaVersion, lastSeenChangelogVersion } = useSettingsConfig()
  const dispatch = useConfigDispatch()
  const [state, setState] = useState<WhatsNewState>(LOADING_STATE)
  const previousVersion = useRef<string | null>(null)

  useEffect(() => {
    // schemaVersion 0: the stored config has not arrived yet (see configReducer's initialState).
    // Waiting for it is what keeps the very first computation honest about lastSeenChangelogVersion
    // instead of racing it against the reducer's empty-string default.
    if (!vslVersion || schemaVersion === 0) return

    previousVersion.current ??= lastSeenChangelogVersion
    const previous = previousVersion.current

    if (previous === vslVersion) {
      setState(NOTHING_TO_SHOW_STATE)
      return
    }

    let cancelled = false

    void fetchOnce().then((result) => {
      if (cancelled) return
      if (!result.ok) return setState(UNAVAILABLE_STATE)

      const releases = toWhatsNewReleases(selectReleasesToShow(result.releases, previous, vslVersion))
      if (releases.length === 0 && lastSeenChangelogVersion !== vslVersion) dispatch({ type: CONFIG_ACTIONS.SET_LAST_SEEN_CHANGELOG_VERSION, payload: vslVersion })

      setState({ releases, status: "ready" })
    })

    return (): void => {
      cancelled = true
    }
  }, [vslVersion, schemaVersion, lastSeenChangelogVersion, dispatch])

  const markSeen = (): void => {
    dispatch({ type: CONFIG_ACTIONS.SET_LAST_SEEN_CHANGELOG_VERSION, payload: vslVersion })
  }

  // The frozen version rather than the live config value, so the dialog's own title does not
  // rewrite itself the moment closing it marks the running version seen.
  return { ...state, previousVersion: previousVersion.current ?? "", markSeen }
}

/**
 * The latest releases for the Info & Help section, fetched when the page mounts and listed
 * whatever the player has already seen.
 *
 * Deliberately not {@link useWhatsNew}. That hook answers "what did this update bring", which is
 * nothing on an ordinary launch, and #442 gave the section that same answer: from the second
 * launch of a version onward it rendered a heading over an empty space. A player opening Info &
 * Help is asking to read the notes, so the section fetches on its own and shows the latest
 * releases, sharing the session's one request with the dialog when both want it.
 *
 * `currentVersion` is the running version, taken as an argument rather than read through another
 * useAppInfo, whose mount effect costs four IPC calls; the page already has it.
 */
export function useLatestReleases(currentVersion: string): WhatsNewState {
  const [state, setState] = useState<WhatsNewState>(LOADING_STATE)

  useEffect(() => {
    if (!currentVersion) return

    let cancelled = false

    void fetchOnce().then((result) => {
      if (cancelled) return
      setState(result.ok ? { releases: toWhatsNewReleases(selectLatestReleases(result.releases, currentVersion)), status: "ready" } : UNAVAILABLE_STATE)
    })

    return (): void => {
      cancelled = true
    }
  }, [currentVersion])

  return state
}
