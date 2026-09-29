import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { useQueryMods } from "@renderer/features/mods/hooks/useQueryMods"

import { installMockWindowApi } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside the hook, same as
// renderWithProviders (./helpers/render) does for full-page renders.
import "@renderer/i18n"

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <NotificationsProvider>{children}</NotificationsProvider>
}

const MOD_RESPONSE = {
  statuscode: "200",
  mods: [{ modid: 1, assetid: 1, name: "Cached Mod", summary: "", modidstrs: ["cachedmod"], author: "A", downloads: 1, follows: 1, comments: 0, side: "both", logo: "", tags: [] }]
}

describe("useQueryMods caching", () => {
  it("serves a repeat of the exact same filters from cache, without a second network call", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(MOD_RESPONSE))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })

    const first = await result.current({ textFilter: "shared filters test one", orderBy: "follows", orderByOrder: "desc" })
    expect(first).toHaveLength(1)
    expect(queryURL).toHaveBeenCalledTimes(1)

    const second = await result.current({ textFilter: "shared filters test one", orderBy: "follows", orderByOrder: "desc" })
    expect(second).toEqual(first)
    // Same filters as the call above: still exactly 1 network call, the second one came from cache.
    expect(queryURL).toHaveBeenCalledTimes(1)
  })

  it("goes back to the network for a different set of filters", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(MOD_RESPONSE))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })

    await result.current({ textFilter: "distinct filters test one", orderBy: "follows", orderByOrder: "desc" })
    await result.current({ textFilter: "distinct filters test two", orderBy: "follows", orderByOrder: "desc" })

    expect(queryURL).toHaveBeenCalledTimes(2)
  })

  it("calls onFinish on a cache hit too", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(MOD_RESPONSE))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })
    const onFinish = vi.fn()

    await result.current({ textFilter: "onfinish cache test", orderBy: "follows", orderByOrder: "desc", onFinish })
    expect(onFinish).toHaveBeenCalledTimes(1)

    await result.current({ textFilter: "onfinish cache test", orderBy: "follows", orderByOrder: "desc", onFinish })
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(2))
  })
})

const RANKING_RESPONSE = {
  statuscode: "200",
  mods: [
    { modid: 1, assetid: 1, name: "Thermal HUD", summary: "", modidstrs: ["thermalhud"], author: "A", downloads: 1, follows: 100, comments: 0, side: "both", logo: "", tags: [] },
    { modid: 2, assetid: 2, name: "Immersive Herbicide", summary: "", modidstrs: ["immersiveherbicide"], author: "A", downloads: 1, follows: 1, comments: 0, side: "both", logo: "", tags: [] }
  ]
}

describe("useQueryMods search ranking (issue #550)", () => {
  it("ranks a name match first when no sort was explicitly chosen, ahead of the API's own (follower-count) order", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(RANKING_RESPONSE))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })

    const mods = await result.current({ textFilter: "Immersive", orderBy: "follows", orderByOrder: "desc", orderByIsExplicit: false })

    // Without the fix this fails: the API order (Thermal HUD first, by follows) passes straight through.
    expect(mods.map((mod) => mod.name)).toEqual(["Immersive Herbicide", "Thermal HUD"])
  })

  it("leaves the API's order untouched once the player has explicitly chosen a sort", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(RANKING_RESPONSE))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })

    const mods = await result.current({ textFilter: "Immersive", orderBy: "follows", orderByOrder: "desc", orderByIsExplicit: true })

    // Without the fix this fails too: ranking would apply here regardless of orderByIsExplicit,
    // reordering a sort the player picked on purpose.
    expect(mods.map((mod) => mod.name)).toEqual(["Thermal HUD", "Immersive Herbicide"])
  })

  it("encodes a search text with & and + so it reaches the ModDB query intact", async () => {
    const queryURL = vi.fn(async (_path: string) => JSON.stringify({ statuscode: "200", mods: [] }))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMods(), { wrapper })

    await result.current({ textFilter: "Tinker & Tailor + Co", orderBy: "follows", orderByOrder: "desc" })

    expect(queryURL.mock.calls[0]?.[0]).toBeDefined()
    const requestedUrl = queryURL.mock.calls[0]![0]
    // Without encodeURIComponent this fails: "&" and "+" are sent raw, splitting/altering the query.
    expect(requestedUrl).toContain(`text=${encodeURIComponent("Tinker & Tailor + Co")}`)
    expect(requestedUrl).not.toContain("text=Tinker & Tailor + Co")
  })
})
