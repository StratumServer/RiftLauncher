/**
 * The ModDB download count row on the settings page (#477).
 *
 * The row is where a lasting answer is changed after the fact, in both directions, without going
 * looking for a config file. It offers three choices where the prompt offers four: a yes that only
 * covered one version reads here as "ask each version", because that is what it means for every
 * version after it.
 *
 * Picking something here records an answer and nothing else. No count is made from the settings
 * page: a launch is what counts, if the answer says to.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const ASK = "Ask each version"
const ALWAYS = "Always count me in"
const NEVER = "Never count"

function renderConfigPage(moddbVisibility: ConfigType["moddbVisibility"]): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: async () => createMockConfig({ moddbVisibility }) },
    utils: { getAppVersion: vi.fn(async () => "1.7.0-beta.10") },
    // The background section fetches its catalog on mount. An empty list keeps it out of the way.
    netManager: { queryURL: vi.fn(async () => "[]") }
  })

  renderWithProviders(<ConfigPage />, { route: "/config" })
  return api
}

/** The row's trigger, found through the description it carries as its tooltip, the way the beta toggle is. */
async function trigger(): Promise<HTMLElement> {
  return (await screen.findAllByTitle(/How the launcher answers the ModDB question/))[0] as HTMLElement
}

/** The ModDB answer the last saveConfig call carried. */
function savedVisibility(api: MockedBridgeAPI): ConfigType["moddbVisibility"] | undefined {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls.at(-1)?.[0]?.moddbVisibility
}

describe("ConfigPage ModDB download count", () => {
  it("shows the stored answer", async () => {
    renderConfigPage({ policy: "always", answeredVersion: "1.7.0-beta.10", countedVersions: [] })
    expect((await trigger()).textContent).toContain(ALWAYS)
  })

  it("reads a yes that only covered one version as asking again on the next one", async () => {
    renderConfigPage({ policy: "once", answeredVersion: "1.7.0-beta.10", countedVersions: ["1.7.0-beta.10"] })
    expect((await trigger()).textContent).toContain(ASK)
  })

  it("records a lasting yes, leaving what has already been counted alone", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage({ policy: "ask", answeredVersion: "1.7.0-beta.10", countedVersions: ["1.7.0-beta.9"] })

    await user.click(await trigger())
    await user.click(await screen.findByRole("option", { name: ALWAYS }))

    await waitFor(() => expect(savedVisibility(api)).toEqual({ policy: "always", answeredVersion: "1.7.0-beta.10", countedVersions: ["1.7.0-beta.9"] }))
    // The row answers a question; only a launch counts anything.
    expect(vi.mocked(api.netManager.countModDbDownload)).not.toHaveBeenCalled()
  })

  it("records a refusal that lasts", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage({ policy: "always", answeredVersion: "1.7.0-beta.10", countedVersions: [] })

    await user.click(await trigger())
    await user.click(await screen.findByRole("option", { name: NEVER }))

    await waitFor(() => expect(savedVisibility(api)?.policy).toBe("never"))
  })

  it("puts the question back for a player who had said never", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage({ policy: "never", answeredVersion: "1.7.0-beta.9", countedVersions: [] })

    await user.click(await trigger())
    await user.click(await screen.findByRole("option", { name: ASK }))

    await waitFor(() => expect(savedVisibility(api)?.policy).toBe("ask"))
  })
})
