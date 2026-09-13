import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const MANIFEST = JSON.stringify([{ id: "valley-ruins", name: "Valley Ruins", file: "valley-ruins.jpg", thumbnail: "thumbnails/valley-ruins.jpg", sha256: "a".repeat(64) }])

/**
 * #411: the caption clipped its descenders. It is a direct child of the tile button, so it takes
 * the `.text-trim-children` padding and its cancelling negative margin from styles.css, and an
 * absolutely positioned box is placed by its margin box: `bottom-0` plus a -0.3em bottom margin
 * put 0.3em of the caption past the tile's own `overflow-hidden`.
 *
 * jsdom has no layout engine, so this pins the class that keeps the fix rather than remeasuring
 * it. The measurement lives in the issue and in the packaged run on the PR.
 */
describe("ConfigPage background tile caption", () => {
  it("cancels the text trim's negative margin so the caption stays inside the tile", async () => {
    installMockWindowApi({
      configManager: { getConfig: async () => createMockConfig({ background: "default" }) },
      netManager: { queryURL: vi.fn(async () => MANIFEST) },
      backgroundsManager: { ensureBackground: vi.fn(async () => "current" as EnsureBackgroundResult) }
    })

    renderWithProviders(<ConfigPage />, { route: "/config" })

    const caption = await screen.findByText("Valley Ruins")

    expect(caption.className).toContain("!mb-0")
    // The pair that made it necessary: without the absolute placement there is no margin box to
    // push the caption out of the tile, and the pin would be pinning nothing.
    expect(caption.className).toContain("absolute")
    expect(caption.className).toContain("bottom-0")
  })
})
