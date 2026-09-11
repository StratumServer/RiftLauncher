import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, screen, waitFor } from "@testing-library/react"

import { useInstalledModActions } from "@renderer/features/mods/hooks/useInstalledModActions"
import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { ConfigProvider } from "@renderer/features/config/contexts/ConfigContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"

import "@renderer/i18n"

const ENABLED_PATH = "/games/a/Mods/alpha-1.0.0.zip"
const DISABLED_PATH = "/games/a/Mods/alpha-1.0.0.zip.disabled"

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

/** Two copies of one modid, which is the case a guard keyed on anything but the path gets wrong. */
const enabledCopy: InstalledModType = { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: ENABLED_PATH, enabled: true }
const disabledCopy: InstalledModType = { name: "Alpha Mod", modid: "alpha", version: "1.0.0", path: DISABLED_PATH, enabled: false }

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <ConfigProvider>
        {children}
        <NotificationsOverlay />
      </ConfigProvider>
    </NotificationsProvider>
  )
}

function renderActions(
  installation: InstallationType | undefined,
  refresh: () => Promise<void>,
  overrides: WindowApiOverrides = {}
): ReturnType<typeof renderHook<ReturnType<typeof useInstalledModActions>, unknown>> {
  installMockWindowApi(overrides)
  return renderHook(() => useInstalledModActions(installation, refresh), { wrapper })
}

/** Every line the renderer asked the host to log, level and text alike. */
function loggedText(): string {
  return vi
    .mocked(window.api.utils.logMessage)
    .mock.calls.map((call) => call.join(" "))
    .join("\n")
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe("useInstalledModActions: what reaches the log", () => {
  it("logs no path and no Mod name when a rename is refused, only the action and the refusal", async () => {
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async () => ({ ok: false, reason: "name-taken" }))
    const { result } = renderActions(anInstallation(), async () => {}, { modsManager: { setModEnabled } })

    await act(() => result.current.toggleEnabled(enabledCopy))

    expect(await screen.findByText(/There is already another file where Alpha Mod would have been renamed/)).toBeTruthy()
    const logged = loggedText()
    expect(logged).toContain("Could not turn a Mod off: name-taken.")
    expect(logged).not.toContain("/games/a")
    expect(logged).not.toContain("Alpha Mod")
  })

  it("logs no path and no error text when the host fails a delete", async () => {
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => {
      throw new Error(`EBUSY: resource busy or locked, unlink '${ENABLED_PATH}'`)
    })
    const { result } = renderActions(anInstallation(), async () => {}, { pathsManager: { deletePath } })

    act(() => result.current.requestDelete(enabledCopy))
    await act(() => result.current.confirmDelete())

    expect(await screen.findByText("That Mod couldn't be deleted. The log has the details.")).toBeTruthy()
    expect(result.current.modToDelete).toBeNull()
    const logged = loggedText()
    expect(logged).toContain("Could not delete a Mod.")
    expect(logged).not.toContain("/games/a")
    expect(logged).not.toContain("EBUSY")
  })
})

describe("useInstalledModActions: a folder something else is writing", () => {
  const HOLDERS = [{ _backuping: true }, { _restoringBackup: true }, { _updatingMods: true }]

  it.each(HOLDERS)("refuses to rename while %o", async (holder) => {
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => ({ ok: true, path }))
    const { result } = renderActions(anInstallation(holder), async () => {}, { modsManager: { setModEnabled } })

    await act(() => result.current.toggleEnabled(enabledCopy))

    expect(await screen.findByText("You can't enable or disable a Mod while it's in use.")).toBeTruthy()
    expect(setModEnabled).not.toHaveBeenCalled()
    expect(result.current.busyPaths).toEqual([])
  })

  it.each(HOLDERS)("refuses to delete while %o, and leaves the confirmation open", async (holder) => {
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const { result } = renderActions(anInstallation(holder), async () => {}, { pathsManager: { deletePath } })

    act(() => result.current.requestDelete(enabledCopy))
    await act(() => result.current.confirmDelete())

    expect(await screen.findByText("You can't delete a Mod while it's in use.")).toBeTruthy()
    expect(deletePath).not.toHaveBeenCalled()
    expect(result.current.modToDelete).toBe(enabledCopy)
  })

  it("refuses without an Installation and touches nothing", async () => {
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path: string) => ({ ok: true, path }))
    const { result } = renderActions(undefined, async () => {}, { modsManager: { setModEnabled } })

    await act(() => result.current.toggleEnabled(enabledCopy))

    expect(await screen.findByText("Installation not found.")).toBeTruthy()
    expect(setModEnabled).not.toHaveBeenCalled()
  })
})

describe("useInstalledModActions: the busy paths", () => {
  it("holds a renamed path busy until the rescan lands, and only that copy of the modid", async () => {
    const rename = deferred<SetModEnabledResult>()
    const rescan = deferred<void>()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(() => rename.promise)
    const refresh = vi.fn(() => rescan.promise)
    const { result } = renderActions(anInstallation(), refresh, { modsManager: { setModEnabled } })

    let toggled!: Promise<void>
    act(() => {
      toggled = result.current.toggleEnabled(enabledCopy)
    })

    expect(result.current.busyPaths).toEqual([ENABLED_PATH])
    expect(result.current.isBusy(ENABLED_PATH)).toBe(true)
    expect(result.current.isBusy(DISABLED_PATH)).toBe(false)

    // The other file of the same modid is its own archive, so it is not held by this call.
    act(() => {
      void result.current.toggleEnabled(disabledCopy)
    })
    expect(setModEnabled).toHaveBeenCalledTimes(2)
    expect(setModEnabled).toHaveBeenLastCalledWith(DISABLED_PATH, true)

    await act(async () => rename.resolve({ ok: true, path: `${ENABLED_PATH}.disabled` }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(result.current.isBusy(ENABLED_PATH)).toBe(true)

    await act(async () => {
      rescan.resolve()
      await toggled
    })
    expect(result.current.isBusy(ENABLED_PATH)).toBe(false)
  })

  it("drops a second rename of one path sent before the first has landed", async () => {
    const rename = deferred<SetModEnabledResult>()
    const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(() => rename.promise)
    const { result } = renderActions(anInstallation(), async () => {}, { modsManager: { setModEnabled } })

    act(() => {
      void result.current.toggleEnabled(enabledCopy)
      void result.current.toggleEnabled(enabledCopy)
    })

    expect(setModEnabled).toHaveBeenCalledTimes(1)
    await act(async () => rename.resolve({ ok: true, path: `${ENABLED_PATH}.disabled` }))
  })

  it("does not delete a path whose rename is still in flight", async () => {
    const rename = deferred<SetModEnabledResult>()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const { result } = renderActions(anInstallation(), async () => {}, { modsManager: { setModEnabled: vi.fn(() => rename.promise) }, pathsManager: { deletePath } })

    act(() => {
      void result.current.toggleEnabled(enabledCopy)
    })
    act(() => result.current.requestDelete(enabledCopy))
    await act(() => result.current.confirmDelete())

    expect(deletePath).not.toHaveBeenCalled()
    await act(async () => rename.resolve({ ok: true, path: `${ENABLED_PATH}.disabled` }))
  })

  it("closes the confirmation once the file is gone but holds the path until the rescan lands", async () => {
    const rescan = deferred<void>()
    const deletePath = vi.fn<BridgeAPI["pathsManager"]["deletePath"]>(async () => true)
    const { result } = renderActions(anInstallation(), () => rescan.promise, { pathsManager: { deletePath } })

    act(() => result.current.requestDelete(disabledCopy))
    let confirmed!: Promise<void>
    act(() => {
      confirmed = result.current.confirmDelete()
    })

    // The real file name, `.disabled` and all, is the one deleted.
    await waitFor(() => expect(deletePath).toHaveBeenCalledWith(DISABLED_PATH))
    await waitFor(() => expect(result.current.modToDelete).toBeNull())
    expect(result.current.isBusy(DISABLED_PATH)).toBe(true)

    await act(async () => {
      rescan.resolve()
      await confirmed
    })
    expect(result.current.isBusy(DISABLED_PATH)).toBe(false)
  })
})

describe("useInstalledModActions: identity", () => {
  it("hands back the same callbacks across renders, so a memoized row or card is not re-rendered for them", async () => {
    const rename = deferred<SetModEnabledResult>()
    installMockWindowApi({ modsManager: { setModEnabled: vi.fn(() => rename.promise) } })
    const { result, rerender } = renderHook(({ installation, refresh }: { installation: InstallationType; refresh: () => Promise<void> }) => useInstalledModActions(installation, refresh), {
      wrapper,
      initialProps: { installation: anInstallation(), refresh: async (): Promise<void> => {} }
    })
    const first = result.current

    // A new Installation object and a new refresh, the way a page re-renders after any config edit,
    // then a path going busy and a delete being asked for: none of it may re-identify a callback.
    rerender({ installation: anInstallation(), refresh: async (): Promise<void> => {} })
    act(() => {
      void result.current.toggleEnabled(enabledCopy)
    })
    act(() => result.current.requestDelete(enabledCopy))
    expect(result.current.busyPaths).toEqual([ENABLED_PATH])
    expect(result.current.modToDelete).toBe(enabledCopy)

    expect(result.current.toggleEnabled).toBe(first.toggleEnabled)
    expect(result.current.toggleSuspended).toBe(first.toggleSuspended)
    expect(result.current.requestDelete).toBe(first.requestDelete)
    expect(result.current.cancelDelete).toBe(first.cancelDelete)
    expect(result.current.confirmDelete).toBe(first.confirmDelete)
    await act(async () => rename.resolve({ ok: true, path: `${ENABLED_PATH}.disabled` }))
  })
})
