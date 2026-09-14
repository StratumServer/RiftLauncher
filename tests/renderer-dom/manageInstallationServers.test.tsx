import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageInstallationServers from "@renderer/features/servers/pages/ManageInstallationServers"
import ImportServersDialog from "@renderer/features/servers/components/ImportServersDialog"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { MAX_SERVER_BOOKMARKS, normalizeServerBookmarks } from "@domain/servers/bookmarks"

import { useInstallations } from "@renderer/features/config/contexts/ConfigContext"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const INSTALLATION_ID = "install-a"

function anInstallation(servers?: ServerBookmarkType[]): InstallationType {
  return {
    id: INSTALLATION_ID,
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.22.7",
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
    ...(servers ? { servers } : {})
  }
}

function renderServersPage(servers?: ServerBookmarkType[], overrides: WindowApiOverrides = {}): ReturnType<typeof installMockWindowApi> {
  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () =>
        createMockConfig({
          installations: [anInstallation(servers)],
          gameVersions: [{ id: "gv-1", version: "1.22.7", label: "1.22.7", path: "/versions/1.22.7" }]
        })
      )
    },
    ...overrides
  })

  renderWithProviders(
    <Routes>
      <Route
        path="/installations/servers/:id"
        element={
          <TaskProvider>
            <ManageInstallationServers />
            <NotificationsOverlay />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: `/installations/servers/${INSTALLATION_ID}` }
  )

  return api
}

/** A full list of distinct bookmarks, for the two places that refuse to go past the cap. */
function manyServers(count: number): ServerBookmarkType[] {
  return Array.from({ length: count }, (_, index) => ({ id: `s-${index}`, name: `Server ${index}`, host: `h${index}.example.com`, port: 42_420, lastLaunched: -1 }))
}

/** Fills the Add dialog and presses Save. The port field lives behind the Advanced disclosure. */
async function addServer(user: ReturnType<typeof userEvent.setup>, name: string, host: string, port?: number): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Add a server" }))
  await user.type(await screen.findByLabelText("Name"), name)
  await user.type(screen.getByLabelText("Address"), host)

  if (port !== undefined) {
    await user.click(screen.getByRole("button", { name: "Advanced" }))
    const portField = await screen.findByLabelText("Port")
    await user.clear(portField)
    await user.type(portField, String(port))
  }

  await user.click(screen.getByRole("button", { name: "Save" }))
}

describe("ManageInstallationServers", () => {
  it("says the Installation has no servers, and what the page is for", async () => {
    renderServersPage()

    expect(await screen.findByText("No servers saved for this Installation.")).toBeTruthy()
    expect(screen.getByText("Servers you add here are joined straight from the launcher.")).toBeTruthy()
  })

  it("adds a server and shows it with the default port hidden", async () => {
    const user = userEvent.setup()
    const api = renderServersPage()

    await addServer(user, "Stratum", "play.example.com")

    expect(await screen.findByText("Stratum")).toBeTruthy()
    expect(screen.getByText("play.example.com")).toBeTruthy()
    expect(screen.getByText("Never launched")).toBeTruthy()
    expect(screen.queryByText("play.example.com:42420")).toBe(null)

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers?.[0]).toMatchObject({ name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 })
  })

  it("shows the port beside the address when it is not the default one", async () => {
    const user = userEvent.setup()
    renderServersPage()

    await addServer(user, "Odd port", "play.example.com", 30_000)

    expect(await screen.findByText("play.example.com:30000")).toBeTruthy()
  })

  it("refuses an address that is not a host name, and says so instead of saving", async () => {
    const user = userEvent.setup()
    const api = renderServersPage()

    await addServer(user, "Broken", "play.example.com:42420")

    expect((await screen.findByRole("alert")).textContent).toBe("That address is not a host name or an IP address.")
    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers).toBe(undefined)
  })

  it("refuses a second bookmark for the same address and port", async () => {
    const user = userEvent.setup()
    renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }])

    await addServer(user, "Stratum again", "play.example.com")

    expect((await screen.findByRole("alert")).textContent).toBe("This Installation already has that server.")
  })

  it("takes the refusal away as soon as the player edits the field it was about", async () => {
    const user = userEvent.setup()
    renderServersPage()

    await addServer(user, "Broken", "play.example.com:42420")
    expect(await screen.findByRole("alert")).toBeTruthy()

    await user.type(screen.getByLabelText("Address"), "x")

    expect(screen.queryByRole("alert")).toBe(null)
  })

  it("edits a stored server in place, keeping its launch stamp", async () => {
    const user = userEvent.setup()
    const api = renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: 1_700_000_000_000 }])

    await user.click(await screen.findByRole("button", { name: "Edit server" }))
    const nameField = await screen.findByLabelText("Name")
    await user.clear(nameField)
    await user.type(nameField, "Stratum main")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("Stratum main")).toBeTruthy()
    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers).toEqual([{ id: "s-1", name: "Stratum main", host: "play.example.com", port: 42_420, lastLaunched: 1_700_000_000_000 }])
  })

  it("asks before removing a server, and leaves the Installation alone", async () => {
    const user = userEvent.setup()
    const api = renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }])

    await user.click(await screen.findByRole("button", { name: "Remove server" }))
    expect(await screen.findByText("Are you sure you want to remove this server? The Installation and its Mods are left alone.")).toBeTruthy()

    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    expect(await screen.findByText("No servers saved for this Installation.")).toBeTruthy()
    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers).toEqual([])
    expect(saved?.installations[0]?.id).toBe(INSTALLATION_ID)
  })

  /**
   * The row's whole point, and the one assertion that matters for #460's boundary: Join hands the
   * bridge a bookmark id, never an address. What that id turns into is the main process's business
   * (tests/ipc/gameHandlers.test.ts), and nothing here could make it anything else.
   */
  it("joins by handing the bridge the bookmark id and nothing else", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn<BridgeAPI["gameManager"]["executeGame"]>(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)
    renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }], { gameManager: { executeGame } })

    await user.click(await screen.findByRole("button", { name: "Join" }))

    expect(executeGame).toHaveBeenCalledTimes(1)
    expect(executeGame.mock.calls[0]?.[2]).toBe("s-1")
    // Not an address, not a URL: an opaque id the main process resolves against its own config.
    expect(executeGame.mock.calls[0]?.[2]).not.toContain("vintagestoryjoin")
  })

  it("stamps the bookmark as launched once the game has run", async () => {
    const user = userEvent.setup()
    const executeGame = vi.fn<BridgeAPI["gameManager"]["executeGame"]>(async () => ({ ok: true, exitCode: 0 }) as GameExecutionResult)
    const api = renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }], { gameManager: { executeGame } })

    await user.click(await screen.findByRole("button", { name: "Join" }))

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.[0]?.lastLaunched).toBeGreaterThan(0)
    })
  })

  /**
   * The launcher window stays usable for the whole game session, and this page is where the player
   * already is, so the list the stamp is written from is hours old by the time the game exits. It
   * has to be read at stamp time, not from what Join captured.
   */
  it("keeps a bookmark the player added while the game was running", async () => {
    const user = userEvent.setup()
    let finishGame: (result: GameExecutionResult) => void = () => {}
    const executeGame = vi.fn<BridgeAPI["gameManager"]["executeGame"]>(() => new Promise<GameExecutionResult>((resolve) => (finishGame = resolve)))
    const api = renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }], { gameManager: { executeGame } })

    await user.click(await screen.findByRole("button", { name: "Join" }))
    await vi.waitFor(() => expect(executeGame).toHaveBeenCalledTimes(1))

    await addServer(user, "Testing", "test.example.com")
    expect(await screen.findByText("Testing")).toBeTruthy()

    finishGame({ ok: true, exitCode: 0 } as GameExecutionResult)

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.[0]?.lastLaunched).toBeGreaterThan(0)
    })

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers?.map((server) => server.name)).toEqual(["Stratum", "Testing"])
  })

  /**
   * i18next escapes what it interpolates, so a date handed to t() reaches the page as
   * "4&#x2F;9&#x2F;2025" and React renders those entities literally. Every launched row read that
   * way. The date is the launcher's own, not anybody's text, so it goes in unescaped.
   */
  it("reads the launch stamp as a date rather than escaped punctuation", async () => {
    const lastLaunched = 1_757_000_000_000
    renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched }])

    const stamp = await screen.findByText(/Last launched/)
    expect(stamp.textContent).toBe(`Last launched ${new Date(lastLaunched).toLocaleString("es")}`)
  })

  /**
   * The app denies every renderer permission (src/main/index.ts), clipboard-write included, so
   * navigator.clipboard always throws here. The copy goes through the host instead, which is the
   * only clipboard this app can reach.
   */
  it("copies the address through the host bridge and says it worked", async () => {
    const user = userEvent.setup()
    const copyToClipboard = vi.fn<BridgeAPI["utils"]["copyToClipboard"]>(async () => true)
    renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 30_000, lastLaunched: -1 }], { utils: { copyToClipboard } })

    await user.click(await screen.findByRole("button", { name: "Copy address" }))

    expect(copyToClipboard).toHaveBeenCalledWith("play.example.com:30000")
    expect(await screen.findByText("Address copied.")).toBeTruthy()
  })

  it("copies a non-default IPv6 address with brackets", async () => {
    const user = userEvent.setup()
    const copyToClipboard = vi.fn<BridgeAPI["utils"]["copyToClipboard"]>(async () => true)
    renderServersPage([{ id: "s-1", name: "Stratum", host: "2001:db8::1", port: 30_000, lastLaunched: -1 }], { utils: { copyToClipboard } })

    await user.click(await screen.findByRole("button", { name: "Copy address" }))

    expect(copyToClipboard).toHaveBeenCalledWith("[2001:db8::1]:30000")
  })

  it("copies an IPv6 address on the default port bare, since no port sits beside it to misread", async () => {
    const user = userEvent.setup()
    const copyToClipboard = vi.fn<BridgeAPI["utils"]["copyToClipboard"]>(async () => true)
    renderServersPage([{ id: "s-1", name: "Stratum", host: "2001:db8::1", port: 42_420, lastLaunched: -1 }], { utils: { copyToClipboard } })

    await user.click(await screen.findByRole("button", { name: "Copy address" }))

    expect(copyToClipboard).toHaveBeenCalledWith("2001:db8::1")
  })

  /** The row and the clipboard read one address, so an IPv6 bookmark cannot show one and copy another. */
  it("shows a non-default IPv6 address on the row with the same brackets it copies", async () => {
    renderServersPage([{ id: "s-1", name: "Stratum", host: "2001:db8::1", port: 30_000, lastLaunched: -1 }])

    expect(await screen.findByText("[2001:db8::1]:30000")).toBeTruthy()
  })

  it("says so and opens nothing when the host refuses the copy", async () => {
    const user = userEvent.setup()
    const copyToClipboard = vi.fn<BridgeAPI["utils"]["copyToClipboard"]>(async () => false)
    renderServersPage([{ id: "s-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 }], { utils: { copyToClipboard } })

    await user.click(await screen.findByRole("button", { name: "Copy address" }))

    expect(copyToClipboard).toHaveBeenCalledWith("play.example.com")
    expect(await screen.findByText("The address could not be copied.")).toBeTruthy()
  })

  /**
   * The config normalizer caps the stored list, so a 51st bookmark would simply be gone after the
   * next restart. The page has to refuse it while the player is still looking at it.
   */
  it("refuses to open the Add dialog once the Installation is at the cap", async () => {
    const user = userEvent.setup()
    renderServersPage(manyServers(MAX_SERVER_BOOKMARKS))

    await user.click(await screen.findByRole("button", { name: "Add a server" }))

    expect(await screen.findByText(`An Installation can hold at most ${MAX_SERVER_BOOKMARKS} servers.`)).toBeTruthy()
    expect(screen.queryByLabelText("Name")).toBe(null)
  })
})

/**
 * The only thing between a stranger's modpack and the config. Everything the pack carried is shown,
 * the boxes start ticked (adding an address to your own launcher discloses nothing), and nothing is
 * written until the player presses the button.
 */
describe("ImportServersDialog", () => {
  const carried: ServerBookmarkType[] = [
    { id: "p-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: -1 },
    { id: "p-2", name: "Testing", host: "test.example.com", port: 30_000, lastLaunched: -1 }
  ]

  function renderImportDialog(existing?: ServerBookmarkType[], packServers: readonly ServerBookmarkType[] = carried): ReturnType<typeof installMockWindowApi> {
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(existing)] })) }
    })

    renderWithProviders(
      <>
        <DialogUnderTest packServers={packServers} />
        <ServerCountProbe />
        <NotificationsOverlay />
      </>
    )
    return api
  }

  /** What the Installation holds right now, read off the context the dialog writes to. */
  function ServerCountProbe(): JSX.Element {
    const installations = useInstallations()
    return <span data-testid="server-count">{installations.find((candidate) => candidate.id === INSTALLATION_ID)?.servers?.length ?? 0}</span>
  }

  /** Reads the Installation out of context so the dialog gets the same object the page would hand it. */
  function DialogUnderTest({ packServers }: Readonly<{ packServers: readonly ServerBookmarkType[] }>): JSX.Element {
    const installations = useInstallations()
    return <ImportServersDialog servers={packServers} installation={installations.find((candidate) => candidate.id === INSTALLATION_ID)} close={() => {}} />
  }

  it("lists everything the pack carried, ticked, and says how many there are", async () => {
    renderImportDialog()

    expect(await screen.findByText("This modpack carries 2 server(s). Choose which ones to add.")).toBeTruthy()
    expect((screen.getByLabelText(/Stratum/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/Testing/) as HTMLInputElement).checked).toBe(true)
  })

  it("adds only what is still ticked", async () => {
    const user = userEvent.setup()
    const api = renderImportDialog()

    await user.click(await screen.findByLabelText(/Testing/))
    await user.click(screen.getByRole("button", { name: "Add the chosen servers" }))

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.map((server) => server.name)).toEqual(["Stratum"])
    })
  })

  it("gives every added server an id of ours rather than the pack's", async () => {
    const user = userEvent.setup()
    const api = renderImportDialog()

    await user.click(await screen.findByRole("button", { name: "Add the chosen servers" }))

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.map((server) => server.id)).not.toContain("p-1")
    })
  })

  it("skips an address the Installation already has instead of doubling it", async () => {
    const user = userEvent.setup()
    const api = renderImportDialog([{ id: "own", name: "Mine", host: "play.example.com", port: 42_420, lastLaunched: -1 }])

    await user.click(await screen.findByRole("button", { name: "Add the chosen servers" }))

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.map((server) => server.name)).toEqual(["Mine", "Testing"])
    })
  })

  /**
   * A pack is parsed by normalizeServerBookmarks, and two entries wearing one id used to come out
   * of it as two rows. Every checkbox here is keyed on that id, so clearing one cleared both and
   * ticking one brought both back: the row the player cleared was written anyway.
   */
  it("never writes a server whose box the player cleared, even when the pack repeats an id", async () => {
    const user = userEvent.setup()
    const repeated = normalizeServerBookmarks([
      { id: "p-1", name: "Wanted", host: "wanted.example.com", port: 42_420, lastLaunched: -1 },
      { id: "p-1", name: "Unwanted", host: "unwanted.example.com", port: 42_420, lastLaunched: -1 }
    ])
    const api = renderImportDialog(undefined, repeated)

    const boxes = await screen.findAllByRole("checkbox")
    await user.click(boxes[boxes.length - 1]!)
    await user.click(boxes[0]!)
    await user.click(screen.getByRole("button", { name: "Add the chosen servers" }))

    await vi.waitFor(() => {
      const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(saved?.installations[0]?.servers?.map((server) => server.name)).toEqual(["Wanted"])
    })
  })

  /**
   * Past the cap the config normalizer simply truncates on the next read, so bookmarks a player
   * watched arrive would be gone after a restart with nothing said. The dialog stops at it instead.
   */
  it("adds nothing to an Installation that is already at the cap", async () => {
    const user = userEvent.setup()
    renderImportDialog(manyServers(MAX_SERVER_BOOKMARKS))

    await vi.waitFor(() => expect(screen.getByTestId("server-count").textContent).toBe(String(MAX_SERVER_BOOKMARKS)))
    await user.click(await screen.findByRole("button", { name: "Add the chosen servers" }))

    expect(screen.getByTestId("server-count").textContent).toBe(String(MAX_SERVER_BOOKMARKS))
  })

  it("writes nothing when the player skips the servers", async () => {
    const user = userEvent.setup()
    const api = renderImportDialog()

    await user.click(await screen.findByLabelText(/Stratum/))
    await user.click(screen.getByLabelText(/Testing/))
    await user.click(screen.getByRole("button", { name: "Add the chosen servers" }))

    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
    expect(saved?.installations[0]?.servers).toBe(undefined)
  })
})
