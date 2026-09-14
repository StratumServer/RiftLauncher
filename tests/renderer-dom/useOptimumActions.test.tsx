import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { ConfigProvider, useGameVersions } from "@renderer/features/config/contexts/ConfigContext"
import { useOptimumActions } from "@renderer/features/versions/hooks/useOptimumActions"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"

import "@renderer/i18n"

/**
 * The two actions, wired the way the pages wire them.
 *
 * The post-check is the thing worth holding here. What the row ends up saying
 * comes from the launcher's own probe of the folder, so a patch that reports
 * success on a folder the probe does not read as Optimum leaves the row alone
 * and tells the player, rather than writing a label nothing backs up.
 */

const MANIFEST: OptimumManifestInfo = {
  optimumVersion: "0.3.14",
  supportedGameVersions: ["1.22.7"],
  downloadUrl: "https://github.com/StratumServer/Optimum/releases/download/v0.3.14/Optimum-v0.3.14-linux-x64-overlay.tar.gz",
  downloadFolder: "/userdata/Cache/Optimum",
  archiveFileName: "Optimum-v0.3.14-linux-x64-overlay.tar.gz"
}

const TARGET = { id: "gv-1", path: "/versions/1.22.7", version: "1.22.7" }

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <MemoryRouter>
      <NotificationsProvider>
        <ConfigProvider>
          <TaskProvider>{children}</TaskProvider>
        </ConfigProvider>
        {/* The refusals this hook raises are toasts, so the thing that paints them has to be mounted for a test to read one. */}
        <NotificationsOverlay />
      </NotificationsProvider>
    </MemoryRouter>
  )
}

function mountWith(overrides: Parameters<typeof installMockWindowApi>[0] = {}): ReturnType<typeof renderHook<{ actions: ReturnType<typeof useOptimumActions>; versions: GameVersionType[] }, void>> {
  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "gv-1", version: "1.22.7", label: "1.22.7", path: "/versions/1.22.7" }] })) },
    ...overrides
  })

  return renderHook(() => ({ actions: useOptimumActions(), versions: useGameVersions() }), { wrapper })
}

describe("useOptimumActions", () => {
  it("downloads the published overlay, patches, and labels the row from the probe", async () => {
    const downloadOnPath = vi.fn(async () => "/userdata/Cache/Optimum/Optimum-v0.3.14-linux-x64-overlay.tar.gz")
    const applyOverlay = vi.fn(async () => ({ ok: true }) as OptimumPatchResult)
    const { result } = mountWith({
      pathsManager: { downloadOnPath },
      optimumManager: { applyOverlay },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7", variant: { name: "Optimum" as const, version: "0.3.14" } })) }
    })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    let applied = false
    await act(async () => {
      applied = await result.current.actions.applyOptimum(TARGET, MANIFEST)
    })

    expect(applied).toBe(true)
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), MANIFEST.downloadUrl, MANIFEST.downloadFolder, MANIFEST.archiveFileName)
    expect(applyOverlay).toHaveBeenCalledWith(expect.any(String), "/versions/1.22.7", "1.22.7")
    expect(result.current.versions[0]).toMatchObject({ label: "1.22.7 Optimum 0.3.14", variant: { name: "Optimum", version: "0.3.14" } })
  })

  it("leaves the row alone when the folder does not read as Optimum afterwards", async () => {
    const { result } = mountWith({
      pathsManager: { downloadOnPath: vi.fn(async () => "/userdata/Cache/Optimum/overlay.tar.gz") },
      optimumManager: { applyOverlay: vi.fn(async () => ({ ok: true }) as OptimumPatchResult) },
      gameManager: { lookForAGameVersion: vi.fn(async () => ({ exists: true as const, installedGameVersion: "1.22.7" })) }
    })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    let applied = true
    await act(async () => {
      applied = await result.current.actions.applyOptimum(TARGET, MANIFEST)
    })

    expect(applied).toBe(false)
    expect(result.current.versions[0]).toMatchObject({ label: "1.22.7" })
    expect(result.current.versions[0]?.variant).toBeUndefined()
    expect(await screen.findByText("Optimum ran but the VS Version doesn't hold what it reported writing.")).toBeTruthy()
  })

  it("stops at the download and says so, without touching the build", async () => {
    const applyOverlay = vi.fn(async () => ({ ok: true }) as OptimumPatchResult)
    const { result } = mountWith({
      pathsManager: { downloadOnPath: vi.fn(async () => Promise.reject(new Error("Download failed"))) },
      optimumManager: { applyOverlay }
    })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    await act(async () => {
      await result.current.actions.applyOptimum(TARGET, MANIFEST)
    })

    expect(applyOverlay).not.toHaveBeenCalled()
    expect(await screen.findByText("Optimum couldn't be downloaded. The VS Version is installed, so you can add Optimum to it later.")).toBeTruthy()
  })

  for (const [reason, sentence] of [
    ["runtime-missing", "Optimum needs the .NET 10 runtime, which isn't installed on this computer."],
    ["overlay-unverified", "What was downloaded doesn't match what Optimum published, so nothing was run."],
    ["patch-conflict", "Optimum couldn't patch this VS Version."],
    ["timed-out", "Applying Optimum stopped before it finished. The VS Version was left as it was."],
    ["unsupported-version", "Optimum has no build for this version yet."]
  ] as const) {
    it(`turns ${reason} into its own line`, async () => {
      const { result } = mountWith({
        pathsManager: { downloadOnPath: vi.fn(async () => "/userdata/Cache/Optimum/overlay.tar.gz") },
        optimumManager: { applyOverlay: vi.fn(async () => ({ ok: false, reason }) as OptimumPatchResult) }
      })
      await waitFor(() => expect(result.current.versions).toHaveLength(1))

      await act(async () => {
        await result.current.actions.applyOptimum(TARGET, MANIFEST)
      })

      expect(await screen.findByText(sentence)).toBeTruthy()
      expect(result.current.versions[0]?.variant).toBeUndefined()
    })
  }

  it("says the build carries no backup rather than pretending a restore happened", async () => {
    const { result } = mountWith({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({ gameVersions: [{ id: "gv-1", version: "1.22.7", label: "1.22.7 Optimum 0.3.14", path: "/versions/1.22.7", variant: { name: "Optimum", version: "0.3.14" } }] })
        )
      },
      optimumManager: { restoreVanilla: vi.fn(async () => ({ ok: false, reason: "backup-missing" }) as OptimumPatchResult) }
    })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    let restored = true
    await act(async () => {
      restored = await result.current.actions.restoreVanilla(TARGET)
    })

    expect(restored).toBe(false)
    expect(result.current.versions[0]).toMatchObject({ label: "1.22.7 Optimum 0.3.14" })
    expect(await screen.findByText("This VS Version carries no copy of its original files, so they can't be put back.")).toBeTruthy()
  })
})
