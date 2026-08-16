import { afterEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import AddVersion from "@renderer/features/versions/pages/AddVersion"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

describe("AddVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders the catalog list fetched from the stable/unstable game version API", async () => {
    installMockWindowApi()

    const stable = {
      "1.20.4": {
        windows: { filename: "vs_client_win-x64_1.20.4.exe", urls: { cdn: "https://cdn.vintagestory.at/win.exe", local: "" } },
        linux: { filename: "vs_client_linux-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/linux.tar.gz", local: "" } },
        "mac-x64": { filename: "vs_client_mac-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/mac.tar.gz", local: "" } }
      }
    }
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("stable.json") ? jsonResponse(stable) : jsonResponse({})))
    vi.stubGlobal("fetch", fetchMock)

    renderWithProviders(
      <TaskProvider>
        <AddVersion />
      </TaskProvider>,
      { route: "/versions/add" }
    )

    expect(await screen.findByText("1.20.4")).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith("https://api.vintagestory.at/stable.json")
    expect(fetchMock).toHaveBeenCalledWith("https://api.vintagestory.at/unstable.json")
  })
})
