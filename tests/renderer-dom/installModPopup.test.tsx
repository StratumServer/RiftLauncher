import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const LOAD_FAILED = "This Mod's version list couldn't be loaded. Check your connection and try again."

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

/** One `/api/mod/{id}` payload, the shape the popup's release table reads. */
function aModDetail(): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid: 42,
      assetid: 4242,
      name: "Cool Mod",
      releases: [
        {
          releaseid: 1,
          mainfile: "https://mods.example/coolmod-1.2.0.zip",
          filename: "coolmod-1.2.0.zip",
          fileid: 1,
          downloads: 0,
          tags: ["1.20.0"],
          modidstr: "coolmod",
          modversion: "1.2.0",
          created: "2026-01-02T00:00:00Z",
          changelog: ""
        }
      ]
    }
  })
}

function renderPopup({ queryURL, modName }: { queryURL: () => Promise<string>; modName?: string }): void {
  installMockWindowApi({ netManager: { queryURL: vi.fn(queryURL) } })

  renderWithProviders(
    <TaskProvider>
      <InstallModPopup modToInstall="coolmod" setModToInstall={() => {}} modName={modName} installation={{ installation: anInstallation() }} />
    </TaskProvider>
  )
}

describe("InstallModPopup", () => {
  it("renders the release table once the ModDB answers", async () => {
    renderPopup({ queryURL: async () => aModDetail() })

    expect(await screen.findByText("1.2.0")).toBeTruthy()
    expect(screen.getByText("List of versions of the Cool Mod Mod")).toBeTruthy()
    expect(screen.queryByText(LOAD_FAILED)).toBeNull()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("shows the failure sentence and a retry instead of spinning when the versions query rejects", async () => {
    renderPopup({ queryURL: async () => Promise.reject(new Error("Network request timed out")) })

    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy()
    expect(screen.getByTitle("Reload")).toBeTruthy()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("shows the same failure state when the ModDB answers with something unusable", async () => {
    renderPopup({ queryURL: async () => JSON.stringify({ statuscode: "500" }) })

    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy()
    expect(screen.getByTitle("Reload")).toBeTruthy()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("renders the versions after a retry that succeeds", async () => {
    const user = userEvent.setup()
    let calls = 0
    renderPopup({
      queryURL: async () => {
        calls++
        if (calls === 1) return Promise.reject(new Error("Network request timed out"))
        return aModDetail()
      }
    })

    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy()

    await user.click(screen.getByTitle("Reload"))

    await waitFor(() => expect(screen.queryByText(LOAD_FAILED)).toBeNull())
    expect(await screen.findByText("1.2.0")).toBeTruthy()
    expect(calls).toBe(2)
  })

  it("names the Mod from the clicked row when the lookup failed", async () => {
    renderPopup({ queryURL: async () => Promise.reject(new Error("Network request timed out")), modName: "Cool Mod" })

    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy()
    expect(screen.getByText("List of versions of the Cool Mod Mod")).toBeTruthy()
    expect(screen.queryByText(/MOD NOT FOUND/)).toBeNull()
  })

  it("falls back to the ModID when the clicked row carried no name", async () => {
    renderPopup({ queryURL: async () => Promise.reject(new Error("Network request timed out")) })

    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy()
    expect(screen.getByText("List of versions of the coolmod Mod")).toBeTruthy()
    expect(screen.queryByText(/MOD NOT FOUND/)).toBeNull()
  })

  it("queries nothing and renders nothing while it is closed", async () => {
    const queryURL = vi.fn(async () => aModDetail())
    installMockWindowApi({ netManager: { queryURL } })

    renderWithProviders(
      <TaskProvider>
        <InstallModPopup modToInstall={null} setModToInstall={() => {}} installation={{ installation: anInstallation() }} />
      </TaskProvider>
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(queryURL).not.toHaveBeenCalled()
  })
})
