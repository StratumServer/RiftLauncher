import type { ReactElement, ReactNode } from "react"
import { act, render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import type { NotificationType } from "@renderer/contexts/NotificationsContext"
import { changeLanguage } from "@renderer/i18n"

import { installMockWindowApi } from "./helpers/windowApi"

/**
 * The renderer half of #554: the recovery notice main leaves behind is pulled once on mount and
 * shown once. It lives in its own mount-only effect, apart from the updater listeners (which
 * re-subscribe whenever `t` changes), so switching language must not show it a second time.
 */
let liveNotifications: NotificationType[] = []

function NotificationsProbe(): null {
  liveNotifications = useNotificationsContext().notifications
  return null
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <NotificationsProvider>{children}</NotificationsProvider>
}

describe("config recovery notice (#554)", () => {
  it("shows the pulled notice once, naming the kept copy, and not again after a language change", async () => {
    const getConfigRecoveryNotice = vi.fn(async () => ({ restored: true, preserved: true, copyName: "config.unreadable-1727690000000.json" }) as ConfigRecoveryNotice)
    installMockWindowApi({ configManager: { getConfigRecoveryNotice } })

    render(<NotificationsProbe />, { wrapper })

    const matching = (): NotificationType[] => liveNotifications.filter((notification) => notification.body.includes("config.unreadable-1727690000000.json"))
    await waitFor(() => expect(matching()).toHaveLength(1))
    expect(matching()[0]?.type).toBe("warning")

    try {
      await act(async () => {
        expect(await changeLanguage("fr-FR")).toBe(true)
      })
      await act(async () => {
        expect(await changeLanguage("en-US")).toBe(true)
      })
    } finally {
      await changeLanguage("en-US")
    }

    expect(matching()).toHaveLength(1)
    expect(getConfigRecoveryNotice).toHaveBeenCalledTimes(1)
  })
})
