import type { ReactElement, ReactNode } from "react"
import { render, type RenderOptions, type RenderResult } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { ConfigProvider } from "@renderer/features/config/contexts/ConfigContext"

// Importing this runs i18n.ts's module-level `i18n.use(initReactI18next).init(...)`,
// the same call App.tsx triggers by importing "./i18n". Without it, useTranslation()
// has no instance registered and every t() call falls back to the raw key.
import "@renderer/i18n"

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /**
   * Initial router entry, e.g. "/versions". Several components under test call
   * useNavigate/Link and throw outside a Router, so one is provided by default.
   * Pass `false` to render without a Router.
   */
  route?: string | false
}

/**
 * Mounts `ui` under the same provider nesting App.tsx uses after PR #43:
 * NotificationsProvider outermost, then ConfigProvider. ConfigContext's
 * SAVE_CONFIG effect looks up useNotificationsContext, which only resolves to
 * a real provider (not the no-op default) with that order, so getting it
 * backwards here would silently pass tests that fail for real users.
 *
 * Call installMockWindowApi (./windowApi) before this, since ConfigProvider
 * reads window.api.configManager.getConfig on mount.
 */
export function renderWithProviders(ui: ReactElement, { route = "/", ...renderOptions }: RenderWithProvidersOptions = {}): RenderResult {
  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    const withProviders = (
      <NotificationsProvider>
        <ConfigProvider>{children}</ConfigProvider>
      </NotificationsProvider>
    )
    return route === false ? <>{withProviders}</> : <MemoryRouter initialEntries={[route]}>{withProviders}</MemoryRouter>
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions })
}
