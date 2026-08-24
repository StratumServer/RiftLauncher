/**
 * The up/down controls on the Installations list (issue #203), and the
 * main-menu picker showing that same order rather than its mirror (issue #214).
 *
 * The list renders `installations` in array order with nothing sorting it, so
 * these tests read the order straight off the rendered rows and off the config
 * handed to saveConfig.
 *
 * NormalButton (src/renderer/src/components/ui/Buttons.tsx) blanks the `title`
 * of a disabled button, so a button findable by title is by construction an
 * enabled one. The boundary assertions below lean on that on purpose, and the
 * `disabled` attribute is checked directly on the row as well.
 */
import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
import InstallationsDropdownMenu from "@renderer/features/installations/components/InstallationsDropdownMenu"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
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

/** Names of the Installations as they currently read down the list, top first (getAllByText returns document order). */
function renderedOrder(): string[] {
  return screen.getAllByText(/^Install [A-Z]$/).map((name) => name.textContent ?? "")
}

function renderList(installations: InstallationType[]): ReturnType<typeof installMockWindowApi> {
  const api = installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations })) } })

  renderWithProviders(
    <TaskProvider>
      <ListInstallations />
    </TaskProvider>,
    { route: "/installations" }
  )

  return api
}

describe("ListInstallations reordering", () => {
  it("moves the second Installation to the top and persists the new order", async () => {
    const user = userEvent.setup()
    const api = renderList([anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" })])

    await screen.findByText("Install B")
    expect(renderedOrder()).toEqual(["Install A", "Install B"])

    // Only the second row has an enabled "up": the first row's is disabled.
    const moveUpButtons = screen.getAllByTitle("Move Installation up")
    expect(moveUpButtons).toHaveLength(1)
    await user.click(moveUpButtons[0]!)

    await waitFor(() => expect(renderedOrder()).toEqual(["Install B", "Install A"]))

    await waitFor(() => {
      const savedConfig = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0]
      expect(savedConfig?.installations.map((i) => i.id)).toEqual(["install-b", "install-a"])
    })
  })

  it("moves the first Installation down, the mirror of moving the second one up", async () => {
    const user = userEvent.setup()
    renderList([anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" })])

    await screen.findByText("Install B")

    const moveDownButtons = screen.getAllByTitle("Move Installation down")
    expect(moveDownButtons).toHaveLength(1)
    await user.click(moveDownButtons[0]!)

    await waitFor(() => expect(renderedOrder()).toEqual(["Install B", "Install A"]))
  })

  it("disables up on the first row and down on the last, rather than wrapping around", async () => {
    renderList([anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" }), anInstallation({ id: "install-c", name: "Install C", path: "/games/c" })])

    await screen.findByText("Install C")

    // Three rows: up is live on the last two, down on the first two.
    expect(screen.getAllByTitle("Move Installation up")).toHaveLength(2)
    expect(screen.getAllByTitle("Move Installation down")).toHaveLength(2)

    // getAllByRole("listitem")[0] is the "Add a new Installation" row, so the
    // Installation rows start at index 1.
    const rows = screen.getAllByRole("listitem").slice(1)
    const buttonsOf = (row: HTMLElement): HTMLButtonElement[] => within(row).getAllByRole("button")

    expect(buttonsOf(rows[0]!)[0]!.hasAttribute("disabled")).toBe(true)
    expect(buttonsOf(rows[0]!)[1]!.hasAttribute("disabled")).toBe(false)
    expect(buttonsOf(rows[2]!)[0]!.hasAttribute("disabled")).toBe(false)
    expect(buttonsOf(rows[2]!)[1]!.hasAttribute("disabled")).toBe(true)
  })
})

describe("main menu Installations picker", () => {
  it("lists the Installations in the order the config holds, so both screens agree", async () => {
    const user = userEvent.setup()
    const installations = [anInstallation(), anInstallation({ id: "install-b", name: "Install B", path: "/games/b" }), anInstallation({ id: "install-c", name: "Install C", path: "/games/c" })]

    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations, lastUsedInstallation: "install-a" })) } })
    renderWithProviders(<InstallationsDropdownMenu />)

    // The only button here is the picker's own, showing the selected Installation.
    await user.click(await screen.findByRole("button"))

    const options = await screen.findAllByRole("option")
    expect(options.map((option) => within(option).getByText(/^Install [A-Z]$/).textContent)).toEqual(["Install A", "Install B", "Install C"])
  })
})
