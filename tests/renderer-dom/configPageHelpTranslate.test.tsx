/**
 * The "Help translate" link under the language choice on the settings page.
 *
 * Translation happens on Hosted Weblate, so the page offers the project's engage page next to the
 * one control that picks the language, with a line saying where it leads. The link goes through
 * the same browser bridge as every other external link; the main process opens it only because its
 * host is on the allow-list, which tests/ipc-validation.test.ts holds still from the other side.
 */
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const LABEL = "Help translate RiftLauncher"
const ENGAGE_URL = "https://hosted.weblate.org/engage/riftlauncher/"

function renderConfigPage(): MockedBridgeAPI {
  const api = installMockWindowApi({
    // The background section fetches its catalog on mount. An empty list keeps it out of the way.
    netManager: { queryURL: vi.fn(async () => "[]") }
  })

  renderWithProviders(<ConfigPage />, { route: "/config" })
  return api
}

describe("ConfigPage help translate link", () => {
  it("offers the link with its label, and a line saying translation happens in the browser", async () => {
    renderConfigPage()

    expect(await screen.findByRole("button", { name: LABEL })).toBeTruthy()
    expect(screen.getByText(/Translation happens on Weblate, in your browser/)).toBeTruthy()
  })

  it("opens the project's engage page once, and nothing else", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    await user.click(await screen.findByRole("button", { name: LABEL }))

    expect(vi.mocked(api.utils.openOnBrowser).mock.calls).toEqual([[ENGAGE_URL]])
  })
})
