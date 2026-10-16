import { describe, expect, it, vi } from "vitest"
import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import i18n, { changeLanguage } from "@renderer/i18n"
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
const BAD_NAME: ModConfigListingEntry = { name: "bad:name.json", bytes: 15 }
const HIDDEN_NAME: ModConfigListingEntry = { name: "config\u034F.json", bytes: 10 }
const COLLIDE_UPPER: ModConfigListingEntry = { name: "AutoMap.json", bytes: 20 }
const COLLIDE_LOWER: ModConfigListingEntry = { name: "automap.json", bytes: 25 }

/**
 * Mounts the page with a config folder the test controls.
 *
 * `getModConfigs` answers from a variable rather than a fixed value, because the page asks this
 * question three times: the action bar's own listing, the import dialog mounted shut behind it, and
 * the export picker. Flipping the answer between two of those is how a test reaches a picker whose
 * read failed after the box it was opened from had already succeeded.
 */
function mountWithConfigs(
  configs: ModConfigListingEntry[],
  exportOutcome: { success: boolean; path?: string; reason?: ExportModpackRefusal; name?: string } = { success: true, path: "/out/pack.json" },
  linked: string[] = []
): {
  answerNextRead: (value: ModConfigsReadResult) => void
  exportModpack: ReturnType<typeof vi.fn>
} {
  let answer: ModConfigsReadResult = { ok: true, configs, linked }
  const exportModpack = vi.fn(async () => exportOutcome)

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
  await user.click(await screen.findByLabelText(i18n.t("features.mods.includeConfigs"), {}, { timeout: 3000 }))
}

async function openThePicker(): Promise<void> {
  const user = userEvent.setup()
  const modpackTrigger = await screen.findByText(i18n.t("features.mods.modpackMenuButton"), {}, { timeout: 3000 })
  await user.click(modpackTrigger.closest("button") as HTMLElement)
  const exportButton = await screen.findByText(i18n.t("features.mods.exportModpackButton"), {}, { timeout: 3000 })
  await user.click(exportButton.closest("button") as HTMLElement)
  await screen.findByText(i18n.t("features.mods.exportModConfigsTitle"), {}, { timeout: 3000 })
}

async function rowFor(name: string): Promise<HTMLInputElement> {
  let input: HTMLElement | null = null
  await waitFor(() => {
    input = document.getElementById(`export-mod-config-${name}`)
    expect(input).not.toBeNull()
  })
  return input as unknown as HTMLInputElement
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
  it("lists every config, ticked by default when valid, with a warning about what they can hold", async () => {
    mountWithConfigs([ROOM_SIZE, SERVER_LIST])
    await askForConfigs()
    await openThePicker()

    // Every file gets a row and every valid, non-colliding row starts ticked.
    for (const entry of [ROOM_SIZE, SERVER_LIST]) {
      const box = await rowFor(entry.name)
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
    await user.click(await rowFor(SERVER_LIST.name))
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    expect(exportModpack).toHaveBeenCalledWith(expect.objectContaining({}), "/games/a", true, [ROOM_SIZE.name])
  })

  it("exports with no configs at all when the player says so", async () => {
    const { exportModpack } = mountWithConfigs([ROOM_SIZE])
    await askForConfigs()

    // The skip button on the dialog is one way to export nothing, and the other is leaving the box
    // in the action bar clear. The action bar's export button does not open the dialog at all.
    const user = userEvent.setup()
    const modpackTrigger = await screen.findByText(i18n.t("features.mods.modpackMenuButton"), {}, { timeout: 3000 })
    await user.click(modpackTrigger.closest("button") as HTMLElement)
    const exportButton = await screen.findByText(i18n.t("features.mods.exportModpackButton"), {}, { timeout: 3000 })
    await user.click(exportButton.closest("button") as HTMLElement)

    const skipButton = await screen.findByText("Export without configs", {}, { timeout: 3000 })
    await user.click(skipButton)

    // `includeConfigs: false` rather than an empty list: the host has nothing to walk for, so it
    // does not walk the folder to select nothing from it.
    expect(exportModpack).toHaveBeenCalledWith(expect.objectContaining({}), "/games/a", false, undefined)
  })

  it("refuses to export a list with nothing ticked", async () => {
    mountWithConfigs([ROOM_SIZE])
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await rowFor(ROOM_SIZE.name))

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

  it("leaves unsupported rows unticked by default and displays why", async () => {
    mountWithConfigs([ROOM_SIZE, BAD_NAME, HIDDEN_NAME, COLLIDE_UPPER, COLLIDE_LOWER])
    await askForConfigs()
    await openThePicker()

    // Valid file starts ticked
    const validBox = await rowFor(ROOM_SIZE.name)
    expect(validBox.checked).toBe(true)

    // Bad name starts unticked and displays why
    const badBox = await rowFor(BAD_NAME.name)
    expect(badBox.checked).toBe(false)
    expect(badBox.disabled).toBe(true)
    expect(within(badBox.closest("li") as HTMLElement).getByText("Windows does not accept this file name")).toBeTruthy()

    // Hidden-character name starts unticked, disabled, and spells code point
    const hiddenBox = await rowFor(HIDDEN_NAME.name)
    expect(hiddenBox.checked).toBe(false)
    expect(hiddenBox.disabled).toBe(true)
    expect(within(hiddenBox.closest("li") as HTMLElement).getByText("config<U+034F>.json")).toBeTruthy()

    // Colliding files start unticked and display why
    const coll1 = await rowFor(COLLIDE_UPPER.name)
    expect(coll1.checked).toBe(false)
    expect(coll1.disabled).toBe(false)
    expect(within(coll1.closest("li") as HTMLElement).getByText("Differs from another config file only in letter case")).toBeTruthy()

    const coll2 = await rowFor(COLLIDE_LOWER.name)
    expect(coll2.checked).toBe(false)
    expect(within(coll2.closest("li") as HTMLElement).getByText("Differs from another config file only in letter case")).toBeTruthy()

    // Count sentence reports only how many are ticked (1 of 5), not how many exist
    expect(screen.getByText("This modpack will carry 1 mod config file from this Installation. Untick the ones it should not carry.")).toBeTruthy()
  })

  it("shows linked files and folders as disabled rows that will not travel", async () => {
    mountWithConfigs([ROOM_SIZE], { success: true }, ["linked.json", "LinkedFolder"])
    await askForConfigs()
    await openThePicker()

    for (const name of ["linked.json", "LinkedFolder"]) {
      const box = (await screen.findByLabelText(new RegExp(`^${name}`), {}, { timeout: 3000 })) as HTMLInputElement
      expect(box.checked).toBe(false)
      expect(box.disabled).toBe(true)
      expect(within(box.closest("li") as HTMLElement).getByText("Links cannot travel in a modpack.")).toBeTruthy()
    }
  })

  it("does not prompt to untick anything when no file can travel", async () => {
    mountWithConfigs([BAD_NAME])
    await askForConfigs()
    await openThePicker()

    expect(screen.getByText("No mod config files are selected to travel in this modpack.")).toBeTruthy()
    expect((await rowFor(BAD_NAME.name)).disabled).toBe(true)
  })

  it("reads count as how many are ticked, updating as rows are toggled", async () => {
    mountWithConfigs([ROOM_SIZE, SERVER_LIST])
    await askForConfigs()
    await openThePicker()

    expect(screen.getByText("This modpack will carry 2 mod config files from this Installation. Untick the ones it should not carry.")).toBeTruthy()

    const user = userEvent.setup()
    const box = await rowFor(ROOM_SIZE.name)
    await user.click(box)
    expect(box.checked).toBe(false)
    expect(screen.getByText("This modpack will carry 1 mod config file from this Installation. Untick the ones it should not carry.")).toBeTruthy()

    await user.click(box)
    expect(box.checked).toBe(true)
    expect(screen.getByText("This modpack will carry 2 mod config files from this Installation. Untick the ones it should not carry.")).toBeTruthy()
  })

  it("names unticking the row when export fails with bad-name refusal", async () => {
    mountWithConfigs([ROOM_SIZE], { success: false, reason: "bad-name", name: BAD_NAME.name })
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => {
      expect(
        screen.getByText(
          "bad:name.json cannot travel in a modpack: Windows does not accept that file name. Untick it in the list of mod configs to export or rename it in the ModConfig folder and export again."
        )
      ).toBeTruthy()
    })
  })

  it("names unticking the row when export fails with hidden-character refusal", async () => {
    mountWithConfigs([ROOM_SIZE], { success: false, reason: "hidden-character", name: "config<U+034F>.json" })
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => {
      expect(
        screen.getByText(
          "config<U+034F>.json contains invisible Unicode characters and cannot travel in a modpack. The hidden characters are shown as <U+XXXX>; untick it in the list of mod configs to export or rename it in the ModConfig folder and export again."
        )
      ).toBeTruthy()
    })
  })

  it("names unticking the row when export fails with collides refusal", async () => {
    mountWithConfigs([COLLIDE_UPPER], { success: false, reason: "collides", name: COLLIDE_UPPER.name })
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => {
      expect(
        screen.getByText(
          "AutoMap.json differs from another config file only in letter case, and on Windows the two are one file. Untick it in the list of mod configs to export or rename one of them and export again."
        )
      ).toBeTruthy()
    })
  })

  it("names unticking the row when export fails with not-utf8 refusal", async () => {
    mountWithConfigs([ROOM_SIZE], { success: false, reason: "not-utf8", name: ROOM_SIZE.name })
    await askForConfigs()
    await openThePicker()

    const user = userEvent.setup()
    await user.click(await screen.findByText("Export the chosen configs", {}, { timeout: 3000 }))

    await waitFor(() => {
      expect(screen.getByText('"RoomSize.json" is not a text file a pack can carry, so the export stopped there. Untick it in the list of mod configs to export and export again.')).toBeTruthy()
    })
  })

  it.each(["bad-name", "collides", "not-utf8", "hidden-character"] as const)("shows the French untick instruction in the rendered %s refusal", async (reason) => {
    await changeLanguage("fr-FR")
    try {
      mountWithConfigs([ROOM_SIZE], { success: false, reason, name: ROOM_SIZE.name })
      await askForConfigs()
      await openThePicker()

      const user = userEvent.setup()
      await user.click(await screen.findByText(i18n.t("features.mods.exportModConfigsApply"), {}, { timeout: 3000 }))
      expect(await screen.findByText((text) => text.includes("Décochez-le dans la liste des configs à exporter"), {}, { timeout: 3000 })).toBeTruthy()
    } finally {
      await changeLanguage("en-US")
    }
  })
})
