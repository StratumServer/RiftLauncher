import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("ManageMods without an installation", () => {
  it("does not leave Reload spinning when no installation exists", async () => {
    const user = userEvent.setup()
    const getInstalledMods = vi.fn(async () => ({ mods: [], errors: [] }))

    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig()) },
      modsManager: { getInstalledMods }
    })

    renderWithProviders(
      <Routes>
        <Route
          path="/installations/mods/:id"
          element={
            <TaskProvider>
              <ManageMods />
              <NotificationsOverlay />
            </TaskProvider>
          }
        />
      </Routes>,
      { route: "/installations/mods/missing" }
    )

    expect(await screen.findByText("Installation not found!", {}, { timeout: 3000 })).toBeTruthy()

    const reload = screen.getByTitle("Reload")
    expect(reload.querySelector(".animate-spin")).toBeNull()
    expect(getInstalledMods).not.toHaveBeenCalled()

    await user.click(reload)

    await waitFor(() => expect(screen.getByText("No Installation selected!")).toBeTruthy())
    expect(screen.getByTitle("Reload").querySelector(".animate-spin")).toBeNull()
    expect(getInstalledMods).not.toHaveBeenCalled()
  })
})
