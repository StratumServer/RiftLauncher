import { beforeEach, describe, expect, it, vi } from "vitest"
import { recordStartupModUpdateNotice, resetStartupModUpdateNoticesForTests, resolveStartupModUpdateNotice } from "../../src/renderer/src/features/mods/modUpdateNotices"

describe("startup mod update notices", () => {
  beforeEach(resetStartupModUpdateNoticesForTests)

  it("resolves every notice for the installation once and leaves other installations alone", () => {
    recordStartupModUpdateNotice("install-a", "notice-1")
    recordStartupModUpdateNotice("install-a", "notice-2")
    recordStartupModUpdateNotice("install-a", "notice-2")
    recordStartupModUpdateNotice("install-b", "notice-3")
    const resolve = vi.fn()
    resolveStartupModUpdateNotice("install-a", resolve)
    resolveStartupModUpdateNotice("install-a", resolve)
    expect(resolve.mock.calls).toEqual([["notice-1"], ["notice-2"]])
    resolveStartupModUpdateNotice("install-b", resolve)
    expect(resolve).toHaveBeenLastCalledWith("notice-3")
  })
})
