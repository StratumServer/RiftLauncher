import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
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

const NEW_ROW = "This Installation has no file at this name"
const REPLACES_ROW = "Replaces yours"

/** A pack assembled from a folder rather than from ModDB: settings, and no Mods at all. */
function packCarrying(name: string): { success: true; manifest: ModpackManifestType } {
  return {
    success: true,
    manifest: {
      gameVersion: "1.20.0",
      name: "folder-export",
      author: "somebody",
      mods: [],
      servers: [],
      settings: { [name]: { text: '{"n":1}', sha256: "0".repeat(64) } }
    } as unknown as ModpackManifestType
  }
}

/**
 * The page, with the two questions the import path asks answered for real.
 *
 * `inFolder` is the Installation's ModConfig folder as the host sees it, and it is what the apply
 * changes: a config written by the dialog is in the folder for the next listing, which is the whole
 * reason the dialog asks again rather than reusing the page-load answer. `getModConfigs` answers
 * every call, so a listing in flight cannot wedge the test the way an unanswered promise would.
 */
function renderPage(): { importModpack: ReturnType<typeof vi.fn>; applyModConfigs: ReturnType<typeof vi.fn> } {
  const inFolder = new Set<string>()
  const importModpack = vi.fn(async () => packCarrying("Brand/New.json"))
  const applyModConfigs = vi.fn(async (_path: string, files: readonly { name: string; text: string; sha256: string }[]) => {
    for (const file of files) inFolder.add(file.name)
    return {
      ok: true,
      applied: files.map((file) => ({ name: file.name, kind: "replaced" })),
      failed: [],
      skipped: [],
      backupFolder: "/games/a/Backups/Settings/folder-export/settings_1"
    } as unknown as ApplyModConfigsResult
  })

  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
    modsManager: {
      getInstalledMods: vi.fn(async () => ({ mods: [], errors: [] })),
      importModpack,
      applyModConfigs,
      getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [...inFolder].map((name) => ({ name, bytes: 7 })) }))
    }
  })

  mountManageMods()
  return { importModpack, applyModConfigs }
}

/** The action bar's menu, then its Import item: the route a player takes to a pack. */
async function openImportModpack(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const trigger = await screen.findByText("Modpack", {}, { timeout: 3000 })
  await user.click(trigger.closest("button") as HTMLElement)
  const item = ((await screen.findAllByText("Import Modpack")).at(-1) as HTMLElement).closest("button") as HTMLButtonElement
  // The item is greyed out while the page is renaming archives after the last import, and a click on
  // a disabled button is a click that does nothing, which would leave the test waiting for a popup
  // the page had already decided against.
  await vi.waitFor(() => expect(item.disabled).toBe(false))
  await user.click(item)
}

/**
 * The import as the page runs it, which is the only way the second review's blocking point can be
 * seen: the dialog's own tests mount it with `settings` already set, so the line that hands a
 * pack's settings over, the flag that offers the button, the zero-Mods exit and the two lines that
 * make a second import its own question can each be deleted with the suite still green.
 *
 * So this drives the page: menu, popup, Import, the dialog's rows, a write, Done, and a second
 * pack carrying the file the first one wrote. Every one of those five deletions shows up here as a
 * dialog that never opens, or as one that opens on the first pack's summary, or as a row that calls
 * a file this Installation now has a new file.
 */
describe("Manage Mods: importing a pack's mod configs through the page", () => {
  it("carries each pack's configs to a dialog of its own, and the second pack sees what the first wrote", async () => {
    const user = userEvent.setup()
    const { importModpack, applyModConfigs } = renderPage()

    await openImportModpack(user)
    const importButton = ((await screen.findAllByText("Import Modpack")).at(-1) as HTMLElement).closest("button") as HTMLButtonElement
    await vi.waitFor(() => expect(importButton.disabled).toBe(false))
    await user.click(importButton)

    const firstRow = await screen.findByText("Brand/New.json", {}, { timeout: 3000 })
    expect(firstRow.closest("li")?.textContent).toContain(NEW_ROW)
    const firstBox = (await screen.findByRole("checkbox", { name: /Brand\/New\.json/ })) as HTMLInputElement
    expect(firstBox.checked).toBe(true)

    await user.click(screen.getByRole("button", { name: /Write the chosen configs/ }))
    await vi.waitFor(() => expect(applyModConfigs).toHaveBeenCalledTimes(1))
    await screen.findAllByText("Wrote 1 file.", {}, { timeout: 3000 })
    await user.click(screen.getByRole("button", { name: /Done/ }))

    // A second pack, in the same page session, carrying the file the first one wrote. The dialog is
    // still mounted between packs, so what this proves is that it asks again rather than answering
    // out of the listing it read when the page loaded.
    importModpack.mockImplementationOnce(async () => packCarrying("Brand/New.json"))
    await openImportModpack(user)
    const secondImport = ((await screen.findAllByText("Import Modpack")).at(-1) as HTMLElement).closest("button") as HTMLButtonElement
    await vi.waitFor(() => expect(secondImport.disabled).toBe(false))
    await user.click(secondImport)

    const secondRow = await screen.findByText("Brand/New.json", {}, { timeout: 3000 })
    expect(secondRow.closest("li")?.textContent).toContain(REPLACES_ROW)
    expect(secondRow.closest("li")?.textContent).not.toContain(NEW_ROW)
    // The summary of the first import is gone with its Done button: what the second pack opens on is
    // a question about its own files, not the answer to the last one. (The toast outlives the dialog
    // and is not what this is about.)
    expect(screen.queryByRole("button", { name: /Done/ })).toBeNull()
    expect(((await screen.findByRole("checkbox", { name: /Brand\/New\.json/ })) as HTMLInputElement).checked).toBe(false)
  }, 30000)
})
