import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import GlobalActionsWrapper from "@renderer/components/layout/GlobalActionsWrapper"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Pins src/renderer/src/features/launch/hooks/useNotifyOnPreventedAppClose.ts, mounted the
 * way App.tsx actually mounts it: through GlobalActionsWrapper, for the app's lifetime, not
 * tied to any page.
 */
describe("useNotifyOnPreventedAppClose", () => {
  it("subscribes once on mount and toasts a warning each time the bridge reports a prevented close", async () => {
    let firePreventedClose: (() => void) | undefined
    const unsubscribe = vi.fn()
    const onPreventedAppClose = vi.fn((callback: () => void) => {
      firePreventedClose = callback
      return unsubscribe
    })

    installMockWindowApi({ utils: { onPreventedAppClose } })

    renderWithProviders(
      <GlobalActionsWrapper>
        <NotificationsOverlay />
      </GlobalActionsWrapper>
    )

    expect(onPreventedAppClose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()

    firePreventedClose?.()

    await screen.findByText("You can't close RiftLauncher either because you're playing Vintage Story or because there's a task in progress!")
  })

  it("unsubscribes from the bridge when it unmounts", () => {
    const unsubscribe = vi.fn()
    const onPreventedAppClose = vi.fn(() => unsubscribe)

    installMockWindowApi({ utils: { onPreventedAppClose } })

    const { unmount } = renderWithProviders(
      <GlobalActionsWrapper>
        <NotificationsOverlay />
      </GlobalActionsWrapper>
    )

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
