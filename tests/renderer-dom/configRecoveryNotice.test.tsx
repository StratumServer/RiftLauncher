import type { ReactElement, ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import type { i18n as I18n } from "i18next"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { NotificationsProvider, useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import type { NotificationType } from "@renderer/contexts/NotificationsContext"
import { changeLanguage } from "@renderer/i18n"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"

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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveIt) => {
    resolve = resolveIt
  })
  return { promise, resolve }
}

/**
 * #619: the notice is turned into a sentence once, the moment it arrives, and the record keeps
 * that sentence. The renderer starts in en-US and reaches the player's stored language a moment
 * after its first render, so the language of the sentence was whichever of the two had finished
 * first. Each case here holds one of them back and lets the other go first, in the real App.
 *
 * Every case loads its own copy of the app. The provider keeps the pulled notice in a promise for
 * the life of the page, so that React's second mount does not ask twice, and a second case in the
 * same module would find it already settled.
 */
describe("config recovery notice language (#619)", () => {
  const copyName = "config.unreadable-1727690000000.json"

  beforeEach(() => {
    vi.resetModules()
  })

  /**
   * Boots the real App with `stored` saved as the language. The notice is handed over by `arrive`,
   * and the stored language is loaded straight away but only applied once `land` lets it through.
   */
  async function boot(stored: string): Promise<{ i18n: I18n; arrive: () => Promise<void>; land: () => Promise<void> }> {
    window.localStorage.setItem("lang", stored)
    onTestFinished(() => window.localStorage.removeItem("lang"))

    const notice = deferred<ConfigRecoveryNotice>()
    installMockWindowApi({
      configManager: {
        // "never" keeps the ModDB visibility prompt shut: it is a modal, and nothing here is about it.
        getConfig: vi.fn(async () => createMockConfig({ moddbVisibility: { policy: "never", answeredVersion: "", countedVersions: [] } })),
        getConfigRecoveryNotice: vi.fn(() => notice.promise)
      }
    })

    const { default: i18n } = await import("@renderer/i18n")
    const { default: App } = await import("@renderer/App")

    const languageGate = deferred()
    const applyLanguage = i18n.changeLanguage.bind(i18n)
    const changing = vi.spyOn(i18n, "changeLanguage").mockImplementation(async (...args) => {
      await languageGate.promise
      return applyLanguage(...args)
    })
    onTestFinished(async () => {
      languageGate.resolve()
      changing.mockRestore()
      await i18n.changeLanguage("en-US")
    })

    render(<App />)

    return {
      i18n,
      // Returns once the provider has had its turn with the notice.
      arrive: () =>
        act(async () => {
          notice.resolve({ kind: "unreadable", restored: true, preserved: true, copyName })
          await notice.promise
        }),
      land: async () => {
        await act(async () => languageGate.resolve())
        await waitFor(() => expect(i18n.language).toBe(stored))
      }
    }
  }

  /** The one banner the notice made, which has to read exactly as `language`'s locale words it. */
  async function expectBannerIn(i18n: I18n, language: string): Promise<void> {
    const banner = await screen.findByText(copyName, { exact: false })
    expect(banner.textContent).toBe(i18n.getFixedT(language)("notifications.body.configUnreadableRestored", { copyName }))
  }

  it("shows the notice in French when it arrives before the stored language is applied", async () => {
    const app = await boot("fr-FR")

    await app.arrive()
    await app.land()

    await expectBannerIn(app.i18n, "fr-FR")
  })

  it("shows the notice in French when the stored language was applied before it arrived", async () => {
    const app = await boot("fr-FR")

    await app.land()
    await app.arrive()

    await expectBannerIn(app.i18n, "fr-FR")
  })

  it("still shows the notice, in English, when the stored language cannot be loaded", async () => {
    const app = await boot("xx-XX")

    await app.arrive()

    await expectBannerIn(app.i18n, "en-US")
  })
})
