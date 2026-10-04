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
})
