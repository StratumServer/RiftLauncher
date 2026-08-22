import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ModDbVisibilityPrompt from "@renderer/components/layout/ModDbVisibilityPrompt"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import type { MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The one-time ModDB listing question (#219), which is as much about what it must not do as what
 * it does: no fetch without a click, no answer recorded without a click, and no third launch of
 * the same question once any of the three buttons has been pressed.
 *
 * The recorded answer is read off `saveConfig`, which ConfigProvider calls with the whole config
 * whenever it changes. Nothing calling it at all is exactly what "records nothing" means here.
 */
const ACCEPT = "Count me in"
const DECLINE = "No thanks"
const ALREADY_DONE = "Already did it"

function mountWith(moddbVisibilityAnswer: string): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ moddbVisibilityAnswer })) },
    netManager: { fetchModDbListingArchive: vi.fn(async () => undefined) }
  })

  renderWithProviders(<ModDbVisibilityPrompt />)
  return api
}

/** The answer the last saveConfig call carried, or undefined when the config was never saved. */
function savedAnswer(api: MockedBridgeAPI): string | undefined {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls.at(-1)?.[0]?.moddbVisibilityAnswer
}

describe("ModDbVisibilityPrompt", () => {
  it("asks when the question has never been answered", async () => {
    mountWith("unasked")
    expect(await screen.findByText(/RiftLauncher is listed on ModDB/)).toBeTruthy()
  })

  it("stays out of the way once any of the three answers is on record", async () => {
    for (const answer of ["accepted", "declined", "already-done"]) {
      const api = mountWith(answer)

      // Long enough for the config read to land and a prompt to appear if the guard were missing.
      await waitFor(() => expect(vi.mocked(api.configManager.getConfig)).toHaveBeenCalled())
      expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull()
    }
  })

  it("asks nothing before the stored answer has been read", () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(() => new Promise<ConfigType>(() => {})) } })
    renderWithProviders(<ModDbVisibilityPrompt />)

    expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull()
  })

  it("offers the three answers as equals, with none of them pre-armed", async () => {
    mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    const buttons = screen.getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual([ACCEPT, DECLINE, ALREADY_DONE])
    // Same classes on all three: no colour, no size and no emphasis pushing the yes.
    expect(new Set(buttons.map((button) => button.className)).size).toBe(1)
    // Nothing is focused into an Enter away from being accepted: the dialog panel itself takes the
    // initial focus, which is what Headless UI does when no element inside it claims it.
    expect(buttons.some((button) => button === document.activeElement)).toBe(false)
  })

  it("fetches the listing archive exactly once when the player accepts, and records the answer", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: ACCEPT }))

    await waitFor(() => expect(savedAnswer(api)).toBe("accepted"))
    expect(vi.mocked(api.netManager.fetchModDbListingArchive)).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull())
  })

  it("records a refusal without fetching anything", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: DECLINE }))

    await waitFor(() => expect(savedAnswer(api)).toBe("declined"))
    expect(vi.mocked(api.netManager.fetchModDbListingArchive)).not.toHaveBeenCalled()
  })

  it("records an already-done without fetching anything, since that download is already counted", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: ALREADY_DONE }))

    await waitFor(() => expect(savedAnswer(api)).toBe("already-done"))
    expect(vi.mocked(api.netManager.fetchModDbListingArchive)).not.toHaveBeenCalled()
  })

  it("treats a dialog closed without an answer as no answer at all, so the question survives", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull())
    expect(vi.mocked(api.configManager.saveConfig)).not.toHaveBeenCalled()
    expect(vi.mocked(api.netManager.fetchModDbListingArchive)).not.toHaveBeenCalled()

    // A relaunch is a fresh mount reading the same stored answer: still unasked, so still asked.
    mountWith("unasked")
    expect(await screen.findByText(/RiftLauncher is listed on ModDB/)).toBeTruthy()
  })
})
