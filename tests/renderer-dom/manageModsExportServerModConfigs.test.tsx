import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import i18n from "@renderer/i18n"
import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
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

/** One Mod a server loads and one only a client does, so the server pack has something to leave out. */
function mods(): InstalledModType[] {
  return [
    { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: "/games/a/Mods/alpha-1.0.0.zip", enabled: true, side: "Universal", authors: ["Ann"], contributors: [] },
    { name: "Beta Mod", modid: "beta", version: "2.0.0", path: "/games/a/Mods/beta-2.0.0.zip", enabled: true, side: "Client", authors: ["Bob"], contributors: [] }
  ]
}

const ROOM_SIZE: ModConfigListingEntry = { name: "RoomSize.json", bytes: 42 }
const SERVER_LIST: ModConfigListingEntry = { name: "serverconfig.json", bytes: 7 }

function mountWithListing(listing: ModConfigsReadResult): { exportModpack: ReturnType<typeof vi.fn> } {
  const exportModpack = vi.fn(async () => ({ success: true, path: "/out/pack.json" }))
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: mods(), errors: [] })), getModConfigs: vi.fn(async () => listing), exportModpack }
  })
  mountManageMods()
  return { exportModpack }
}

async function pressInTheMenu(label: string): Promise<void> {
  const user = userEvent.setup()
  const trigger = await screen.findByText(i18n.t("features.mods.modpackMenuButton"), {}, { timeout: 3000 })
  await user.click(trigger.closest("button") as HTMLElement)
  const item = await screen.findByText(label, {}, { timeout: 3000 })
  await user.click(item.closest("button") as HTMLElement)
}

async function tickIncludeConfigs(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByLabelText(i18n.t("features.mods.includeConfigs"), {}, { timeout: 3000 }))
}

// The "playing" sentence is pinned in manageModsExportIncludeConfigs.test.tsx.
describe("Manage Mods: the disabled mod config box names the export, not the import", () => {
  it("says the folder could not be read without claiming a write that never started", async () => {
    mountWithListing({ ok: false, reason: "mod-config-unreadable" })

    const box = (await screen.findByLabelText(i18n.t("features.mods.includeConfigs"), {}, { timeout: 3000 })) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.closest("div")?.getAttribute("title")).toBe("This Installation's mod config folder could not be read, so the modpack cannot carry its configs.")
  })
})

describe("Manage Mods: Export Server Modpack and the mod config box", () => {
  it("opens the picker when the box is ticked and carries the configs left ticked", async () => {
    const { exportModpack } = mountWithListing({ ok: true, configs: [ROOM_SIZE, SERVER_LIST], linked: [] })
    await tickIncludeConfigs()

    await pressInTheMenu(i18n.t("features.mods.exportServerModpackButton"))
    await screen.findByText(i18n.t("features.mods.exportModConfigsTitle"), {}, { timeout: 3000 })
    expect(exportModpack).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await waitFor(() => expect(document.getElementById(`export-mod-config-${SERVER_LIST.name}`)).not.toBeNull())
    await user.click(document.getElementById(`export-mod-config-${SERVER_LIST.name}`) as HTMLElement)
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    const [manifest, path, includeConfigs, configNames] = exportModpack.mock.calls[0] as unknown as [{ name: string; mods: { modid: string }[] }, string, boolean, string[]]
    expect(manifest.name).toBe("Install A (Server)")
    expect(manifest.mods.map((mod) => mod.modid)).toEqual(["alpha"])
    expect(path).toBe("/games/a")
    expect(includeConfigs).toBe(true)
    expect(configNames).toEqual([ROOM_SIZE.name])
  })

  it("exports without configs from the picker's own skip button, still as the server pack", async () => {
    const { exportModpack } = mountWithListing({ ok: true, configs: [ROOM_SIZE], linked: [] })
    await tickIncludeConfigs()

    await pressInTheMenu(i18n.t("features.mods.exportServerModpackButton"))
    const user = userEvent.setup()
    await user.click(await screen.findByText("Export without configs", {}, { timeout: 3000 }))

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    const [manifest, , includeConfigs, configNames] = exportModpack.mock.calls[0] as unknown as [{ name: string }, string, boolean, string[] | undefined]
    expect(manifest.name).toBe("Install A (Server)")
    expect(includeConfigs).toBe(false)
    expect(configNames).toBeUndefined()
  })

  it("exports straight away without configs when the box is clear", async () => {
    const { exportModpack } = mountWithListing({ ok: true, configs: [ROOM_SIZE], linked: [] })
    await screen.findByLabelText(i18n.t("features.mods.includeConfigs"), {}, { timeout: 3000 })

    await pressInTheMenu(i18n.t("features.mods.exportServerModpackButton"))

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(i18n.t("features.mods.exportModConfigsTitle"))).toBeNull()
    const [manifest, , includeConfigs, configNames] = exportModpack.mock.calls[0] as unknown as [{ name: string }, string, boolean, string[] | undefined]
    expect(manifest.name).toBe("Install A (Server)")
    expect(includeConfigs).toBe(false)
    expect(configNames).toBeUndefined()
  })
})

describe("Manage Mods: the plain Export Modpack and the mod config box", () => {
  it("opens the picker for the whole pack, named after the Installation, with every enabled Mod", async () => {
    const { exportModpack } = mountWithListing({ ok: true, configs: [ROOM_SIZE], linked: [] })
    await tickIncludeConfigs()

    await pressInTheMenu(i18n.t("features.mods.exportModpackButton"))
    const user = userEvent.setup()
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => expect(exportModpack).toHaveBeenCalledTimes(1))
    const [manifest, , includeConfigs, configNames] = exportModpack.mock.calls[0] as unknown as [{ name: string; mods: { modid: string }[] }, string, boolean, string[]]
    expect(manifest.name).toBe("Install A")
    expect(manifest.mods.map((mod) => mod.modid)).toEqual(["alpha", "beta"])
    expect(includeConfigs).toBe(true)
    expect(configNames).toEqual([ROOM_SIZE.name])
  })
})
