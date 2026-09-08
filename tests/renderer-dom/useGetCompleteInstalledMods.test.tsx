import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

import { useGetCompleteInstalledMods } from "@renderer/features/mods/hooks/useGetCompleteInstalledMods"

import { installMockWindowApi } from "./helpers/windowApi"

const MOD_COUNT = 8
// Matches INSTALLED_MOD_LOOKUP_LIMIT in useGetCompleteInstalledMods.ts. Not imported: the point
// of this test is to notice if that constant ever drifts back up towards the shared 6.
const FAN_OUT_LIMIT = 2

/** N installed mods, distinct ids, no icon: keeps this test's lookups to queryURL alone. */
function anInstalledModsScan(): { mods: InstalledModType[]; errors: ErrorInstalledModType[] } {
  return {
    mods: Array.from({ length: MOD_COUNT }, (_, index) => ({
      name: `Mod ${index + 1}`,
      modid: String(index + 1),
      version: "1.0.0",
      path: `/games/a/Mods/mod-${index + 1}.zip`,
      enabled: true,
      authors: [],
      contributors: []
    })),
    errors: []
  }
}

/**
 * A queryURL mock whose promises only settle when told to, so a test can see exactly how many
 * lookups are in flight before letting any of them finish.
 */
function deferredQueryURL(): {
  queryURL: ReturnType<typeof vi.fn<BridgeAPI["netManager"]["queryURL"]>>
  active: () => number
  releaseOldest: () => void
} {
  let active = 0
  const pending: Array<() => void> = []

  const queryURL = vi.fn<BridgeAPI["netManager"]["queryURL"]>(() => {
    active++
    return new Promise<string>((resolve) => {
      pending.push(() => {
        active--
        resolve(JSON.stringify({ statuscode: "404" }))
      })
    })
  })

  return {
    queryURL,
    active: () => active,
    releaseOldest: () => pending.shift()?.()
  }
}

describe("useGetCompleteInstalledMods: bounding its own ModDB fan-out (#386)", () => {
  it(`keeps at most ${FAN_OUT_LIMIT} lookups in flight across ${MOD_COUNT} installed mods, and returns them in the original order`, async () => {
    const deferred = deferredQueryURL()
    installMockWindowApi({
      netManager: { queryURL: deferred.queryURL },
      modsManager: { getInstalledMods: vi.fn(async () => anInstalledModsScan()) }
    })

    const { result } = renderHook(() => useGetCompleteInstalledMods())

    let settled: { mods: InstalledModType[]; errors: ErrorInstalledModType[] } | undefined
    const finalPromise = result.current({ path: "/games/a", version: "1.20.0" }).then((outcome) => {
      settled = outcome
      return outcome
    })

    // The first wave: only the fan-out limit gets in, the rest of the folder waits its turn. If
    // the limiter were removed, all 8 would dispatch at once and this would see 8, not 2.
    await waitFor(() => expect(deferred.queryURL).toHaveBeenCalledTimes(FAN_OUT_LIMIT))
    expect(deferred.active()).toBe(FAN_OUT_LIMIT)

    // Release one lookup at a time. Each release should free exactly one slot for whatever is
    // still queued, so the active count never climbs past the limit and the dispatch count grows
    // by at most one lookup per release.
    for (let released = 1; released <= MOD_COUNT; released++) {
      expect(deferred.active()).toBeLessThanOrEqual(FAN_OUT_LIMIT)
      deferred.releaseOldest()

      const expectedDispatched = Math.min(MOD_COUNT, FAN_OUT_LIMIT + released)
      await waitFor(() => expect(deferred.queryURL).toHaveBeenCalledTimes(expectedDispatched))
    }

    await finalPromise
    expect(deferred.queryURL).toHaveBeenCalledTimes(MOD_COUNT)
    expect(deferred.active()).toBe(0)

    // Every lookup answered 404, so nothing reorders the list: it comes back exactly as scanned.
    expect(settled?.mods.map((mod) => mod.modid)).toEqual(anInstalledModsScan().mods.map((mod) => mod.modid))
  })
})
