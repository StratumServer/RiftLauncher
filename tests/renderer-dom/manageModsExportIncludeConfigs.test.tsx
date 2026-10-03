import { describe, expect, it, vi } from "vitest"
import { act, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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

/**
 * Mounts the page and hands back the way to answer.
 *
 * Both components on the page ask the host what is in the ModConfig folder: the export box for its
 * count, and the import dialog, which is mounted shut and holds the same question. The mock
 * collects every resolver it is given and `answer` replies to all of them at once, because
 * answering one of two leaves the other waiting, and which of the two the box belongs to is the
 * question being tested.
 */
function mountWithPendingConfigs(): { answer: (value: ModConfigsReadResult) => void } {
  const pending: ((value: ModConfigsReadResult) => void)[] = []
  const getModConfigs = vi.fn(() => new Promise<ModConfigsReadResult>((resolve) => pending.push(resolve)))

  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: { getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })), getModConfigs }
  })

  mountManageMods()
  return {
    answer: (value) => {
      for (const resolve of pending.splice(0)) resolve(value)
    }
  }
}

async function openTheExportMenu(): Promise<void> {
  const user = userEvent.setup()
  const modpackTrigger = await screen.findByText("Modpack", {}, { timeout: 3000 })
  await user.click(modpackTrigger.closest("button") as HTMLElement)
  await screen.findByText("Export Modpack", {}, { timeout: 3000 })
}

/**
 * The other half of `useModConfigs`' contract, and the half a player is likelier to meet.
 *
 * Exporting a mod config hands it to whoever opens the pack, so the box is off until it is asked
 * for. What it must not do is appear before the launcher has looked: a box sitting there saying
 * "Include mod configs" over a folder nobody has counted is a promise about a count nobody has. It
 * appears with the count, it appears clear, and an Installation with no configs gets no box at all.
 */
describe("Manage Mods: the Export Modpack mod config box", () => {
  it("is not on screen until the host has said what is in the folder", async () => {
    mountWithPendingConfigs()

    await openTheExportMenu()

    expect(screen.queryByText("Include mod configs")).toBeNull()
  })

  it("appears clear once the host names even one file", async () => {
    const { answer } = mountWithPendingConfigs()
    await openTheExportMenu()
    expect(screen.queryByText("Include mod configs")).toBeNull()

    await act(async () => void answer({ ok: true, configs: [{ name: "RoomSize.json", bytes: 2 }] }))

    const box = await screen.findByLabelText("Include mod configs", {}, { timeout: 3000 })
    expect((box as HTMLInputElement).checked).toBe(false)
  })

  it("is drawn but disabled, and says why, when the folder could not be read", async () => {
    // Drawing nothing here is the same as drawing an empty folder, and the difference is a sentence
    // the player could have acted on: a game that is running closes, a folder that is unreadable
    // does not. The box is never retried within the session, so the sentence is all there is.
    const { answer } = mountWithPendingConfigs()
    await openTheExportMenu()
    expect(screen.queryByText("Include mod configs")).toBeNull()
    await act(async () => void answer({ ok: false, reason: "playing" }))

    const box = (await screen.findByLabelText("Include mod configs", {}, { timeout: 3000 })) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(true)
    const holder = box.closest("div")
    expect(holder?.getAttribute("title")).toBe("This Installation is playing. The mod configs can be written once the game has closed.")
  })

  it("stays away from an Installation with no mod configs at all", async () => {
    const { answer } = mountWithPendingConfigs()
    await act(async () => void answer({ ok: true, configs: [] }))
    await openTheExportMenu()

    expect(screen.queryByText("Include mod configs")).toBeNull()
  })
})
