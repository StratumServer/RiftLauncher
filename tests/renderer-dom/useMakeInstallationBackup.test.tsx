import type { ReactElement, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { ConfigProvider } from "@renderer/features/config/contexts/ConfigContext"
import { BACKUP_NO_INSTALLATION, useMakeInstallationBackup } from "@renderer/features/installations/hooks/useMakeInstallationBackup"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"

// Registers the i18n instance useTranslation() reads inside the hook, the same
// way renderWithProviders (./helpers/render) does for full-page renders.
import "@renderer/i18n"

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return (
    <NotificationsProvider>
      <ConfigProvider>
        <TaskProvider>{children}</TaskProvider>
      </ConfigProvider>
    </NotificationsProvider>
  )
}

describe("useMakeInstallationBackup outcomes", () => {
  it("hard-stops on an installation it cannot find, with a reason no prompt should offer to skip", async () => {
    // The hard-stop arm is unreachable from MainMenu, which passes the id off an
    // already-resolved installation, but it still has to be a hard stop: turning
    // it into { ok: true } would launch a game whose installation the launcher
    // just failed to find (#338 review, blocker 5).
    installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [] })) } })

    const { result } = renderHook(() => useMakeInstallationBackup(), { wrapper })
    const outcome = await result.current("does-not-exist")

    expect(outcome).toEqual({ ok: false, reason: BACKUP_NO_INSTALLATION })
  })
})
