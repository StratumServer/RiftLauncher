import { describe, expect, it, vi, beforeEach } from "vitest"

import {
  clearStartupModUpdateNotice,
  getStartupModUpdateNotice,
  recordStartupModUpdateNotice,
  resetStartupModUpdateNoticesForTesting,
  resolveStartupModUpdateNotice
} from "../../src/renderer/src/features/mods/modUpdateNotices"

describe("modUpdateNotices", () => {
  beforeEach(() => {
    resetStartupModUpdateNoticesForTesting()
  })

  it("stores and retrieves notice id per installation", () => {
    recordStartupModUpdateNotice("install-1", "notice-1")
    recordStartupModUpdateNotice("install-2", "notice-2")

    expect(getStartupModUpdateNotice("install-1")).toBe("notice-1")
    expect(getStartupModUpdateNotice("install-2")).toBe("notice-2")
    expect(getStartupModUpdateNotice("install-3")).toBeUndefined()
  })

  it("clears notice id for a specific installation", () => {
    recordStartupModUpdateNotice("install-1", "notice-1")
    recordStartupModUpdateNotice("install-2", "notice-2")

    clearStartupModUpdateNotice("install-1")

    expect(getStartupModUpdateNotice("install-1")).toBeUndefined()
    expect(getStartupModUpdateNotice("install-2")).toBe("notice-2")
  })

  it("resolves and clears the notice when present (#752)", () => {
    recordStartupModUpdateNotice("install-1", "notice-1")
    const resolveNotification = vi.fn()

    const resolved = resolveStartupModUpdateNotice("install-1", resolveNotification)

    expect(resolved).toBe(true)
    expect(resolveNotification).toHaveBeenCalledWith("notice-1")
    expect(getStartupModUpdateNotice("install-1")).toBeUndefined()
  })

  it("returns false and does not call resolver when no notice was recorded", () => {
    const resolveNotification = vi.fn()

    const resolved = resolveStartupModUpdateNotice("unknown-install", resolveNotification)

    expect(resolved).toBe(false)
    expect(resolveNotification).not.toHaveBeenCalled()
  })
})
