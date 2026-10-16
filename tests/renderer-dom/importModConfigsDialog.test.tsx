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
    mount({ "New.json": entry("{}"), "Mine.json": entry("{}") }, { ok: true, configs: [{ name: "Mine.json", bytes: 2 }], linked: [] })

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    expect((await rowFor("Mine.json")).checked).toBe(false)
    expect(within((await screen.findByText("Mine.json")).closest("li") as HTMLElement).getByText("Replaces yours")).toBeTruthy()
  })

  it("calls a file the same file whatever case the two names are written in", async () => {
    // One file on NTFS and on APFS, two on Linux. A dialog that read the pack's capital C as a new
    // file would tick a box that overwrites the config.json sitting on disk.
    mount({ "Config.json": entry("{}") }, { ok: true, configs: [{ name: "config.json", bytes: 2 }], linked: [] })

    await waitFor(async () => expect((await rowFor("Config.json")).checked).toBe(false))
  })

  it("clears a row a link blocks and says why, instead of calling the name new (#621)", async () => {
    // A link at a name, or on a folder above it, is somewhere the host never writes. The listing used
    // to say nothing of it, so the row read "no file at this name", came ticked, and the refusal only
    // arrived after the button. The names are compared the way the replace check compares them, whole
    // folder names only: `ClientExtra` is not under the link called `Client`.
    const { sent } = mount(
      { "Pointed.json": entry("{}"), "client/RoomSize.json": entry("{}"), "ClientExtra/a.json": entry("{}"), "New.json": entry("{}") },
      { ok: true, configs: [], linked: ["pointed.json", "Client"] }
    )

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    for (const name of ["Pointed.json", "client/RoomSize.json"]) {
      const box = await rowFor(name)
      expect(box.checked, `${name} is ticked`).toBe(false)
      expect(box.disabled, `${name} can be ticked`).toBe(true)
      const row = box.closest("li") as HTMLElement
      expect(within(row).getByText("Blocked by a link: the launcher never writes through a link")).toBeTruthy()
      expect(within(row).queryByText("This Installation has no file at this name")).toBeNull()
    }

    for (const name of ["ClientExtra/a.json", "New.json"]) {
      const box = await rowFor(name)
      expect(box.checked, `${name} is not ticked`).toBe(true)
      expect(box.disabled, `${name} cannot be ticked`).toBe(false)
      expect(within(box.closest("li") as HTMLElement).getByText("This Installation has no file at this name")).toBeTruthy()
    }

    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0] as { name: string }[]).map((file) => file.name)).toEqual(["ClientExtra/a.json", "New.json"])
  })

  it("reads a name as blocked, and not as replaced, when a file and a link share it in different cases (#621)", async () => {
    // On a case-sensitive disk `config.json` can be a file and `CONFIG.json` a link. The two are one
    // name to this dialog, which folds case, so the row is not offered at all rather than offered
    // under "Replaces yours" for the host to refuse; the host still decides what is written.
    mount({ "Config.json": entry("{}") }, { ok: true, configs: [{ name: "config.json", bytes: 2 }], linked: ["CONFIG.json"] })

    const box = await rowFor("Config.json")
    await waitFor(() => expect(box.disabled).toBe(true))
    expect(box.checked).toBe(false)
    const row = box.closest("li") as HTMLElement
    expect(within(row).getByText("Blocked by a link: the launcher never writes through a link")).toBeTruthy()
    expect(within(row).queryByText("Replaces yours")).toBeNull()
  })

  it("does not call the folder empty when the only thing in it is a link (#621)", async () => {
    mount({ "Pointed.json": entry("{}") }, { ok: true, configs: [], linked: ["Pointed.json"] })

    await waitFor(async () => expect((await rowFor("Pointed.json")).disabled).toBe(true))
    // "Empty, so every file below is new" would sit right above a row that says a link is in the way.
    expect(screen.queryByText("This Installation's ModConfig folder is empty, so every file below is new.")).toBeNull()
    expect(screen.getByText("This Installation has 0 files in its ModConfig folder.")).toBeTruthy()
    // Nothing is ticked, so there is nothing to write.
    expect((screen.getByRole("button", { name: "Write the chosen configs" }) as HTMLButtonElement).disabled).toBe(true)
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

    await act(async () => void answer({ ok: true, configs: [], linked: [] }))
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
    const { sent } = mount({ "New.json": entry('{"a":1}'), "Mine.json": entry('{"b":2}') }, { ok: true, configs: [{ name: "Mine.json", bytes: 7 }], linked: [] })

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual([{ name: "New.json", text: '{"a":1}', sha256: entry('{"a":1}').sha256 }])
  })

  it("closes without asking the host to write anything when the last box is cleared", async () => {
    const close = vi.fn()
    const applyModConfigs = vi.fn()
    installMockWindowApi({ modsManager: { getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [], linked: [] })), applyModConfigs } })
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

  it("offers every file the pack carries, and writes every file it offered", async () => {
    // A pack may carry up to 2000 entries, so the rows are not capped. A capped list would write the
    // files past the cap with no box to agree to, which is the one outcome the box is there to stop.
    const settings: Record<string, ModConfigEntry> = {}
    for (let index = 0; index < 52; index += 1) settings[`c${index}.json`] = entry("{}")
    const { sent } = mount(settings, { ok: true, configs: [], linked: [] })

    await waitFor(async () => expect((await rowFor("c0.json")).checked).toBe(true))
    expect((await rowFor("c49.json")).checked).toBe(true)
    expect((await rowFor("c51.json")).checked).toBe(true)
    // The pack's own size is stated even though the rows scroll, so the number the player reads is
    // the number of files that will be written.
    expect(screen.getByText("This modpack carries 52 mod config files. Choose which ones to write.")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    // Every row offered, every file written: the two lists are the same list.
    await waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0] as { name: string }[]).map((file) => file.name)).toEqual(Object.keys(settings))
  })

  it("does not claim the folder is empty when the host could not read it", async () => {
    // A failed listing is an empty list as far as a counter is concerned, and the two sentences
    // together read as a folder that was read and found bare, right under one saying it was not.
    mount({ "New.json": entry("{}") }, { ok: false, reason: "mod-config-unreadable" })

    await waitFor(() => expect(screen.getByText("This Installation's mod config folder could not be read, so nothing was written.")).toBeTruthy())
    expect(screen.queryByText("This Installation's ModConfig folder is empty, so every file below is new.")).toBeNull()
  })

  it("says the game is running rather than that the folder could not be read", async () => {
    // Two reasons, two sentences. One is the game holding the folder and the player can end it; the
    // other is a folder the launcher cannot make sense of and they cannot. Reporting the second when
    // the first is true sends them looking for a problem that is not there.
    mount({ "New.json": entry("{}") }, { ok: false, reason: "playing" })

    await waitFor(() => expect(screen.getByText("This Installation is playing. The mod configs can be written once the game has closed.")).toBeTruthy())
    expect(screen.queryByText("This Installation's mod config folder could not be read, so nothing was written.")).toBeNull()
  })
})

describe("ImportModConfigsDialog, when the host throws", () => {
  it("says so instead of leaving the button press with nothing to show for it", async () => {
    // The channel rejects on malformed input rather than answering with a refusal, so this is a
    // designed outcome. Before, the rejection was unhandled: no notification, no state, no answer.
    const { sent } = mount({ "New.json": entry("{}") }, { ok: true, configs: [], linked: [] }, () => Promise.reject(new Error("Invalid mod config request")))

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))

    await waitFor(() => expect(screen.getByText("This Installation's mod config folder could not be read, so nothing was written.")).toBeTruthy())
    expect(sent).toHaveLength(1)
    // Still the question, not a result view: the player has not been told anything landed.
    expect((await rowFor("New.json")).checked).toBe(true)
  })
})

describe("ImportModConfigsDialog, what came back", () => {
  it("names the files that did not land and offers the folder the backups went to", async () => {
    const openPathOnFileExplorer = vi.fn()
    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [{ name: "Mine.json", bytes: 2 }], linked: [] })),
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
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [], linked: [] })),
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

  /**
   * Every refusal has its own sentence, and a player who is told "the launcher was playing" learns
   * something they can act on while a player told the generic unreadable line learns nothing. The
   * last one also answers a rejected channel, which is a designed outcome rather than a crash, so it
   * must not fall silent.
   */
  it("answers each refusal with its own sentence, and a rejected channel with the last one", async () => {
    const refusals: { reason: Extract<ApplyModConfigsResult, { ok: false }>["reason"]; said: string }[] = [
      { reason: "playing", said: "This Installation is playing. The mod configs can be written once the game has closed." },
      { reason: "busy", said: "This Installation is busy. The mod configs can be written once the work in progress is done." },
      { reason: "insufficient-space", said: "There is not enough free space to keep a copy of every file and write the pack's. Nothing was written." },
      { reason: "mod-config-unreadable", said: "This Installation's mod config folder could not be read, so nothing was written." }
    ]

    for (const { reason, said } of refusals) {
      installMockWindowApi({
        modsManager: {
          getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [], linked: [] })),
          applyModConfigs: vi.fn(async (): Promise<ApplyModConfigsResult> => ({ ok: false, reason }))
        }
      })
      const { unmount } = renderWithProviders(
        <>
          <NotificationsOverlay />
          <ImportModConfigsDialog settings={{ "New.json": entry("{}") }} installation={installation()} close={vi.fn()} />
        </>
      )

      await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
      fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))
      await waitFor(() => expect(screen.getByText(said)).toBeTruthy())
      unmount()
    }

    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [], linked: [] })),
        applyModConfigs: vi.fn(async (): Promise<ApplyModConfigsResult> => Promise.reject(new TypeError("Invalid mod config request")))
      }
    })
    const { unmount } = renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "New.json": entry("{}") }} installation={installation()} close={vi.fn()} />
      </>
    )

    await waitFor(async () => expect((await rowFor("New.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))
    await waitFor(() => expect(screen.getByText("This Installation's mod config folder could not be read, so nothing was written.")).toBeTruthy())
    unmount()
  })

  /**
   * Each failure reason is one sentence per row, and the three this branch's host can answer are the
   * ones a player cannot guess: the copy did not happen, the copy landed wrong, the file did not
   * take. A row that fell through to the wrong one of the four would send them looking in the wrong
   * place, which is the whole job of this list.
   */
  it("gives every reason the host can answer its own line, all four in one apply", async () => {
    installMockWindowApi({
      modsManager: {
        getModConfigs: vi.fn(async (): Promise<ModConfigsReadResult> => ({ ok: true, configs: [{ name: "Mine.json", bytes: 2 }], linked: [] })),
        applyModConfigs: vi.fn(
          async (): Promise<ApplyModConfigsResult> => ({
            ok: true,
            backupFolder: "",
            applied: [{ name: "New.json", kind: "new" as const }],
            skipped: [],
            failed: [
              { name: "Copy.json", reason: "copy-failed" as const },
              { name: "Short.json", reason: "not-landed" as const },
              { name: "Long.json", reason: "write-failed" as const }
            ]
          })
        )
      }
    })
    renderWithProviders(
      <>
        <NotificationsOverlay />
        <ImportModConfigsDialog settings={{ "Copy.json": entry("{}"), "Short.json": entry("{}"), "Long.json": entry("{}"), "Mine.json": entry("{}") }} installation={installation()} close={vi.fn()} />
      </>
    )

    await waitFor(async () => expect((await rowFor("Copy.json")).checked).toBe(true))
    fireEvent.click(screen.getByRole("button", { name: "Write the chosen configs" }))
    await waitFor(() => expect(screen.getByText("the copy for the backup folder could not be made")).toBeTruthy())
    const rows = screen.getAllByRole("listitem")
    assertReasons(["Copy.json", "the copy for the backup folder could not be made"], rows)
    assertReasons(["Short.json", "the backup copy does not match the file on disk"], rows)
    assertReasons(["Long.json", "the file could not be written"], rows)
  })
})

/** The two lines of a failure row: the file's name, and the reason it did not land. */
function assertReasons([name, reason]: [string, string], rows: HTMLElement[]): void {
  const row = rows.find((element) => element.textContent?.includes(name))
  expect(row, `no row for ${name}`).toBeTruthy()
  expect(within(row as HTMLElement).getByText(reason)).toBeTruthy()
}
