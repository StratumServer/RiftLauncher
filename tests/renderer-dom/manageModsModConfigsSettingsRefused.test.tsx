import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI, type WindowApiOverrides } from "./helpers/windowApi"
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
    modsManager: {
      getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })),
      getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [] })),
      ...overrides.modsManager
    }
  })

  return mountManageMods()
}

async function importAPack(importModpack: MockedBridgeAPI["modsManager"]["importModpack"]): Promise<void> {
  const user = userEvent.setup()
  renderManageMods({ modsManager: { importModpack } })

  const modpackTrigger = await screen.findByText("Modpack", {}, { timeout: 3000 })
  await user.click(modpackTrigger.closest("button") as HTMLElement)
  await user.click((await screen.findByText("Import Modpack")).closest("button") as HTMLElement)
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull())
}

/**
 * A modpack whose mods are fine and whose mod configs are not.
 *
 * The two halves of a pack are read independently, so a key or a digest the launcher cannot accept
 * costs the player the configs and nothing else: the mods still import. What it must not do is
 * import silently, because a pack that carried eight configs and got none of them looks exactly
 * like a pack that never carried any, and the difference is the difference between "the mod I added
 * did not come with its settings" and "I did not know there were settings".
 */
describe("ManageMods: a modpack whose mod configs were refused", () => {
  it("says the Mods were imported without them, and does not open a dialog with nothing to show", async () => {
    await importAPack(
      vi.fn(
        async (): ReturnType<MockedBridgeAPI["modsManager"]["importModpack"]> => ({
          success: true,
          manifest: { name: "pack", gameVersion: "1.20.0", mods: [] },
          settingsRefused: { reason: "bad-key", name: "../clientsettings.json" }
        })
      )
    )

    expect(await screen.findByText("This pack's mod configs could not be read, so its Mods were imported without them.", {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.queryByText("Mod configs in this modpack")).toBeNull()
  })

  it("stays silent when the pack carried configs the launcher accepted", async () => {
    await importAPack(
      vi.fn(
        async (): ReturnType<MockedBridgeAPI["modsManager"]["importModpack"]> => ({
          success: true,
          manifest: { name: "pack", gameVersion: "1.20.0", mods: [], settings: { "a.json": { text: "{}", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } } }
        })
      )
    )

    await screen.findByText("Modpack", {}, { timeout: 3000 })
    expect(screen.queryByText(/mod configs could not be read/)).toBeNull()
  })
})
