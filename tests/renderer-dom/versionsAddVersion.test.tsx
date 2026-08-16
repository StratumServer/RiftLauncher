import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AddVersion from "@renderer/features/versions/pages/AddVersion"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const STABLE = {
  "1.20.4": {
    windows: { filename: "vs_client_win-x64_1.20.4.exe", urls: { cdn: "https://cdn.vintagestory.at/win.exe", local: "" } },
    linux: { filename: "vs_client_linux-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/linux.tar.gz", local: "" } },
    "mac-x64": { filename: "vs_client_mac-x64_1.20.4.tar.gz", urls: { cdn: "https://cdn.vintagestory.at/mac.tar.gz", local: "" } }
  }
}

function renderAddVersion(): void {
  renderWithProviders(
    <TaskProvider>
      <AddVersion />
    </TaskProvider>,
    { route: "/versions/add" }
  )
}

describe("AddVersion", () => {
  it("renders the catalog list fetched through the netManager IPC channel", async () => {
    const queryURL = vi.fn(async (url: string) => (url.endsWith("stable.json") ? JSON.stringify(STABLE) : JSON.stringify({})))
    installMockWindowApi({ netManager: { queryURL } })

    renderAddVersion()

    expect(await screen.findByText("1.20.4")).toBeTruthy()
    expect(queryURL).toHaveBeenCalledWith("https://api.vintagestory.at/stable.json")
    expect(queryURL).toHaveBeenCalledWith("https://api.vintagestory.at/unstable.json")
  })

  it("renders the failure sentence with no spinner when the catalog fetch fails", async () => {
    installMockWindowApi({
      netManager: { queryURL: vi.fn(async () => Promise.reject(new Error("Network request failed"))) }
    })

    renderAddVersion()

    expect(await screen.findByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeTruthy()
    expect(screen.queryByTitle("Reload")).toBeTruthy()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("retries and clears the error once the catalog fetch succeeds", async () => {
    const user = userEvent.setup()
    const queryURL = vi.fn(async (url: string) => {
      if (queryURL.mock.calls.length <= 2) return Promise.reject(new Error("Network request failed"))
      return url.endsWith("stable.json") ? JSON.stringify(STABLE) : JSON.stringify({})
    })
    installMockWindowApi({ netManager: { queryURL } })

    renderAddVersion()

    expect(await screen.findByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeTruthy()

    await user.click(screen.getByTitle("Reload"))

    await waitFor(() => expect(screen.queryByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeNull())
    expect(await screen.findByText("1.20.4")).toBeTruthy()
    expect(queryURL.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
