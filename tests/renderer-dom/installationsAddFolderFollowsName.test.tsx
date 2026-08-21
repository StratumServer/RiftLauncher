import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AddInstallation from "@renderer/features/installations/pages/AddInstallation"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The data folder on the Add Installation page follows the name being typed
 * (issue #196), the same way AddVersion's folder follows the picked version.
 *
 * The window.api mock joins path parts with "/", so the expected folders below
 * read as posix paths whatever the host is.
 */
function renderAddInstallation(): void {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/base" })) }
  })

  renderWithProviders(<AddInstallation />, { route: "/installations/add" })
}

async function folderField(): Promise<HTMLInputElement> {
  return (await screen.findByPlaceholderText("Installation folder")) as HTMLInputElement
}

function nameField(): HTMLInputElement {
  return screen.getByPlaceholderText("My New Installation") as HTMLInputElement
}

describe("AddInstallation, data folder following the name", () => {
  it("appends the typed name to the configured installations folder", async () => {
    const user = userEvent.setup()
    renderAddInstallation()

    const folder = await folderField()
    await user.clear(nameField())
    await user.type(nameField(), "Stratum Server")

    await waitFor(() => expect(folder.value).toBe("/base/Stratum-Server"))
  })

  it("re-derives the folder when the name changes again", async () => {
    const user = userEvent.setup()
    renderAddInstallation()

    const folder = await folderField()
    await user.clear(nameField())
    await user.type(nameField(), "First Name")
    await waitFor(() => expect(folder.value).toBe("/base/First-Name"))

    await user.clear(nameField())
    await user.type(nameField(), "Second Name")

    await waitFor(() => expect(folder.value).toBe("/base/Second-Name"))
  })

  it("stops following the name once the folder is edited by hand", async () => {
    const user = userEvent.setup()
    renderAddInstallation()

    const folder = await folderField()
    await waitFor(() => expect(folder.value).toBe("/base/My-New-Installation"))

    await user.clear(folder)
    await user.type(folder, "/somewhere/else")

    await user.clear(nameField())
    await user.type(nameField(), "Renamed Later")

    // The name field really did change; the folder the user typed survived it.
    await waitFor(() => expect(nameField().value).toBe("Renamed Later"))
    expect(folder.value).toBe("/somewhere/else")
  })

  it("stops following the name once a folder is picked from the dialog", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ defaultInstallationsFolder: "/base" })) },
      utils: { selectFolderDialog: vi.fn(async () => ["/picked/folder"]) }
    })

    renderWithProviders(<AddInstallation />, { route: "/installations/add" })

    const folder = await folderField()
    await user.click(screen.getByTitle("Browse"))
    await waitFor(() => expect(folder.value).toBe("/picked/folder"))

    await user.clear(nameField())
    await user.type(nameField(), "Renamed Later")

    await waitFor(() => expect(nameField().value).toBe("Renamed Later"))
    expect(folder.value).toBe("/picked/folder")
  })

  it("replaces the characters a folder name cannot carry", async () => {
    const user = userEvent.setup()
    renderAddInstallation()

    const folder = await folderField()
    await user.clear(nameField())
    await user.type(nameField(), 'a/b\\c:d*e?f"g<h>i|j')

    await waitFor(() => expect(folder.value).toBe("/base/a-b-c-d-e-f-g-h-i-j"))
  })

  it("appends nothing at all when the name cleans down to nothing", async () => {
    const user = userEvent.setup()
    renderAddInstallation()

    const folder = await folderField()
    await user.clear(nameField())
    await user.type(nameField(), "***")

    // Not "/base/-", and not a leftover folder from the previous keystrokes either.
    await waitFor(() => expect(folder.value).toBe("/base"))
  })
})
