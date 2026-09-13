import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

import { useModReleaseCatalog } from "@renderer/features/mods/hooks/useModReleaseCatalog"

import { installMockWindowApi } from "./helpers/windowApi"

const NOT_FOUND = JSON.stringify({ statuscode: "404" })

function renderCatalog(modid: string | null): ReturnType<typeof renderHook<ReturnType<typeof useModReleaseCatalog>, { modid: string | null }>> {
  return renderHook(({ modid }) => useModReleaseCatalog(modid), { initialProps: { modid } })
}

describe("useModReleaseCatalog", () => {
  it("tells a clean 404 apart from a ModDB that could not be reached", async () => {
    let giveUp: (reason: Error) => void = () => {}
    installMockWindowApi({
      netManager: {
        queryURL: vi.fn((url: string) => (url.endsWith("/mod/gone") ? Promise.resolve(NOT_FOUND) : new Promise<string>((_, reject) => (giveUp = reject))))
      }
    })
    const { result, rerender } = renderCatalog("gone")

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({ mod: null, failed: true, notFound: true })

    rerender({ modid: "offline" })

    // A new id starts from nothing: the last one's 404 says nothing about this one.
    expect(result.current).toMatchObject({ loading: true, failed: false, notFound: false })

    await act(async () => giveUp(new Error("offline")))

    expect(result.current).toMatchObject({ loading: false, failed: true, notFound: false })
  })

  it("clears notFound while a retry runs and when the id goes away", async () => {
    installMockWindowApi({ netManager: { queryURL: vi.fn(async () => NOT_FOUND) } })
    const { result, rerender } = renderCatalog("gone")

    await waitFor(() => expect(result.current.notFound).toBe(true))

    act(() => result.current.retry())
    expect(result.current).toMatchObject({ loading: true, failed: false, notFound: false })

    await waitFor(() => expect(result.current.notFound).toBe(true))

    rerender({ modid: null })

    expect(result.current).toMatchObject({ loading: false, failed: false, notFound: false })
  })
})
