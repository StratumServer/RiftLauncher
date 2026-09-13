import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** The block that stands in for the Version picker's rows when nothing is installed. */
function versionNotice(): HTMLElement {
  const headline = screen.getByText(/No VS Versions found/)
  const block = headline.closest("div")
  expect(block).toBeTruthy()
  return block as HTMLElement
}

/**
 * #411: Add Installation with no game version installed refused to save with "Fill in every
 * field before saving." and highlighted nothing, because the field that was missing rendered
 * as an information block rather than as an invalid field.
 */
describe("AddInstallation version picker", () => {
  it("wears the invalid-field treatment when no game version is installed", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [] })) } })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    const block = await screen.findByText(/No VS Versions found/)
    expect(block.className).toContain("text-red-400")

    // The same border and fill FormInputText paints on a `user-invalid` input.
    const classes = versionNotice().className
    expect(classes).toContain("border-red-800")
    expect(classes).toContain("bg-red-800/20")
  })

  it("shows no such block once a game version is installed", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/installations", gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }] }))
      }
    })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    expect(await screen.findByText("1.20.0")).toBeTruthy()
    // The empty-state block sits beside the row inside the same AnimatePresence
    // (see GameVersionPicker/TableBody): its removal is a DOM mutation the row's
    // own appearance does not wait on, so a bare queryByText right after
    // findByText can catch it a tick before it clears, the way the analogous
    // checks in versionsListVersions.test.tsx already wait for it.
    await waitFor(() => expect(screen.queryByText(/No VS Versions found/)).toBeNull())
  })
})
