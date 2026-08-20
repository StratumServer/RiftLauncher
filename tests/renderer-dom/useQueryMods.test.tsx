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
