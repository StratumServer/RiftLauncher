import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Routes, Route } from "react-router-dom"

import SessionReport from "@renderer/features/installations/pages/SessionReport"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

function anInstallation(): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.22.0",
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
    _modsCount: 0
  }
}

function aReport(overrides: Partial<SessionReportType> = {}): SessionReportType {
  return {
    verdict: { kind: "crashed-in-mod", modLabel: "Auto Map Markers" },
    source: { fileName: "client-main.log", lastWrittenAtMs: Date.UTC(2026, 1, 22, 20, 39), truncated: false },
    mods: [
      {
        modid: "ancienttools",
        name: "Ancient Tools",
        signal: "modid-prefix",
        errors: 2,
        warnings: 1,
        lines: [{ clock: "13:00:08", severity: "Error", text: "Exception: Object reference not set to an instance of an object.", continuation: ["at ModConfig.ReadConfig()"] }]
      }
    ],
    unattributed: [],
    startup: { phases: [{ name: "LoadAssets", seconds: 7 }], landmarks: [{ kind: "mods", count: 24 }] },
    ...overrides
  }
}

function renderReport(): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <Routes>
      <Route path="/installations/report/:id" element={<SessionReport />} />
    </Routes>,
    { route: "/installations/report/install-a" }
  )
}

describe("the session report page", () => {
  it("reads the verdict, where it came from, and the Mod group under it", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport() })) }
    })

    renderReport()

    expect(await screen.findByText("The game crashed in Auto Map Markers.")).toBeTruthy()
    expect(screen.getByText(/From client-main\.log, last written/)).toBeTruthy()
    expect(screen.getByText("Ancient Tools")).toBeTruthy()
    expect(screen.getByText("2 errors")).toBeTruthy()
    expect(screen.getByText("1 warning")).toBeTruthy()
    // The signal is shown, because a wrongly blamed Mod is a mod author's bad afternoon.
    expect(screen.getByText("named by the log line")).toBeTruthy()
  })

  it("waits visibly, then says so in place when there are no logs to read yet", async () => {
    const deferred: { answer: (answer: GameLogReportResult) => void } = { answer: () => undefined }
    const held = new Promise<GameLogReportResult>((resolve) => {
      deferred.answer = resolve
    })
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(() => held) }
    })

    renderReport()

    // Held open on purpose. The page is reachable before the config lands, and a sentence read off
    // a page that has not asked yet would pass for any answer at all; this waits for the loading
    // state, so what comes after it is the answer rather than the state the page started in.
    expect(await screen.findByText("Reading the last session.")).toBeTruthy()

    deferred.answer({ ok: false, reason: "no-logs" })

    expect(await screen.findByText("No logs were found for this Installation yet.")).toBeTruthy()
  })

  it("says the logs could not be read, which is not the same as saying there are none", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: false as const, reason: "unreadable" as const })) }
    })

    renderReport()

    expect(await screen.findByText("This Installation's logs could not be read.")).toBeTruthy()
    expect(screen.queryByText("No logs were found for this Installation yet.")).toBeNull()
  })

  it("reads a rejected channel the same way, rather than telling the player nothing was logged", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: {
        getGameLogReport: vi.fn(async () => {
          throw new Error("the bridge is gone")
        })
      }
    })

    renderReport()

    expect(await screen.findByText("This Installation's logs could not be read.")).toBeTruthy()
    expect(screen.queryByText("No logs were found for this Installation yet.")).toBeNull()
  })

  it("says no logs, and reads nothing, for an id the config does not name", async () => {
    const getGameLogReport = vi.fn(async () => ({ ok: true as const, report: aReport() }))
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [] })) },
      gameManager: { getGameLogReport }
    })

    renderReport()

    expect(await screen.findByText("No logs were found for this Installation yet.")).toBeTruthy()
    expect(getGameLogReport).not.toHaveBeenCalled()
  })

  it("says the middle of a long log was not read rather than implying it saw everything", async () => {
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: {
        getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport({ source: { fileName: "client-main.log", truncated: true } }) }))
      }
    })

    renderReport()

    expect(await screen.findByText("The middle of this log was not read.")).toBeTruthy()
  })

  it("opens and closes a section from the keyboard alone", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport() })) }
    })

    renderReport()

    // Startup ships closed, so reaching its contents is the thing the keyboard has to be able to do.
    const startup = await screen.findByRole("button", { name: "Startup" })
    expect(screen.queryByText("Mods found: 24")).toBeNull()

    startup.focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByText("Mods found: 24")).toBeTruthy()
    expect(screen.getByText("LoadAssets, about 7 s")).toBeTruthy()
  })

  it("copies the report and says whether it landed", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn((text: string) => Promise.resolve(text).then(() => undefined))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport() })) }
    })

    renderReport()

    await user.click(await screen.findByRole("button", { name: "Copy report" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0]?.[0] ?? ""
    expect(copied).toMatch(/^The game crashed in Auto Map Markers\./)
    expect(copied).toMatch(/Ancient Tools \(2 errors, 1 warnings, named by the log line\)/)
  })

  it("falls back to the selection copy when the clipboard API is refused", async () => {
    const user = userEvent.setup()
    // main/index.ts denies every permission request, and Chromium routes a clipboard write through
    // one, so this rejection is the packaged app's real behaviour rather than a hypothetical.
    const writeText = vi.fn(async () => {
      throw new Error("write permission denied")
    })
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true })

    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport() })) }
    })

    renderReport()

    await user.click(await screen.findByRole("button", { name: "Copy report" }))

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"))
  })

  it("opens the Installation's own Logs folder, and never anything beside it", async () => {
    const user = userEvent.setup()
    const openPathOnFileExplorer = vi.fn(async () => {})
    installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [anInstallation()] })) },
      gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aReport() })) },
      pathsManager: { checkPathExists: vi.fn(async () => true), openPathOnFileExplorer }
    })

    renderReport()

    await user.click(await screen.findByRole("button", { name: "Open logs folder" }))

    await waitFor(() => expect(openPathOnFileExplorer).toHaveBeenCalledWith("/games/a/Logs"))
  })
})
