import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import { installGameVersion } from "@domain/versions/install"
import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { ConfigProvider, useGameVersions } from "@renderer/features/config/contexts/ConfigContext"
import { useInstallVersion } from "@renderer/features/versions/hooks/useInstallVersion"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"

import "@renderer/i18n"

vi.mock("@domain/versions/install", () => ({ installGameVersion: vi.fn() }))

const VERSION = {
  version: "1.22.7",
  type: "stable",
  windows: { url: "https://example.test/win.exe", fileName: "vs_client_win-x64_1.22.7.exe" },
  linux: { url: "https://example.test/linux.tar.gz", fileName: "vs_client_linux-x64_1.22.7.tar.gz" },
  mac: { url: "https://example.test/mac.tar.gz", fileName: "vs_client_mac-x64_1.22.7.tar.gz" }
} as unknown as DownloadableGameVersionTypeType

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <MemoryRouter>
      <NotificationsProvider>
        <ConfigProvider>
          <TaskProvider>{children}</TaskProvider>
        </ConfigProvider>
      </NotificationsProvider>
    </MemoryRouter>
  )
}

describe("useInstallVersion", () => {
  it("registers and clears the exact generated build id on success", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "existing", version: "1.20.4", path: "/versions/existing" }] }))
      }
    })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onInstalled?.()
      return { ok: true, path: "/versions/1.22.7" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(result.current.versions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "existing" }), expect.objectContaining({ version: "1.22.7", path: "/versions/1.22.7", _installing: undefined })])
    )
    expect(result.current.versions).toHaveLength(2)
  })

  it("removes only the exact optimistically registered build when installation is discarded", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()) } })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onDiscarded?.("download-failed")
      return { ok: false, reason: "download-failed" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(0))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(result.current.versions).toHaveLength(0)
  })
})
