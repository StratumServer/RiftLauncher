import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
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
    envVars: "",
    ...overrides
  }
}

/** The countdown each banner on screen was given: null means it stays until it is closed. */
function DurationProbe(): JSX.Element {
  const { activeToasts } = useNotificationsContext()
  return <output data-testid="durations">{activeToasts.map((toast) => String(toast.record.options?.duration)).join(",")}</output>
}

function trashButton(index: number): HTMLElement {
  const button = screen.getAllByTitle("Delete Installation")[index]
  if (!button) throw new Error(`No Delete Installation button at ${index}`)
  return button
}

describe("ListInstallations", () => {
  it("leaves the Installation alone until the confirm dialog is accepted, then drops it", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    await screen.findByText("Install A")

    await user.click(screen.getByTitle("Delete Installation"))

    // The confirm dialog is up. The Installation is still in the list behind it:
    // clicking the trash icon alone must not have deleted anything yet.
    await screen.findByText("Are you sure you want to delete this Installation?")
    expect(screen.getByText("Install A")).toBeTruthy()

    await user.click(screen.getByTitle("Delete"))

    // deleteData starts unchecked, so this goes through deleteInstallation's
    // ok-without-touching-disk path (see src/domain/installations/delete.ts):
    // the record still has to disappear from the list once that resolves.
    await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Installation?")).toBeNull())
  })

  it("does not delete when the confirm dialog is cancelled", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    await screen.findByText("Install A")

    await user.click(screen.getByTitle("Delete Installation"))
    await screen.findByText("Are you sure you want to delete this Installation?")

    await user.click(screen.getByTitle("Cancel"))

    await waitFor(() => expect(screen.queryByText("Are you sure you want to delete this Installation?")).toBeNull())
    expect(screen.getByText("Install A")).toBeTruthy()
  })

  describe("Delete data starts unticked on the next dialog", () => {
    const QUESTION = "Are you sure you want to delete this Installation?"

    async function tickThenClose(close: (user: ReturnType<typeof userEvent.setup>) => Promise<void>): Promise<void> {
      const user = userEvent.setup()
      installMockWindowApi({
        configManager: {
          getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" })] }))
        }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install B")

      await user.click(trashButton(0))
      await screen.findByText(QUESTION)
      await user.click(screen.getByLabelText("Delete data"))
      expect((screen.getByLabelText("Delete data") as HTMLInputElement).checked).toBe(true)

      await close(user)
      await waitFor(() => expect(screen.queryByText(QUESTION)).toBeNull())

      await user.click(trashButton(1))
      await screen.findByText(QUESTION)
    }

    it("opens the next dialog unticked after Cancel", async () => {
      await tickThenClose(async (user) => user.click(screen.getByTitle("Cancel")))
      expect((screen.getByLabelText("Delete data") as HTMLInputElement).checked).toBe(false)
    })

    it("opens the next dialog unticked after Escape", async () => {
      await tickThenClose(async (user) => user.keyboard("{Escape}"))
      expect((screen.getByLabelText("Delete data") as HTMLInputElement).checked).toBe(false)
    })

    it("opens the next dialog unticked after a confirmed delete", async () => {
      const user = userEvent.setup()
      const deletePath = vi.fn(async () => true)
      installMockWindowApi({
        configManager: {
          getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" })] }))
        },
        pathsManager: { deletePath, checkPathExists: vi.fn(async () => true) }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install B")

      await user.click(trashButton(0))
      await screen.findByText(QUESTION)
      await user.click(screen.getByLabelText("Delete data"))
      await user.click(screen.getByTitle("Delete"))
      await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
      await waitFor(() => expect(screen.queryByText(QUESTION)).toBeNull())
      expect(deletePath).toHaveBeenCalledWith("/games/a")

      await user.click(screen.getByTitle("Delete Installation"))
      await screen.findByText(QUESTION)
      expect((screen.getByLabelText("Delete data") as HTMLInputElement).checked).toBe(false)
    })

    it("opens the next dialog unticked after a click outside the dialog", async () => {
      await tickThenClose(async (user) => user.click(document.body))
      expect((screen.getByLabelText("Delete data") as HTMLInputElement).checked).toBe(false)
    })
  })

  it("renders Manage Worlds beside Delete in the actions strip", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) } })

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    const deleteBtn = await screen.findByTitle("Delete Installation")
    const worldsBtn = await screen.findByTitle("Manage Worlds")
    expect(deleteBtn.parentElement).toBe(worldsBtn.parentElement)
  })

  describe("an Installation whose folder holds another managed folder (#713)", () => {
    async function deleteAWithData(config: Partial<ConfigType>): Promise<{ deletePath: ReturnType<typeof vi.fn> }> {
      const user = userEvent.setup()
      const deletePath = vi.fn(async () => true)
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()], ...config })) },
        pathsManager: { deletePath }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
          <NotificationsOverlay />
          <DurationProbe />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install A")
      await user.click(screen.getAllByTitle("Delete Installation")[0]!)
      await user.click(await screen.findByLabelText("Delete data"))
      await user.click(screen.getByTitle("Delete"))
      return { deletePath }
    }

    const wouldErase = "so deleting its data would erase it"
    const installationMessage = (name: string, path: string): string =>
      `This Installation's folder holds another Installation, ${name} (${path}), ${wouldErase}. Move its folder out of this one by hand, remove its entry from the Installations page with "Delete data" unticked (the launcher then forgets its backups and world backups, so copy any you want first), and add it again from the new folder.`
    const versionMessage = (path: string): string =>
      `This Installation's folder holds the VS Version ${path}, ${wouldErase}. Uninstall that VS Version from the VS Versions page first, and do not move a VS Version folder by hand.`
    const linkedVersionMessage = (path: string): string =>
      `This Installation's folder holds the linked VS Version ${path}, ${wouldErase}. Move that folder out of this one by hand, remove the VS Version from the VS Versions page (its files stay where they are), then add it again with "Add an already installed VS Version" from the new folder.`
    const sameFolderMessage = (name: string): string =>
      `This Installation shares its folder with ${name}, so deleting its data would erase that Installation too. Remove the entry of ${name} from the Installations page with "Delete data" unticked (the launcher then forgets its backups and world backups, so copy any you want first), then try again.`
    const sameFolderVersionMessage =
      "This Installation's folder is also the folder of the VS Version 1.20.0, and its game files sit in it, so deleting its data would erase them. Remove 1.20.0 from the VS Versions page first, then try again."
    const configMessage = (path: string): string =>
      `This Installation's folder holds ${path}, a folder set in Config, ${wouldErase}. Change that setting to a folder outside this Installation, then try again.`
    /** One short message per kind: whatever the others say must not be on screen. */
    const otherKinds = [
      /another Installation, /,
      /holds the VS Version /,
      /a folder set in Config/,
      /a listed backup of/,
      /shares its folder with/,
      /holds the linked VS Version /,
      /is also the folder of the VS Version /
    ]

    it.each([
      ["another Installation", { installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/a/b" })] }, installationMessage("Install B", "/games/a/b"), 0],
      ["a VS Version", { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a/game" }] }, versionMessage("/games/a/game"), 1],
      ["the Backups folder", { backupsFolder: "/games/a/Backups" }, configMessage("/games/a/Backups"), 2],
      ["a linked VS Version", { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a/game", linked: true }] }, linkedVersionMessage("/games/a/game"), 5],
      ["a VS Version on the same folder", { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a" }] }, sameFolderVersionMessage, 6],
      ["a linked VS Version on the same folder", { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a", linked: true }] }, sameFolderVersionMessage, 6],
      ["another Installation on the same folder", { installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B" })] }, sameFolderMessage("Install B"), 4]
    ])("says only what applies when it holds %s, keeps the message up and removes nothing", async (_name, config, message, kind) => {
      const { deletePath } = await deleteAWithData(config as Partial<ConfigType>)

      expect(await screen.findByText(message)).toBeTruthy()
      expect(deletePath).not.toHaveBeenCalled()
      expect(screen.getByText("Install A")).toBeTruthy()
      for (const [index, other] of otherKinds.entries()) if (index !== kind) expect(screen.queryByText(other)).toBeNull()
      // The steps are in the message, so it does not close by itself.
      expect(screen.getByTestId("durations").textContent).toBe("null")
    })

    const aListedArchive = "/games/a/Backups/Installations/b/b1.tar.gz"
    const installationB = (overrides: Partial<InstallationType>): InstallationType => anInstallation({ id: "install-b", name: "Install B", path: "/games/b", ...overrides })
    const archiveMessage = (what: string, page: string, total: number): string =>
      `This Installation's folder holds ${aListedArchive}, a listed backup of ${what}, ${wouldErase} (listed archives in this folder: ${total}). Copy the file elsewhere if you want to keep it, then delete that backup from the ${page} page of Install B.`

    it.each([
      ["a backup", { backups: [{ id: "b1", date: 1, path: aListedArchive }] }, archiveMessage("Install B", "Backups", 1)],
      ["a world backup", { worldBackups: [{ id: "w1", date: 1, path: aListedArchive, worldName: "My World" }] }, archiveMessage("the world My World of Install B", "Worlds", 1)],
      [
        "several archives",
        {
          backups: [
            { id: "b1", date: 1, path: aListedArchive },
            { id: "b2", date: 2, path: "/games/a/Backups/Installations/b/b2.tar.gz" }
          ]
        },
        archiveMessage("Install B", "Backups", 2)
      ]
    ])("names the owner of the listed archive it holds (%s) and how many there are, keeps the message up and removes nothing", async (_name, records, message) => {
      const { deletePath } = await deleteAWithData({ installations: [anInstallation(), installationB(records as Partial<InstallationType>)] })

      expect(await screen.findByText(message)).toBeTruthy()
      expect(deletePath).not.toHaveBeenCalled()
      expect(screen.getByText("Install A")).toBeTruthy()
      for (const [index, other] of otherKinds.entries()) if (index !== 3) expect(screen.queryByText(other)).toBeNull()
      expect(screen.getByTestId("durations").textContent).toBe("null")
    })

    it("reports a listed archive before the Installation that owns it, which sits inside as well", async () => {
      const inner = anInstallation({ id: "install-b", name: "Install B", path: "/games/a/b", backups: [{ id: "b1", date: 1, path: "/games/a/b/Backups/b1.tar.gz" }] })
      const { deletePath } = await deleteAWithData({ installations: [anInstallation(), inner] })

      expect(await screen.findByText(/a listed backup of Install B/)).toBeTruthy()
      expect(screen.queryByText(/another Installation, /)).toBeNull()
      expect(deletePath).not.toHaveBeenCalled()
    })

    // The player asked for these archives to go, and the records leave with the Installation: its own are not held.
    it("deletes it with its data when the only archives inside are its own backups and world backups", async () => {
      const own = anInstallation({
        backups: [{ id: "a1", date: 1, path: "/games/a/Backups/Installations/a/a1.tar.gz" }],
        worldBackups: [{ id: "w1", date: 1, path: "/games/a/Backups/Worlds/w1.tar.gz", worldName: "My World" }]
      })
      const { deletePath } = await deleteAWithData({ installations: [own] })

      await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
      expect(deletePath).toHaveBeenCalledWith("/games/a")
      expect(screen.queryByText(/would erase it/)).toBeNull()
    })

    it("deletes without the data even when it holds another Installation", async () => {
      const user = userEvent.setup()
      installMockWindowApi({
        configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/a/b" })] })) }
      })

      renderWithProviders(
        <TaskProvider>
          <ListInstallations />
        </TaskProvider>,
        { route: "/installations" }
      )

      await screen.findByText("Install A")
      await user.click(screen.getAllByTitle("Delete Installation")[0]!)
      await user.click(await screen.findByTitle("Delete"))

      await waitFor(() => expect(screen.queryByText("Install A")).toBeNull())
      expect(screen.getByText("Install B")).toBeTruthy()
    })
  })
})
