import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ModDbVisibilityPrompt from "@renderer/components/layout/ModDbVisibilityPrompt"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import type { MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The ModDB listing question (#219), now asked once per launcher version (#477), which is as much
 * about what it must not do as what it does: no fetch without a click or a standing answer that
 * says yes, no answer recorded without one, and never twice for the same version.
 *
 * The recorded answer is read off `saveConfig`, which ConfigProvider calls with the whole config
 * whenever it changes. Nothing calling it at all is exactly what "records nothing" means here.
 *
 * The two answers that say yes are the exception: the main process writes those itself, before it
 * requests anything, so what this file checks there is that the component asks for them and only
 * mirrors what the main process says reached disk.
 */
const COUNT_ONCE = "Count me in (this version)"
const COUNT_ALWAYS = "Always count me in"
const NOT_THIS_TIME = "Not this time"
const NEVER_ASK = "Never ask again"

const RUNNING = "1.7.0-beta.10"
const BODY = /RiftLauncher is listed on ModDB/

const UNANSWERED: ConfigType["moddbVisibility"] = { policy: "ask", answeredVersion: "", countedVersions: [] }

function countResult(visibility: ConfigType["moddbVisibility"], reason: ModDbCountReason = "counted"): ModDbCountResult {
  return { reason, visibility }
}

function mountWith(moddbVisibility: ConfigType["moddbVisibility"], result: ModDbCountResult = countResult({ ...UNANSWERED, countedVersions: [RUNNING] })): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ moddbVisibility })) },
    utils: { getAppVersion: vi.fn(async () => RUNNING) },
    netManager: { countModDbDownload: vi.fn(async () => result) }
  })

  renderWithProviders(<ModDbVisibilityPrompt />)
  return api
}

/** The ModDB answer the last saveConfig call carried, or undefined when the config was never saved. */
function savedVisibility(api: MockedBridgeAPI): ConfigType["moddbVisibility"] | undefined {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls.at(-1)?.[0]?.moddbVisibility
}

describe("ModDbVisibilityPrompt", () => {
  it("reaches the bridge through the feature adapter instead of across the preload boundary", () => {
    // Read as text, the way tests/security-boundaries.test.ts checks the main process wiring: a
    // mounted component calls the same mock whichever side of the boundary it went through, so
    // nothing at runtime can tell the two apart.
    const source = readFileSync(resolve(__dirname, "../../src/renderer/src/components/layout/ModDbVisibilityPrompt.tsx"), "utf8")

    expect(source).not.toContain("window.api")
    expect(source).toContain('from "@renderer/features/moddb/adapters/moddb"')
  })

  it("asks on the first launch of a version nobody has answered for", async () => {
    mountWith(UNANSWERED)
    expect(await screen.findByText(BODY)).toBeTruthy()
  })

  it("asks again on a new version, whatever was answered for the last one", async () => {
    for (const policy of ["ask", "once"] as const) {
      mountWith({ policy, answeredVersion: "1.7.0-beta.9", countedVersions: policy === "once" ? ["1.7.0-beta.9"] : [] })
      expect(await screen.findByText(BODY)).toBeTruthy()
    }
  })

  it("stays out of the way once this version has been answered for", async () => {
    for (const moddbVisibility of [
      { policy: "ask" as const, answeredVersion: RUNNING, countedVersions: [] },
      { policy: "never" as const, answeredVersion: "1.7.0-beta.9", countedVersions: [] },
      { policy: "always" as const, answeredVersion: "1.7.0-beta.9", countedVersions: [RUNNING] }
    ]) {
      const api = mountWith(moddbVisibility)

      // Long enough for the config read to land and a prompt to appear if the guard were missing.
      await waitFor(() => expect(vi.mocked(api.configManager.getConfig)).toHaveBeenCalled())
      expect(screen.queryByText(BODY)).toBeNull()
      expect(vi.mocked(api.netManager.countModDbDownload)).not.toHaveBeenCalled()
    }
  })

  it("asks nothing before the stored answer has been read", () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(() => new Promise<ConfigType>(() => {})) } })
    renderWithProviders(<ModDbVisibilityPrompt />)

    expect(screen.queryByText(BODY)).toBeNull()
  })

  it("offers the four answers as equals, with none of them pre-armed", async () => {
    mountWith(UNANSWERED)
    await screen.findByText(BODY)

    const buttons = screen.getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual([COUNT_ONCE, COUNT_ALWAYS, NOT_THIS_TIME, NEVER_ASK])
    // Same classes on all four: no colour, no size and no emphasis pushing the yes.
    expect(new Set(buttons.map((button) => button.className)).size).toBe(1)
    // Nothing is focused into an Enter away from being accepted: the dialog panel itself takes the
    // initial focus, which is what Headless UI does when no element inside it claims it.
    expect(buttons.some((button) => button === document.activeElement)).toBe(false)
  })

  it("hands a one-version yes to the main process exactly once, and mirrors what reached disk", async () => {
    const user = userEvent.setup()
    const counted: ConfigType["moddbVisibility"] = { policy: "once", answeredVersion: RUNNING, countedVersions: [RUNNING] }
    const api = mountWith(UNANSWERED, countResult(counted))
    await screen.findByText(BODY)

    await user.click(screen.getByRole("button", { name: COUNT_ONCE }))

    await waitFor(() => expect(savedVisibility(api)).toEqual(counted))
    expect(vi.mocked(api.netManager.countModDbDownload).mock.calls).toEqual([["once"]])
    await waitFor(() => expect(screen.queryByText(BODY)).toBeNull())
  })

  it("hands a lasting yes over as always, so later versions are counted with no prompt", async () => {
    const user = userEvent.setup()
    const counted: ConfigType["moddbVisibility"] = { policy: "always", answeredVersion: RUNNING, countedVersions: [RUNNING] }
    const api = mountWith(UNANSWERED, countResult(counted))
    await screen.findByText(BODY)

    await user.click(screen.getByRole("button", { name: COUNT_ALWAYS }))

    await waitFor(() => expect(savedVisibility(api)).toEqual(counted))
    expect(vi.mocked(api.netManager.countModDbDownload).mock.calls).toEqual([["always"]])
  })

  it("leaves the answer unrecorded when the main process could not write it, so the question survives", async () => {
    // A refused write means nothing was requested either, so there is no count to remember and no
    // answer to keep. Mirroring it here anyway would silence a question that was never answered.
    const user = userEvent.setup()
    const api = mountWith(UNANSWERED, countResult(UNANSWERED, "not-saved"))
    await screen.findByText(BODY)

    await user.click(screen.getByRole("button", { name: COUNT_ONCE }))

    await waitFor(() => expect(vi.mocked(api.netManager.countModDbDownload)).toHaveBeenCalled())
    expect(savedVisibility(api)).toBeUndefined()

    // A relaunch is a fresh mount reading the same stored answer: still unanswered, so still asked.
    mountWith(UNANSWERED)
    expect(await screen.findByText(BODY)).toBeTruthy()
  })

  it("records a refusal for this version only, without fetching anything", async () => {
    const user = userEvent.setup()
    const api = mountWith(UNANSWERED)
    await screen.findByText(BODY)

    await user.click(screen.getByRole("button", { name: NOT_THIS_TIME }))

    await waitFor(() => expect(savedVisibility(api)).toEqual({ policy: "ask", answeredVersion: RUNNING, countedVersions: [] }))
    expect(vi.mocked(api.netManager.countModDbDownload)).not.toHaveBeenCalled()
  })

  it("records a refusal that lasts, without fetching anything", async () => {
    const user = userEvent.setup()
    const api = mountWith(UNANSWERED)
    await screen.findByText(BODY)

    await user.click(screen.getByRole("button", { name: NEVER_ASK }))

    await waitFor(() => expect(savedVisibility(api)).toEqual({ policy: "never", answeredVersion: RUNNING, countedVersions: [] }))
    expect(vi.mocked(api.netManager.countModDbDownload)).not.toHaveBeenCalled()
  })

  it("treats a dialog closed without an answer as no answer at all, so the question survives", async () => {
    const user = userEvent.setup()
    const api = mountWith(UNANSWERED)
    await screen.findByText(BODY)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByText(BODY)).toBeNull())
    expect(vi.mocked(api.configManager.saveConfig)).not.toHaveBeenCalled()
    expect(vi.mocked(api.netManager.countModDbDownload)).not.toHaveBeenCalled()

    // A relaunch is a fresh mount reading the same stored answer: still unanswered, so still asked.
    mountWith(UNANSWERED)
    expect(await screen.findByText(BODY)).toBeTruthy()
  })

  it("counts silently for a player who already said always, with no dialog", async () => {
    // No saveConfig assertion here, unlike the answers above: this count starts on mount, so its
    // mirror can land in the same render pass as the config's first read, where the provider has
    // nothing to save yet. What the main process wrote is already on disk either way; the mirror
    // is what keeps the renderer's copy from writing an older answer over it later.
    const counted: ConfigType["moddbVisibility"] = { policy: "always", answeredVersion: "1.7.0-beta.9", countedVersions: ["1.7.0-beta.9", RUNNING] }
    const api = mountWith({ policy: "always", answeredVersion: "1.7.0-beta.9", countedVersions: ["1.7.0-beta.9"] }, countResult(counted))

    await waitFor(() => expect(vi.mocked(api.netManager.countModDbDownload).mock.calls).toEqual([[null]]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText(BODY)).toBeNull()
    expect(vi.mocked(api.configManager.saveConfig).mock.calls.every((call) => call[0]?.moddbVisibility.policy === "always")).toBe(true)
  })

  it("asks the main process for the silent count once, even when the listing has no entry yet", async () => {
    // The answer stays pending for this version, so the state it mirrors still reads as owing a
    // count. That is a later launch's job, not a second round trip inside this one.
    const pending: ConfigType["moddbVisibility"] = { policy: "always", answeredVersion: "1.7.0-beta.9", countedVersions: [] }
    const api = mountWith(pending, countResult(pending, "no-entry"))

    await waitFor(() => expect(vi.mocked(api.netManager.countModDbDownload)).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(api.netManager.countModDbDownload).mock.calls).toEqual([[null]])
  })
})
