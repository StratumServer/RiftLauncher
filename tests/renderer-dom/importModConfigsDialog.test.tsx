import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"

import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import ImportModConfigsDialog from "@renderer/features/mods/components/ImportModConfigsDialog"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * What a modpack does to an Installation's mod configs, before it does it.
 *
 * The interesting decisions in this dialog are three, and all three are about what happens when the
 * host's answer and the pack's contents disagree: a file the Installation already has starts clear,
 * a file it has never seen starts ticked, and neither of those is decided until the host has said
 * what is on disk. A box that defaults wrong here overwrites somebody's tuning, so these tests read
 * the boxes rather than the labels.
 */

const PATH = "/installations/main"

function installation(): InstallationType {
  return {
    id: "main",
    name: "Main",
    icon: "",
    path: PATH,
    version: "1.20.4",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: 0,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function entry(text: string): ModConfigEntry {
  return { text, sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") }
}

function mount(
  settings: Record<string, ModConfigEntry>,
  listing: ModConfigsReadResult,
  apply: (files: { name: string }[]) => Promise<ApplyModConfigsResult> = () => Promise.resolve({ ok: true, backupFolder: "", applied: [], skipped: [], failed: [] })
): { sent: { name: string; text: string; sha256: string }[][] } {
  const sent: { name: string; text: string; sha256: string }[][] = []
  installMockWindowApi({
    modsManager: {
      getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => listing),
      applyModConfigs: vi.fn(async (_installationPath: string, files: { name: string; text: string; sha256: string }[]) => {
        sent.push(files)
        return apply(files)
      })
    }
  })

  renderWithProviders(
    <>
      <NotificationsOverlay />
      <ImportModConfigsDialog settings={settings} installation={installation()} close={vi.fn()} />
    </>
  )
  return { sent }
}

/** The box on a row, waited for: the id is the name the dialog gives it, not a test-only handle. */
async function rowFor(name: string): Promise<HTMLInputElement> {
  let input: HTMLElement | null = null
  await waitFor(() => {
    input = document.getElementById(`import-mod-config-${name}`)
    expect(input).not.toBeNull()
  })
  return input as unknown as HTMLInputElement
}

describe("ImportModConfigsDialog, the boxes", () => {
  it("ticks a file this Installation has never seen and clears one it has", async () => {
    mount({ "New.json": entry("{}"), "Mine.json": entry("{}") }, { ok: true, configs: [{ name: "Mine.json", bytes: 2 }] })

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    expect((await rowFor("Mine.json")).checked).toBe(false)
    expect(within((await screen.findByText("Mine.json")).closest("li") as HTMLElement).getByText("Replaces yours")).toBeTruthy()
  })

  it("calls a file the same file whatever case the two names are written in", async () => {
    // One file on NTFS and on APFS, two on Linux. A dialog that read the pack's capital C as a new
    // file would tick a box that overwrites the config.json sitting on disk.
    mount({ "Config.json": entry("{}") }, { ok: true, configs: [{ name: "config.json", bytes: 2 }] })

    await waitFor(async () => expect((await rowFor("Config.json")).checked).toBe(false))
  })

  it("lists nothing at all until the host has answered, because no answer is not an empty folder", async () => {
    // Deliberately unresolved: a mock that answers immediately has answered before the first
    // assertion below runs, which is the case the gate is for and never the one under test.
    let answer: (value: ModConfigsReadResult) => void = () => {}
    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(() => new Promise<ModConfigsReadResult>((resolve) => (answer = resolve))),
        applyModConfigs: vi.fn()
      }
    })
    renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "New.json": entry("{}") }} installation={installation()} close={vi.fn()} />
      </>
    )

    // The request is in flight: the buttons are there, the rows are not, and the button that would
    // write is off, because nothing can be written before the host says what is on disk.
    await waitFor(() => expect(screen.getByRole("button", { name: "Write the chosen configs" })).toBeTruthy())
    expect(screen.queryByText("New.json")).toBeNull()
    expect((screen.getByRole("button", { name: "Write the chosen configs" }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => void answer({ ok: true, configs: [] }))
    expect((await rowFor("New.json")).checked).toBe(true)
  })

  it("says the folder is unreadable rather than offering every row as new", async () => {
    mount({ "New.json": entry("{}") }, { ok: false, reason: "mod-config-unreadable" })

    await waitFor(() => expect(screen.getByText("This Installation's mod config folder could not be read, so nothing was written.")).toBeTruthy())
    expect(screen.queryByText("New.json")).toBeNull()
  })
})

describe("ImportModConfigsDialog, what it sends", () => {
  it("sends the ticked files with their text and digest, and nothing else", async () => {
    const { sent } = mount({ "New.json": entry('{"a":1}'), "Mine.json": entry('{"b":2}') }, { ok: true, configs: [{ name: "Mine.json", bytes: 7 }] })

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual([{ name: "New.json", text: '{"a":1}', sha256: entry('{"a":1}').sha256 }])
  })

  it("closes without asking the host to write anything when the last box is cleared", async () => {
    const close = vi.fn()
    const applyModConfigs = vi.fn()
    installMockWindowApi({ modsManager: { getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [] })), applyModConfigs } })
    renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "New.json": entry("{}") }} installation={installation()} close={close} />
      </>
    )

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(await rowFor("New.json"))
    expect((screen.getByRole("button", { name: "Write the chosen configs" }) as HTMLButtonElement).disabled).toBe(true)
    expect(applyModConfigs).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Write none of them" }))
    expect(close).toHaveBeenCalled()
  })

  it("counts the configs a pack carries past the row limit instead of offering them", async () => {
    const settings: Record<string, ModConfigEntry> = {}
    for (let index = 0; index < 52; index += 1) settings[`c${index}.json`] = entry("{}")
    mount(settings, { ok: true, configs: [] })

    await waitFor(() => expect(screen.getByText("c49.json")).toBeTruthy())
    expect(screen.queryByText("c50.json")).toBeNull()
    expect(screen.getByText("and 2 more")).toBeTruthy()
  })
})

describe("ImportModConfigsDialog, what came back", () => {
  it("names the files that did not land and offers the folder the backups went to", async () => {
    const openPathOnFileExplorer = vi.fn()
    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [{ name: "Mine.json", bytes: 2 }] })),
        applyModConfigs: vi.fn(
          async (): Promise<ApplyModConfigsResult> => ({
            ok: true,
            backupFolder: "/backups/Settings/Main/settings_2026-10-01_10-00-00",
            applied: [{ name: "New.json", kind: "new" as const }],
            skipped: [],
            failed: [{ name: "Mine.json", reason: "digest-mismatch" as const }]
          })
        )
      },
      // The reveal path asks whether the folder is there before it opens anything, so a mock that
      // only stubs the channel would answer "it is not there" and the click would do nothing.
      pathsManager: { checkPathExists: vi.fn(async () => true), openPathOnFileExplorer: vi.fn(async (path: string) => openPathOnFileExplorer(path)) }
    })
    renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "New.json": entry("{}"), "Mine.json": entry("{}") }} installation={installation()} close={vi.fn()} />
      </>
    )

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    await waitFor(() => expect(screen.getByText("the pack's copy does not match the checksum it carries")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Open folder on the file explorer" }))
    await waitFor(() => expect(openPathOnFileExplorer).toHaveBeenCalledWith("/backups/Settings/Main/settings_2026-10-01_10-00-00"))
  })

  it("says which refusal happened and stays in the dialog, rather than closing as if it had worked", async () => {
    const close = vi.fn()
    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [] })),
        applyModConfigs: vi.fn(async (): Promise<ApplyModConfigsResult> => ({ ok: false, reason: "no-backups-folder" as const }))
      }
    })
    renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "New.json": entry("{}") }} installation={installation()} close={close} />
      </>
    )

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    await waitFor(() => expect(screen.getByText("This Installation has no backups folder set, and a config is only ever written over a copy of what it replaces. Nothing was written.")).toBeTruthy())
    expect(close).not.toHaveBeenCalled()
  })
})
