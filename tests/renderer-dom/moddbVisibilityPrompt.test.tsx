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
 * The one-time ModDB listing question (#219), which is as much about what it must not do as what
 * it does: no fetch without a click, no answer recorded without a click, and no third launch of
 * the same question once any of the three buttons has been pressed.
 *
 * The recorded answer is read off `saveConfig`, which ConfigProvider calls with the whole config
 * whenever it changes. Nothing calling it at all is exactly what "records nothing" means here.
 *
 * "Count me in" is the exception: the main process writes that answer itself, before it requests
 * anything, so what this file checks there is that the component asks for it and only mirrors it
 * into the config once the main process says it reached disk.
 */
const ACCEPT = "Count me in"
const DECLINE = "No thanks"
const ALREADY_DONE = "Already did it"

function mountWith(moddbVisibilityAnswer: string, accepted = true): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ moddbVisibilityAnswer })) },
    netManager: { acceptModDbVisibility: vi.fn(async () => accepted) }
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
  it("reaches the bridge through the feature adapter instead of across the preload boundary", () => {
    // Read as text, the way tests/security-boundaries.test.ts checks the main process wiring: a
    // mounted component calls the same mock whichever side of the boundary it went through, so
    // nothing at runtime can tell the two apart.
    const source = readFileSync(resolve(__dirname, "../../src/renderer/src/components/layout/ModDbVisibilityPrompt.tsx"), "utf8")

    expect(source).not.toContain("window.api")
    expect(source).toContain('from "@renderer/features/moddb/adapters/moddb"')
  })

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

  it("hands the acceptance to the main process exactly once, and mirrors it once it is on disk", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: ACCEPT }))

    await waitFor(() => expect(savedAnswer(api)).toBe("accepted"))
    expect(vi.mocked(api.netManager.acceptModDbVisibility)).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull())
  })

  it("leaves the answer unrecorded when the main process could not write it, so the question survives", async () => {
    // A refused write means nothing was requested either, so there is no count to remember and no
    // answer to keep. Mirroring it here anyway would silence a question that was never answered.
    const user = userEvent.setup()
    const api = mountWith("unasked", false)
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: ACCEPT }))

    await waitFor(() => expect(vi.mocked(api.netManager.acceptModDbVisibility)).toHaveBeenCalled())
    expect(savedAnswer(api)).toBeUndefined()

    // A relaunch is a fresh mount reading the same stored answer: still unasked, so still asked.
    mountWith("unasked")
    expect(await screen.findByText(/RiftLauncher is listed on ModDB/)).toBeTruthy()
  })

  it("records a refusal without fetching anything", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: DECLINE }))

    await waitFor(() => expect(savedAnswer(api)).toBe("declined"))
    expect(vi.mocked(api.netManager.acceptModDbVisibility)).not.toHaveBeenCalled()
  })

  it("records an already-done without fetching anything, since that download is already counted", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.click(screen.getByRole("button", { name: ALREADY_DONE }))

    await waitFor(() => expect(savedAnswer(api)).toBe("already-done"))
    expect(vi.mocked(api.netManager.acceptModDbVisibility)).not.toHaveBeenCalled()
  })

  it("treats a dialog closed without an answer as no answer at all, so the question survives", async () => {
    const user = userEvent.setup()
    const api = mountWith("unasked")
    await screen.findByText(/RiftLauncher is listed on ModDB/)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByText(/RiftLauncher is listed on ModDB/)).toBeNull())
    expect(vi.mocked(api.configManager.saveConfig)).not.toHaveBeenCalled()
    expect(vi.mocked(api.netManager.acceptModDbVisibility)).not.toHaveBeenCalled()

    // A relaunch is a fresh mount reading the same stored answer: still unasked, so still asked.
    mountWith("unasked")
    expect(await screen.findByText(/RiftLauncher is listed on ModDB/)).toBeTruthy()
  })
})
