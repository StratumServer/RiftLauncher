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

/** One enabled Mod, so the export button is live: a folder with nothing in it exports nothing. */
function aMod(): InstalledModType {
  return { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: "/games/a/Mods/alpha-1.0.0.zip", enabled: true, authors: ["Ann"], contributors: [] }
}

const ROOM_SIZE: ModConfigListingEntry = { name: "RoomSize.json", bytes: 42 }
const SERVER_LIST: ModConfigListingEntry = { name: "serverconfig.json", bytes: 7 }

/**
 * Mounts the page with a config folder the test controls.
 *
 * `getModConfigs` answers from a variable rather than a fixed value, because the page asks this
 * question three times: the action bar's own listing, the import dialog mounted shut behind it, and
 * the export picker. Flipping the answer between two of those is how a test reaches a picker whose
 * read failed after the box it was opened from had already succeeded.
 */
function mountWithConfigs(configs: ModConfigListingEntry[]): {
  answerNextRead: (value: ModConfigsReadResult) => void
  exportModpack: ReturnType<typeof vi.fn>
} {
  let answer: ModConfigsReadResult = { ok: true, configs, linked: [] }
  const exportModpack = vi.fn(async () => ({ success: true, path: "/out/pack.json" }))

  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: {
      getInstalledMods: vi.fn(async () => ({ mods: [aMod()], errors: [] })),
      getModConfigs: vi.fn(async () => answer),
      exportModpack
    }
  })

  mountManageMods()
  return {
    answerNextRead: (value) => {
      answer = value
    },
    exportModpack
  }
}

/** Ticks the box that says configs travel, which is what turns the export button into the picker. */
async function askForConfigs(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByLabelText("Include mod configs", {}, { timeout: 3000 }))
}

async function openThePicker(): Promise<void> {
  const user = userEvent.setup()
  const modpackTrigger = await screen.findByText("Modpack", {}, { timeout: 3000 })
  await user.click(modpackTrigger.closest("button") as HTMLElement)
  const exportButton = await screen.findByText("Export Modpack", {}, { timeout: 3000 })
  await user.click(exportButton.closest("button") as HTMLElement)
  await screen.findByText("Mod configs to export", {}, { timeout: 3000 })
}

/**
 * What the export carries, and the last chance to change it.
 *
 * A mod config is the part of an Installation that belongs to the player: their server list, their
 * keybinds, and in some Mods an API key. The action bar's checkbox says "include configs" and the
 * pack is a file they hand to somebody else, so the list has to be shown before it is written. It is
 * also the way around a single config a pack cannot carry: without it the only answer to "this file
 * is not UTF-8" was to go and rename it.
 */
describe("Manage Mods: the mod config export picker", () => {
  it("lists every config, ticked, with a warning about what they can hold", async () => {
    mountWithConfigs([ROOM_SIZE, SERVER_LIST])
    await askForConfigs()
    await openThePicker()

    // Every file gets a row and every row starts ticked. The import dialog does the opposite with
    // its own rows, because there a tick means overwriting a file the player may have tuned.
    for (const entry of [ROOM_SIZE, SERVER_LIST]) {
      const box = (await screen.findByLabelText(entry.name, {}, { timeout: 3000 })) as HTMLInputElement
      expect(box.checked).toBe(true)
    }

    expect(screen.getByText("This modpack will carry 2 mod config files from this Installation. Untick the ones it should not carry.")).toBeTruthy()
    expect(screen.getByText("A mod config can hold server addresses, API keys and tokens, and anyone you hand this pack to can read every file you leave ticked.")).toBeTruthy()
  })

  it("carries only the files left ticked", async () => {
    const { exportModpack } = mountWithConfigs([ROOM_SIZE, SERVER_LIST])
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByLabelText(SERVER_LIST.name, {}, { timeout: 3000 }))
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    expect(exportModpack).toHaveBeenCalledWith(expect.objectContaining({}), "/games/a", true, [ROOM_SIZE.name])
  })

  it("exports with no configs at all when the player says so", async () => {
    const { exportModpack } = mountWithConfigs([ROOM_SIZE])
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export without configs", {}, { timeout: 3000 }))

    // `includeConfigs: false` rather than an empty list: the host has nothing to walk for, so it
    // does not walk the folder to select nothing from it.
    expect(exportModpack).toHaveBeenCalledWith(expect.objectContaining({}), "/games/a", false, undefined)
  })

  it("refuses to export a list with nothing ticked", async () => {
    mountWithConfigs([ROOM_SIZE])
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByLabelText(ROOM_SIZE.name, {}, { timeout: 3000 }))

    expect((await screen.findByText("Export the chosen configs", {}, { timeout: 3000 })).closest("button")?.disabled).toBe(true)
  })

  it("says the folder could not be read when the read fails after the box was ticked", async () => {
    const { answerNextRead } = mountWithConfigs([ROOM_SIZE])
    await askForConfigs()

    // The box was enabled by a read that succeeded, so the game can have started between that and
    // the export. The picker asks again on every open, and this is the answer it gets.
    answerNextRead({ ok: false, reason: "playing" })
    await openThePicker()

    expect(screen.getByText("This Installation is playing. Its mod configs can be listed once the game has closed.")).toBeTruthy()
    expect(screen.queryByLabelText(ROOM_SIZE.name)).toBeNull()
  })

  it("asks again on every open, so a config written since the page loaded is listed", async () => {
    const { answerNextRead } = mountWithConfigs([ROOM_SIZE])
    await askForConfigs()
    await openThePicker()
    expect(screen.queryByLabelText(SERVER_LIST.name)).toBeNull()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export without configs", {}, { timeout: 3000 }))

    // The page's own listing is a snapshot from when the Mods page loaded, and this dialog outlives
    // it. A file the game wrote in between is one the player has not been shown and must still be
    // offered, because the alternative is it travelling in the pack with no row to agree to.
    answerNextRead({ ok: true, configs: [ROOM_SIZE, SERVER_LIST], linked: [] })
    await act(async () => void (await screen.findByText("Mod configs to export", {}, { timeout: 3000 })))
    await openThePicker()

    expect(await screen.findByLabelText(SERVER_LIST.name, {}, { timeout: 3000 })).toBeTruthy()
  })
})
