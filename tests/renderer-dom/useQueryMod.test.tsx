import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

import { useQueryMod } from "@renderer/features/mods/hooks/useQueryMod"
import { installMockWindowApi } from "./helpers/windowApi"

const VALID_MOD_PAYLOAD = {
  statuscode: "200",
  mod: {
    modid: 42,
    assetid: 42,
    name: "Test Mod",
    releases: [
      {
        releaseid: 101,
        mainfile: "https://mods.example/test-1.0.0.zip",
        filename: "test-1.0.0.zip",
        fileid: 101,
        downloads: 10,
        tags: ["1.21.0"],
        modidstr: "testmod",
        modversion: "1.0.0",
        created: "2026-01-01",
        changelog: ""
      }
    ]
  }
}

describe("useQueryMod", () => {
  it("returns found mod when ModDB returns 200 with valid mod detail envelope", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(VALID_MOD_PAYLOAD))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(queryURL).toHaveBeenCalledWith("https://mods.vintagestory.at/api/mod/42")
    expect(outcome.status).toBe("found")
    if (outcome.status === "found") {
      expect(outcome.mod.modid).toBe(42)
      expect(outcome.mod.name).toBe("Test Mod")
    }
  })

  it("calls onFinish callback before returning found mod", async () => {
    const queryURL = vi.fn(async () => JSON.stringify(VALID_MOD_PAYLOAD))
    installMockWindowApi({ netManager: { queryURL } })
    const onFinish = vi.fn()

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42, onFinish })

    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(outcome.status).toBe("found")
  })

  it("returns not-found when ModDB returns a 404 envelope", async () => {
    const queryURL = vi.fn(async () => JSON.stringify({ statuscode: "404", message: "Not found" }))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 999 })

    expect(outcome).toEqual({ status: "not-found" })
  })

  it("returns failed without timeout when ModDB returns an unexpected status code", async () => {
    const queryURL = vi.fn(async () => JSON.stringify({ statuscode: "500", message: "Internal server error" }))
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(outcome).toEqual({ status: "failed" })
  })

  it("returns failed without timeout when ModDB returns a malformed non-JSON payload", async () => {
    const queryURL = vi.fn(async () => "<html>502 Bad Gateway</html>")
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(outcome).toEqual({ status: "failed" })
  })

  it("flags timeout when transport throws Network request timed out", async () => {
    const queryURL = vi.fn(async () => {
      throw new Error("Error invoking remote method 'query-url': Error: Network request timed out")
    })
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(outcome).toEqual({ status: "failed", timedOut: true })
  })

  it.each([
    ["net::ERR_TIMED_OUT", "Error invoking remote method 'query-url': Error: net::ERR_TIMED_OUT"],
    ["net::ERR_CONNECTION_TIMED_OUT", "Error invoking remote method 'query-url': Error: net::ERR_CONNECTION_TIMED_OUT"]
  ])("flags timeout when transport fails with Chromium connect timeout (%s, issue #750)", async (_code, errorMessage) => {
    const queryURL = vi.fn(async () => {
      throw new Error(errorMessage)
    })
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(outcome).toEqual({ status: "failed", timedOut: true })
  })

  it.each([
    ["net::ERR_CONNECTION_REFUSED", "Error invoking remote method 'query-url': Error: net::ERR_CONNECTION_REFUSED"],
    ["net::ERR_NAME_NOT_RESOLVED", "Error invoking remote method 'query-url': Error: net::ERR_NAME_NOT_RESOLVED"],
    ["generic error", "Error invoking remote method 'query-url': Error: Failed to fetch"]
  ])("does not flag timeout on quick connection errors (%s, issue #750)", async (_code, errorMessage) => {
    const queryURL = vi.fn(async () => {
      throw new Error(errorMessage)
    })
    installMockWindowApi({ netManager: { queryURL } })

    const { result } = renderHook(() => useQueryMod())
    const outcome = await result.current({ modid: 42 })

    expect(outcome).toEqual({ status: "failed", timedOut: false })
  })
})
