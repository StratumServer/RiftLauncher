import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import ManageInstallationBackups from "@renderer/features/installations/pages/ManageInstallationBackups"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallationWithBackup(): InstallationType {
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
    backups: [{ id: "backup-1", date: Date.now(), path: "/backups/a/backup-1.zip" }],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0
  }
}

/** The countdown each banner on screen was given: null means it stays until it is closed. */
function DurationProbe(): JSX.Element {
  const { activeToasts } = useNotificationsContext()
  return <output data-testid="durations">{activeToasts.map((toast) => String(toast.record.options?.duration)).join(",")}</output>
}

/** ManageInstallationBackups reads its Installation id off the route, so the harness needs a real Route match, not just a MemoryRouter entry. */
function renderManageBackups(installationId: string): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <Routes>
      <Route
        path="/installations/backups/:id"
        element={
          <TaskProvider>
            <ManageInstallationBackups />
            <NotificationsOverlay />
            <DurationProbe />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: `/installations/backups/${installationId}` }
  )
}

describe("ManageInstallationBackups", () => {
  it("does not touch the backup until the restore confirm dialog is accepted", async () => {
    const user = userEvent.setup()
    const extractOnPath = vi.fn(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        movePath: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        extractOnPath,
        changePerms: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")

    expect(extractOnPath).not.toHaveBeenCalled()
  })

  const nestedArchive = "/games/a/Backups/Installations/b/b1.tar.gz"
  const archiveOwner = { id: "install-b", name: "Install B", path: "/games/b" }
  const wouldErase = "so restoring would erase it"
  const archiveMessage = (what: string, page: string, total: number): string =>
    `This Installation's folder holds ${nestedArchive}, a listed backup of ${what}, ${wouldErase} (listed archives in this folder: ${total}). Copy the file elsewhere if you want to keep it, then delete that backup from the ${page} page of Install B.`
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

  /** Opens the restore dialog of Install A (at /games/a) and confirms it, with the given config around it. */
  async function confirmRestoreOfA(config: Partial<ConfigType>, installationA: Partial<InstallationType> = {}): Promise<{ extractOnPath: ReturnType<typeof vi.fn> }> {
    const user = userEvent.setup()
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    const main = { ...anInstallationWithBackup(), path: "/games/a", ...installationA }
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [main], ...config })) },
      pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")
    await user.click(screen.getByTitle("Restore"))
    return { extractOnPath }
  }
  const aWith = (...others: object[]): Partial<ConfigType> => ({
    installations: [{ ...anInstallationWithBackup(), path: "/games/a" }, ...others.map((other) => ({ ...anInstallationWithBackup(), backups: [], ...other }))]
  })

  it.each([
    ["a backup archive", aWith({ ...archiveOwner, backups: [{ id: "b1", date: 1, path: nestedArchive }] }), archiveMessage("Install B", "Backups", 1), 3],
    [
      "a world backup archive",
      aWith({ ...archiveOwner, worldBackups: [{ id: "w1", date: 1, path: nestedArchive, worldName: "My World" }] }),
      archiveMessage("the world My World of Install B", "Worlds", 1),
      3
    ],
    [
      "several archives",
      aWith({
        ...archiveOwner,
        backups: [
          { id: "b1", date: 1, path: nestedArchive },
          { id: "b2", date: 2, path: "/games/a/Backups/Installations/b/b2.tar.gz" }
        ]
      }),
      archiveMessage("Install B", "Backups", 2),
      3
    ],
    [
      "another Installation",
      aWith({ ...archiveOwner, path: "/games/a/b" }),
      `This Installation's folder holds another Installation, Install B (/games/a/b), ${wouldErase}. Move its folder out of this one by hand, remove its entry from the Installations page with "Delete data" unticked (the launcher then forgets its backups and world backups, so copy any you want first), and add it again from the new folder.`,
      0
    ],
    [
      "a VS Version",
      { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a/game" }] } as Partial<ConfigType>,
      `This Installation's folder holds the VS Version /games/a/game, ${wouldErase}. Uninstall that VS Version from the VS Versions page first, and do not move a VS Version folder by hand.`,
      1
    ],
    [
      "a linked VS Version",
      { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a/game", linked: true }] } as Partial<ConfigType>,
      `This Installation's folder holds the linked VS Version /games/a/game, ${wouldErase}. Move that folder out of this one by hand, remove the VS Version from the VS Versions page (its files stay where they are), then add it again with "Add an already installed VS Version" from the new folder.`,
      5
    ],
    [
      "a VS Version on the same folder",
      { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a" }] } as Partial<ConfigType>,
      "This Installation's folder is also the folder of the VS Version 1.20.0, and its game files sit in it, so restoring would erase them. Remove 1.20.0 from the VS Versions page first, then try again.",
      6
    ],
    [
      "a linked VS Version on the same folder",
      { gameVersions: [{ id: "gv-1", label: "1.20.0", version: "1.20.0", path: "/games/a", linked: true }] } as Partial<ConfigType>,
      "This Installation's folder is also the folder of the VS Version 1.20.0, and its game files sit in it, so restoring would erase them. Remove 1.20.0 from the VS Versions page first, then try again.",
      6
    ],
    [
      "another Installation on the same folder",
      aWith({ ...archiveOwner, path: "/games/a" }),
      'This Installation shares its folder with Install B, so restoring would erase that Installation too. Remove the entry of Install B from the Installations page with "Delete data" unticked (the launcher then forgets its backups and world backups, so copy any you want first), then try again.',
      4
    ],
    [
      "the Backups folder from Config",
      { backupsFolder: "/games/a/Backups" } as Partial<ConfigType>,
      `This Installation's folder holds /games/a/Backups, a folder set in Config, ${wouldErase}. Change that setting to a folder outside this Installation, then try again.`,
      2
    ]
  ])("refuses to restore, before any extraction, while the folder holds %s, with only the message that applies kept up", async (_name, config, message, kind) => {
    const { extractOnPath } = await confirmRestoreOfA(config)

    expect(await screen.findByText(message)).toBeTruthy()
    for (const [index, other] of otherKinds.entries()) if (index !== kind) expect(screen.queryByText(other)).toBeNull()
    // The steps are in the message, so it does not close by itself.
    expect(screen.getByTestId("durations").textContent).toBe("null")
    expect(extractOnPath).not.toHaveBeenCalled()
  })

  it("reports a listed archive before the Installation that owns it, which sits inside as well", async () => {
    const { extractOnPath } = await confirmRestoreOfA(aWith({ ...archiveOwner, path: "/games/a/b", backups: [{ id: "b1", date: 1, path: "/games/a/b/Backups/b1.tar.gz" }] }))

    expect(await screen.findByText(/a listed backup of Install B/)).toBeTruthy()
    expect(screen.queryByText(/another Installation, /)).toBeNull()
    expect(extractOnPath).not.toHaveBeenCalled()
  })

  // A restore keeps the records and wipes the folder, so unlike a delete it counts the Installation's own archives.
  it("still refuses to restore while an archive of the Installation's own sits inside", async () => {
    const own = { backups: [{ id: "backup-1", date: 1, path: "/games/a/Backups/Installations/a/a1.tar.gz" }] }
    const { extractOnPath } = await confirmRestoreOfA({}, own)

    expect(await screen.findByText(/a listed backup of Install A, so restoring would erase it \(listed archives in this folder: 1\)/)).toBeTruthy()
    expect(extractOnPath).not.toHaveBeenCalled()
  })

  it("extracts the backup archive over the Installation once the restore is confirmed", async () => {
    const user = userEvent.setup()
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        movePath: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        extractOnPath,
        changePerms: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")

    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(extractOnPath).toHaveBeenCalledTimes(1))
    expect(extractOnPath.mock.calls[0]?.[1]).toBe("/backups/a/backup-1.zip")

    // The confirm dialog closes as part of the same click.
    await waitFor(() => expect(screen.queryByText("Are you sure you want to restore this Backup?")).toBeNull())
  })

  it("reserves the Installation in the main process for the restore and gives it back afterwards", async () => {
    const user = userEvent.setup()
    const acquireLease = vi.fn<BridgeAPI["installationActivity"]["acquireLease"]>(async () => ({ ok: true }))
    const releaseLease = vi.fn<BridgeAPI["installationActivity"]["releaseLease"]>(async () => undefined)
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      installationActivity: { acquireLease, releaseLease },
      pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")
    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(releaseLease).toHaveBeenCalledTimes(1))
    expect(acquireLease).toHaveBeenCalledTimes(1)
    expect(acquireLease.mock.calls[0]?.[0]).toBe("install-a")
    expect(releaseLease.mock.calls[0]?.[0]).toBe(acquireLease.mock.calls[0]?.[1])
    expect(extractOnPath).toHaveBeenCalledTimes(1)
  })

  it("does not extract anything when the main process refuses the reservation", async () => {
    const user = userEvent.setup()
    const acquireLease = vi.fn<BridgeAPI["installationActivity"]["acquireLease"]>(async () => ({ ok: false, reason: "busy" }))
    const extractOnPath = vi.fn<BridgeAPI["pathsManager"]["extractOnPath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      installationActivity: { acquireLease },
      pathsManager: { checkPathExists: vi.fn(async () => true), movePath: vi.fn(async () => true), deletePath: vi.fn(async () => true), extractOnPath, changePerms: vi.fn(async () => true) }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Restore Backup"))
    await screen.findByText("Are you sure you want to restore this Backup?")
    await user.click(screen.getByTitle("Restore"))

    await waitFor(() => expect(acquireLease).toHaveBeenCalledTimes(1))
    expect(extractOnPath).not.toHaveBeenCalled()
  })

  it("deletes the backup archive after the delete confirmation", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)

    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    expect(deletePath.mock.calls[0]?.[0]).toBe("/backups/a/backup-1.zip")
    await waitFor(() => expect(screen.queryByTitle("Delete")).toBeNull())
  })

  it("disables the row trash button while a deletion is in flight", async () => {
    const user = userEvent.setup()
    let resolveDelete: (result: boolean) => void = () => {}
    const deletePath = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve
        })
    )
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    // Acquire the row's trash button. Before deletion it must be enabled.
    const trashButton = await screen.findByTitle("Delete")
    expect(trashButton.hasAttribute("disabled")).toBe(false)

    // Start the first deletion through the confirm dialog.
    await user.click(trashButton)
    await screen.findByText("Are you sure you want to delete this Backup?")
    const confirmButtons = screen.getAllByTitle("Delete")
    await user.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))

    // While the deletion is in flight, the row trash button must be disabled.
    // This assertion fails on dev (where _deleting is never set) and passes on
    // this branch (where configDispatch sets _deleting: true before the call).
    await waitFor(() => {
      const buttons = screen.getAllByRole("button")
      const disabledButtons = buttons.filter((btn) => btn.hasAttribute("disabled"))
      expect(disabledButtons.length).toBeGreaterThan(0)
    })

    resolveDelete(true)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
  })

  it("clears the deleting state when the archive deletion fails", async () => {
    const user = userEvent.setup()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallationWithBackup()] })) },
      pathsManager: {
        // The archive is still on disk, so the refusal is a real one: a path
        // the host cannot find counts as deleted (see backupDeletion.ts).
        checkPathExists: vi.fn(async () => true),
        deletePath,
        extractOnPath: vi.fn(async () => true)
      }
    })

    renderManageBackups("install-a")

    await user.click(await screen.findByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(1))
    await screen.findByTitle("Delete")

    await user.click(screen.getByTitle("Delete"))
    await screen.findByText("Are you sure you want to delete this Backup?")
    await user.click(screen.getAllByTitle("Delete")[1]!)
    await waitFor(() => expect(deletePath).toHaveBeenCalledTimes(2))
  })

  describe("an Installation whose folder holds another managed folder (#713)", () => {
    const installationMessage = (name: string, path: string): RegExp =>
      new RegExp(
        `holds another Installation, ${name} \\(${path.replaceAll("/", "\\/")}\\), so restoring would erase it\\. Move its folder out of this one by hand, remove its entry from the Installations page`
      )
    const configMessage = (path: string): RegExp => new RegExp(`holds ${path.replaceAll("/", "\\/")}, a folder set in Config, so restoring would erase it\\. Change that setting`)

    it.each([
      ["another Installation", aWith({ id: "install-b", name: "Install B", path: "/games/a/b" }), installationMessage("Install B", "/games/a/b")],
      ["the Backups folder", { installations: [anInstallationWithBackup()], backupsFolder: "/games/a/Backups" }, configMessage("/games/a/Backups")],
      ["the Installations folder", { installations: [anInstallationWithBackup()], defaultInstallationsFolder: "/games/a/Installations" }, configMessage("/games/a/Installations")],
      ["the VS Versions folder", { installations: [anInstallationWithBackup()], defaultVersionsFolder: "/games/a/Versions" }, configMessage("/games/a/Versions")]
    ])("says which folder to move when it holds %s, before extracting anything", async (_name, config, message) => {
      const { extractOnPath } = await confirmRestoreOfA(config as Partial<ConfigType>)

      expect(await screen.findByText(message)).toBeTruthy()
      expect(extractOnPath).not.toHaveBeenCalled()
    })
  })
})
