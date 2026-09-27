import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { mountManageMods } from "./helpers/mountManageMods"

describe("ManageMods without an installation", () => {
  it("does not leave Reload spinning when no installation exists", async () => {
    const user = userEvent.setup()
    const getInstalledMods = vi.fn(async () => ({ mods: [], errors: [] }))

    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig()) },
      modsManager: { getInstalledMods }
    })

    mountManageMods("/installations/mods/missing")

    expect(await screen.findByText("Installation not found.", {}, { timeout: 3000 })).toBeTruthy()

    const reload = screen.getByTitle("Reload")
    expect(reload.querySelector(".animate-spin")).toBeNull()
    expect(getInstalledMods).not.toHaveBeenCalled()

    await user.click(reload)

    // Both attempts raise the same message, which folds into one banner wearing a count.
    await waitFor(() => expect(screen.getByText("No Installation selected.")).toBeTruthy())
    expect(screen.getByText("x2")).toBeTruthy()
    expect(screen.getByTitle("Reload").querySelector(".animate-spin")).toBeNull()
    expect(getInstalledMods).not.toHaveBeenCalled()
  })
})
