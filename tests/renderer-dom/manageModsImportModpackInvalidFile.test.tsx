import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { mountManageMods } from "./helpers/mountManageMods"

function anInstallation(): InstallationType {
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
    envVars: ""
  }
}

function renderManageMods(overrides: WindowApiOverrides = {}): ReturnType<typeof mountManageMods> {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })), ...overrides.modsManager }
  })

  return mountManageMods()
}

/**
 * Reproduces #529: a rejected Import Modpack file, whatever the reason (the 2 MiB cap, bad JSON, a
 * wrong shape), always lands on the same handler error and used to show a toast that never said
 * what file Import Modpack actually wants. The fix is the string alone (useModpackImportPicker.ts
 * already shows it verbatim for any `error`), so mounting the real picker through Manage Mods and
 * mocking the one error the handler always returns is enough to pin the new wording.
 */
describe("ManageMods: Import Modpack rejects a file", () => {
  it("shows a toast naming the .json file and where a ModDB modpack installs from instead", async () => {
    const user = userEvent.setup()
    const importModpack = vi.fn(async () => ({ success: false, error: "Error reading modpack file." }))
    renderManageMods({ modsManager: { importModpack } })

    const modpackTrigger = await screen.findByText("Modpack", {}, { timeout: 3000 })
    await user.click(modpackTrigger.closest("button") as HTMLElement)
    await user.click((await screen.findByText("Import Modpack")).closest("button") as HTMLElement)

    await vi.waitFor(() => expect(importModpack).toHaveBeenCalled())

    // The exact wording is free to change; what has to stay true is that the toast names the file
    // type Export Modpack writes and the page a mod database modpack installs from instead (there is
    // no "Browse Mods" button or page on screen to name, only the Mods page itself, see #529's fix
    // note grepped against en-US.json).
    const toast = await screen.findByText(/\.json/, {}, { timeout: 3000 })
    expect(toast.textContent).toMatch(/\.json/)
    expect(toast.textContent).toMatch(/Mods page/)
  })
})
