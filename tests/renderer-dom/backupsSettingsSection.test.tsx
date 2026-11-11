import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"

import { BackupsSettingsSection } from "@renderer/features/installations/components/BackupsSettingsSection"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

describe("BackupsSettingsSection", () => {
  it("offers the whole 0 to 100 range the Installation forms accept for Backups max amount", () => {
    installMockWindowApi()
    renderWithProviders(<BackupsSettingsSection backupsLimit={3} onBackupsLimitChange={vi.fn()} backupsAuto onBackupsAutoChange={vi.fn()} compressionLevel={5} onCompressionLevelChange={vi.fn()} />, {
      route: false
    })

    const input = screen.getByPlaceholderText("Backups max amount") as HTMLInputElement
    expect(input.min).toBe("0")
    expect(input.max).toBe("100")
    expect(screen.getByText("Number between 0 and 100")).toBeTruthy()
  })
})
