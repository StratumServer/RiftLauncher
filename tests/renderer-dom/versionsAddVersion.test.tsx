import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AddVersion from "@renderer/features/versions/pages/AddVersion"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/** Optimum's published overlay, in the shape the bridge hands the page. */
function anOptimumManifest(overrides: Partial<OptimumManifestInfo> = {}): OptimumManifestInfo {
  return {
    optimumVersion: "0.3.14",
    supportedGameVersions: ["1.20.4"],
    downloadUrl: "https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-linux-x64-overlay.tar.gz",
    downloadFolder: "/userdata/Cache/Optimum",
    archiveFileName: "Optimum-v0.3.14-linux-x64-overlay.tar.gz",
    ...overrides
  }
}

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

  /** #411, the same refusal the Add Installation folder field carried: Browse grants the path, typing does not. */
  it("takes its install folder from Browse only", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultVersionsFolder: "/versions" })) },
      netManager: { queryURL: vi.fn(async (url: string) => (url.endsWith("stable.json") ? JSON.stringify(STABLE) : JSON.stringify({}))) }
    })

    renderAddVersion()

    await user.click(await screen.findByText("1.20.4"))

    const folder = (await screen.findByPlaceholderText("VS Version folder")) as HTMLInputElement
    await waitFor(() => expect(folder.value).toBe("/versions/1.20.4"))

    expect(folder.readOnly).toBe(true)
    await user.type(folder, "/somewhere/else")
    expect(folder.value).toBe("/versions/1.20.4")
  })

  it("renders the failure sentence with no spinner when the catalog fetch fails", async () => {
    installMockWindowApi({
      netManager: { queryURL: vi.fn(async () => Promise.reject(new Error("Network request failed"))) }
    })

    renderAddVersion()

    expect(await screen.findByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeTruthy()
    expect(screen.getByTitle("Reload")).toBeTruthy()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("fails closed when a catalog is not an object of versions", async () => {
    const queryURL = vi.fn(async (url: string) => (url.endsWith("stable.json") ? '"hello"' : JSON.stringify({})))
    installMockWindowApi({ netManager: { queryURL } })

    renderAddVersion()

    expect(await screen.findByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeTruthy()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("keeps the good versions when one row carries a malformed build", async () => {
    const catalog = { ...STABLE, "1.20.5": { windows: { filename: "vs_client_win-x64_1.20.5.exe", urls: { cdn: 999, local: "" } } } }
    const queryURL = vi.fn(async (url: string) => (url.endsWith("stable.json") ? JSON.stringify(catalog) : JSON.stringify({})))
    installMockWindowApi({ netManager: { queryURL } })

    renderAddVersion()

    expect(await screen.findByText("1.20.5")).toBeTruthy()
    expect(screen.getByText("1.20.4")).toBeTruthy()
    expect(screen.queryByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeNull()
  })

  it("fails closed when both catalogs are empty", async () => {
    installMockWindowApi({ netManager: { queryURL: vi.fn(async () => JSON.stringify({})) } })

    renderAddVersion()

    expect(await screen.findByText("The VS Version list couldn't be loaded. Check your connection and try again.")).toBeTruthy()
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

  /**
   * The one control the fork adds to this page. It is offered only when the
   * session manifest covers both the machine and the version in the table, and
   * it says which of the two is missing rather than going quiet.
   */
  describe("the build choice", () => {
    function withOptimum(result: OptimumManifestResult): void {
      installMockWindowApi({
        netManager: { queryURL: vi.fn(async (url: string) => (url.endsWith("stable.json") ? JSON.stringify(STABLE) : JSON.stringify({}))) },
        optimumManager: { getManifest: vi.fn(async () => result) }
      })
    }

    it("offers Optimum by name once the manifest covers the selected version", async () => {
      withOptimum({ ok: true, manifest: anOptimumManifest() })

      renderAddVersion()
      await screen.findByText("1.20.4")

      const optimum = (await screen.findByLabelText("Optimum 0.3.14")) as HTMLInputElement
      expect(optimum.disabled).toBe(false)
      expect((screen.getByLabelText("Official") as HTMLInputElement).checked).toBe(true)
    })

    it("picks Optimum when the player asks for it, and keeps the pair exclusive", async () => {
      const user = userEvent.setup()
      withOptimum({ ok: true, manifest: anOptimumManifest() })

      renderAddVersion()
      await screen.findByText("1.20.4")

      await user.click(await screen.findByLabelText("Optimum 0.3.14"))

      expect((screen.getByLabelText("Optimum 0.3.14") as HTMLInputElement).checked).toBe(true)
      expect((screen.getByLabelText("Official") as HTMLInputElement).checked).toBe(false)
    })

    it("disables the choice with one line when the machine has no build", async () => {
      withOptimum({ ok: false, reason: "unsupported-system" })

      renderAddVersion()
      await screen.findByText("1.20.4")

      expect(((await screen.findByLabelText("Optimum")) as HTMLInputElement).disabled).toBe(true)
      expect(screen.getByText("Optimum has no build for this system.")).toBeTruthy()
    })

    it("disables the choice with one line when the version has no build yet", async () => {
      withOptimum({ ok: true, manifest: anOptimumManifest({ supportedGameVersions: ["1.22.7"] }) })

      renderAddVersion()
      await screen.findByText("1.20.4")

      expect(((await screen.findByLabelText("Optimum 0.3.14")) as HTMLInputElement).disabled).toBe(true)
      expect(screen.getByText("Optimum has no build for this version yet.")).toBeTruthy()
    })

    it("says the list could not be reached rather than blaming the version", async () => {
      withOptimum({ ok: false, reason: "unreachable" })

      renderAddVersion()
      await screen.findByText("1.20.4")

      expect(screen.getByText("Optimum's list of builds couldn't be reached. Check your connection and open this page again.")).toBeTruthy()
    })
  })
})
