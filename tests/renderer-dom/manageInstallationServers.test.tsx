import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageInstallationServers from "@renderer/features/servers/pages/ManageInstallationServers"
import ImportServersDialog from "@renderer/features/servers/components/ImportServersDialog"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

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
          </TaskProvider>
        }
      />
    </Routes>,
    { route: `/installations/servers/${INSTALLATION_ID}` }
  )

  return api
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

  function renderImportDialog(existing?: ServerBookmarkType[]): ReturnType<typeof installMockWindowApi> {
    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(existing)] })) }
    })

    renderWithProviders(<DialogUnderTest />)
    return api
  }

  /** Reads the Installation out of context so the dialog gets the same object the page would hand it. */
  function DialogUnderTest(): JSX.Element {
    const installations = useInstallations()
    return <ImportServersDialog servers={carried} installation={installations.find((candidate) => candidate.id === INSTALLATION_ID)} close={() => {}} />
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
