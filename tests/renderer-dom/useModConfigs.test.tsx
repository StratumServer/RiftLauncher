import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

import { useModConfigs } from "@renderer/features/mods/hooks/useModConfigs"

import { installMockWindowApi } from "./helpers/windowApi"

/**
 * The one value both callers of this hook exist to read correctly.
 *
 * `undefined` is "the host has not answered". Both callers would act wrongly on it if it were
 * folded into the empty folder: the export checkbox would appear next to a count of nothing, and
 * the import dialog would tick every row of a pack as new on an Installation whose configs it never
 * saw. These tests pin that third state and the two ways a question can end badly.
 */
describe("useModConfigs", () => {
  it("is undefined before the answer and undefined again when the Installation changes", async () => {
    const answers: ModConfigsReadResult[] = [
      { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] },
      { ok: true, configs: [], linked: [] }
    ]
    const getModConfigs = vi.fn(async () => answers[getModConfigs.mock.calls.length === 1 ? 0 : 1] as ModConfigsReadResult)
    installMockWindowApi({ modsManager: { getModConfigs } })

    const { result, rerender } = renderHook(({ path }) => useModConfigs(path), { initialProps: { path: "/games/a" } })
    expect(result.current.listing).toBeUndefined()

    await waitFor(() => expect(result.current.listing).toEqual({ ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] }))

    rerender({ path: "/games/b" })
    // The old answer is not left standing for an Installation it says nothing about.
    expect(result.current.listing).toBeUndefined()
    await waitFor(() => expect(result.current.listing).toEqual({ ok: true, configs: [], linked: [] }))
  })

  it("turns a failed question into the named refusal, not an unhandled rejection and not an empty folder", async () => {
    installMockWindowApi({ modsManager: { getModConfigs: vi.fn(async () => Promise.reject(new Error("the host is gone"))) } })

    const { result } = renderHook(() => useModConfigs("/games/a"))

    await waitFor(() => expect(result.current.listing).toEqual({ ok: false, reason: "mod-config-unreadable" }))
  })

  it("does not set state after the component that asked is gone", async () => {
    // The whole reason the effect keeps a `live` flag: an Installation page closed while its
    // Installation's ModConfig folder was being walked is ordinary, and a setState on a gone
    // component is the crash that makes it not ordinary.
    let answer: (value: ModConfigsReadResult) => void = () => {}
    installMockWindowApi({ modsManager: { getModConfigs: vi.fn(() => new Promise<ModConfigsReadResult>((resolve) => (answer = resolve))) } })

    const { result, unmount } = renderHook(() => useModConfigs("/games/a"))
    unmount()
    await act(async () => void answer({ ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] }))

    expect(result.current.listing).toBeUndefined()
  })

  it("shares one listing across callers mounted for the same Installation and updates all of them on refresh (#591)", async () => {
    const firstListing: ModConfigsReadResult = { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] }
    const refreshedListing: ModConfigsReadResult = {
      ok: true,
      configs: [
        { name: "a.json", bytes: 2 },
        { name: "b.json", bytes: 4 }
      ],
      linked: []
    }
    let resolveRefresh: (value: ModConfigsReadResult) => void = () => {}
    const getModConfigs = vi
      .fn<() => Promise<ModConfigsReadResult>>()
      .mockResolvedValueOnce(firstListing)
      .mockImplementationOnce(() => new Promise<ModConfigsReadResult>((resolve) => (resolveRefresh = resolve)))
    installMockWindowApi({ modsManager: { getModConfigs } })

    const first = renderHook(() => useModConfigs("/games/a"))
    const second = renderHook(() => useModConfigs("/games/a"))

    await waitFor(() => expect(first.result.current.listing).toEqual(firstListing))
    expect(second.result.current.listing).toEqual(firstListing)
    expect(getModConfigs).toHaveBeenCalledTimes(1)

    act(() => {
      second.result.current.refresh()
    })

    // Both callers clear back to undefined while the refresh walk is in flight so neither acts on a stale list.
    expect(first.result.current.listing).toBeUndefined()
    expect(second.result.current.listing).toBeUndefined()

    await act(async () => void resolveRefresh(refreshedListing))
    expect(first.result.current.listing).toEqual(refreshedListing)
    expect(second.result.current.listing).toEqual(refreshedListing)
    expect(getModConfigs).toHaveBeenCalledTimes(2)
  })

  it("ignores an earlier in-flight answer that settles after a newer refresh (#591)", async () => {
    const staleListing: ModConfigsReadResult = { ok: true, configs: [{ name: "stale.json", bytes: 2 }], linked: [] }
    const freshListing: ModConfigsReadResult = { ok: true, configs: [{ name: "fresh.json", bytes: 4 }], linked: [] }
    const resolvers: ((value: ModConfigsReadResult) => void)[] = []
    const getModConfigs = vi.fn(() => new Promise<ModConfigsReadResult>((resolve) => resolvers.push(resolve)))
    installMockWindowApi({ modsManager: { getModConfigs } })

    const { result } = renderHook(() => useModConfigs("/games/a"))
    expect(getModConfigs).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.refresh()
    })
    expect(getModConfigs).toHaveBeenCalledTimes(2)

    await act(async () => void resolvers[1]?.(freshListing))
    expect(result.current.listing).toEqual(freshListing)

    await act(async () => void resolvers[0]?.(staleListing))
    expect(result.current.listing).toEqual(freshListing)
  })

  it("reads the settled listing immediately when switching to an Installation another caller already holds (#591)", async () => {
    const listingA: ModConfigsReadResult = { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] }
    const listingB: ModConfigsReadResult = { ok: true, configs: [{ name: "b.json", bytes: 4 }], linked: [] }
    const getModConfigs = vi.fn(async (path: string): Promise<ModConfigsReadResult> => (path === "/games/a" ? listingA : listingB))
    installMockWindowApi({ modsManager: { getModConfigs } })

    const holderB = renderHook(() => useModConfigs("/games/b"))
    const switcher = renderHook(({ path }) => useModConfigs(path), { initialProps: { path: "/games/a" } })

    await waitFor(() => expect(holderB.result.current.listing).toEqual(listingB))
    await waitFor(() => expect(switcher.result.current.listing).toEqual(listingA))

    switcher.rerender({ path: "/games/b" })
    expect(switcher.result.current.listing).toEqual(listingB)
    expect(getModConfigs).toHaveBeenCalledTimes(2)
  })

  it("drops the cached listing once every caller for that Installation has unmounted (#591)", async () => {
    const firstVisit: ModConfigsReadResult = { ok: true, configs: [{ name: "a.json", bytes: 2 }], linked: [] }
    const secondVisit: ModConfigsReadResult = { ok: true, configs: [{ name: "b.json", bytes: 4 }], linked: [] }
    const getModConfigs = vi.fn<() => Promise<ModConfigsReadResult>>().mockResolvedValueOnce(firstVisit).mockResolvedValueOnce(secondVisit)
    installMockWindowApi({ modsManager: { getModConfigs } })

    const first = renderHook(() => useModConfigs("/games/a"))
    await waitFor(() => expect(first.result.current.listing).toEqual(firstVisit))
    first.unmount()

    const next = renderHook(() => useModConfigs("/games/a"))
    expect(next.result.current.listing).toBeUndefined()
    await waitFor(() => expect(next.result.current.listing).toEqual(secondVisit))
    expect(getModConfigs).toHaveBeenCalledTimes(2)
  })
})
