import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { renderWithProviders } from "./render"

/**
 * Mounts ManageMods at its real route, wrapped the way every ManageMods render harness in this
 * directory wraps it: TaskProvider so the page's mod actions have somewhere to run,
 * NotificationsOverlay so a toast or the Activity Center banner a test asserts on is actually in
 * the tree. Shared across manageMods(Health|Details|ServerMods|UnreadableArchive|MissingInstallation)
 * .test.tsx, which otherwise repeated this same 13-line block. Each file's own fixture defaults
 * (its installMockWindowApi call) and return type stay local: they differ enough between files
 * (a scan, a ModDB response, a bridge mock to hand back) that folding them in here would hide more
 * than it shares.
 */
export function mountManageMods(route = "/installations/mods/install-a"): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
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
    { route }
  )
}
