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
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [
              { id: "vanilla", version: "1.22.7", path: "/versions/vanilla" },
              { id: "optimum", version: "1.22.7", path: "/versions/optimum" }
            ]
          })
        )
      }
    })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onInstalled?.()
      return { ok: true, path: "/versions/1.22.7" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(2))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(vi.mocked(installGameVersion).mock.calls[0]?.[1].installedVersions).toEqual([
      { version: "1.22.7", path: "/versions/vanilla" },
      { version: "1.22.7", path: "/versions/optimum" }
    ])
    expect(result.current.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "vanilla" }),
        expect.objectContaining({ id: "optimum" }),
        expect.objectContaining({ version: "1.22.7", path: "/versions/1.22.7", _installing: undefined })
      ])
    )
    expect(result.current.versions).toHaveLength(3)
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

  // The marker that survives a restart (#710). The run below stops after the row is registered, the
  // way a crash or a power cut does, so what the last save holds is what the next start reads.
  it("saves the new row as an unfinished install", async () => {
    const api = installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()) } })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      return { ok: false, reason: "download-failed" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(0))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(result.current.versions).toEqual([expect.objectContaining({ version: "1.22.7", _installing: true, incomplete: true })])
    const saved = vi.mocked(api.configManager.saveConfig).mock.calls.at(-1)?.[0].gameVersions
    expect(saved).toEqual([expect.objectContaining({ version: "1.22.7", incomplete: true })])
  })

  it("clears the unfinished mark once the install finishes", async () => {
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig()) } })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onInstalled?.()
      return { ok: true, path: "/versions/1.22.7" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(0))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(result.current.versions).toHaveLength(1)
    expect(result.current.versions[0]?.incomplete).toBeUndefined()
    expect(result.current.versions[0]?._installing).toBeUndefined()
  })

  it("installs again into the folder of an interrupted install, on the same row", async () => {
    installMockWindowApi({
      configManager: {
        getConfig: vi.fn(async () =>
          createMockConfig({
            gameVersions: [
              { id: "cut-off", label: "1.22.7", version: "1.22.7", path: "/versions/1.22.7", incomplete: true },
              { id: "other", label: "1.22.6", version: "1.22.6", path: "/versions/1.22.6" }
            ]
          })
        )
      }
    })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onInstalled?.()
      return { ok: true, path: "/versions/1.22.7" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(2))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    const input = vi.mocked(installGameVersion).mock.calls.at(-1)?.[1]
    expect(input?.installedVersions).toEqual([{ version: "1.22.6", path: "/versions/1.22.6" }])
    expect(input?.foldersInUse).not.toContain("/versions/1.22.7")
    expect(result.current.versions).toHaveLength(2)
    expect(result.current.versions.find((gv) => gv.id === "cut-off")?.incomplete).toBeUndefined()
  })

  it("keeps an interrupted install on the list when installing it again fails", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "cut-off", label: "1.22.7", version: "1.22.7", path: "/versions/1.22.7", incomplete: true }] })) }
    })
    vi.mocked(installGameVersion).mockImplementation(async (_ports, _input, events) => {
      events?.onRegistered?.()
      events?.onDiscarded?.("download-failed")
      return { ok: false, reason: "download-failed" }
    })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    expect(result.current.versions).toEqual([expect.objectContaining({ id: "cut-off", incomplete: true, _installing: undefined })])
  })

  it("does not take a finished build for an interrupted one", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ gameVersions: [{ id: "done", label: "1.22.7", version: "1.22.7", path: "/versions/1.22.7" }] })) }
    })
    vi.mocked(installGameVersion).mockResolvedValue({ ok: false, reason: "version-already-installed" })

    const { result } = renderHook(() => ({ install: useInstallVersion(), versions: useGameVersions() }), { wrapper })
    await waitFor(() => expect(result.current.versions).toHaveLength(1))

    await act(async () => {
      await result.current.install(VERSION, "/versions/1.22.7")
    })

    const input = vi.mocked(installGameVersion).mock.calls.at(-1)?.[1]
    expect(input?.installedVersions).toEqual([{ version: "1.22.7", path: "/versions/1.22.7" }])
    expect(input?.foldersInUse).toContain("/versions/1.22.7")
  })
})
