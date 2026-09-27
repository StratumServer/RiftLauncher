import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
import InstallationsDropdownMenu from "@renderer/features/installations/components/InstallationsDropdownMenu"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The mod count an Installation shows before anything has counted its mods
 * (review on PR #506).
 *
 * `_modsCount` is filled in by ConfigProvider's delayed scan, two and a half
 * seconds after the config is read, so every Installation loaded from disk
 * spends the start of each session without one. It used to read as a blank
 * number, because the bare `modsCount` key interpolated an undefined count into
 * its text. With the bare key gone (issue #496), an undefined count selects no
 * plural form at all and the screen shows the raw key instead, which is what
 * these two render before the fix.
 */

/** An Installation as it comes off disk: no _modsCount, because nothing has scanned it yet. */
function unscannedInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    ...overrides
  }
}

const config = (): ConfigType =>
  createMockConfig({
    lastUsedInstallation: "install-a",
    gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/versions/1.20.0" }],
    installations: [unscannedInstallation()]
  })

describe("mod count shown before the delayed scan has run (#506)", () => {
  it("shows a counted sentence on the Installations list, not the translation key", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => config()) } })
    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    await screen.findByText("Install A")
    expect(screen.queryByText("features.mods.modsCount")).toBeNull()
    expect(screen.getByText("0 Mods")).toBeTruthy()
  })

  it("shows a counted sentence in the Installations drop-up, not the translation key", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => config()) } })
    renderWithProviders(<InstallationsDropdownMenu />, { route: "/" })

    await screen.findByText("Install A")
    expect(screen.queryByText("features.mods.modsCount")).toBeNull()
    expect(screen.getByText("0 Mods")).toBeTruthy()
  })
})
