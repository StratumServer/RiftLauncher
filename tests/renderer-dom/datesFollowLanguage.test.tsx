import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ListInstallations from "@renderer/features/installations/pages/ListInstallations"
import ManageInstallationBackups from "@renderer/features/installations/pages/ManageInstallationBackups"
import ManageInstallationWorlds from "@renderer/features/installations/pages/ManageInstallationWorlds"
import SessionReport from "@renderer/features/installations/pages/SessionReport"
import ManageInstallationServers from "@renderer/features/servers/pages/ManageInstallationServers"
import { RecentSessionsSection } from "@renderer/features/installations/components/RecentSessionsSection"
import InstallModPopup from "@renderer/features/mods/components/InstallModPopup"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { changeLanguage } from "@renderer/i18n"

import { createMockConfig, installMockWindowApi, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * #616: a date on screen is written the way the launcher's language writes it. The installations
 * list, the backups list, the servers page and a Mod's release table printed Spanish whatever the
 * language, and Manage Worlds printed the system's locale, so "4/10/2026" meant 4 October to one
 * reader and 10 April to the next, on lists whose job is to tell the newest entry from an older one.
 *
 * Every screen below prints the same moment, 4 October 2026, and only its date is compared:
 * "10/4/2026" in English and "04/10/2026" in French, where the launcher used to print "4/10/2026"
 * for both. What follows the date (a 12 or 24 hour clock, the space before PM) is ICU's to spell
 * and has changed between Node releases, so it is left out on purpose.
 */

/** Built from local fields, so the day on screen is this one in whatever time zone the suite runs. */
const MOMENT = new Date(2026, 9, 4, 13, 54, 56).getTime()

/** The same moment as the ModDB writes it. Text with no zone is read as local time as well. */
const MODDB_MOMENT = "2026-10-04 13:54:56"

const LANGUAGES = [
  { language: "en-US", numeric: /10\/4\/2026/, long: /October 4, 2026/ },
  { language: "fr-FR", numeric: /04\/10\/2026/, long: /4 octobre 2026/ }
] as const

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.22.7",
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

/** The config a page reads its Installation from, and whatever else the bridge has to answer for it. */
function withInstallation(installation: InstallationType, overrides: WindowApiOverrides = {}): void {
  installMockWindowApi({ configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [installation] })) }, ...overrides })
}

/** A page that reads its Installation id off the route needs a real match, not just a MemoryRouter entry. */
function renderPage(path: string, page: JSX.Element): void {
  renderWithProviders(
    <Routes>
      <Route path={`${path}/:id`} element={<TaskProvider>{page}</TaskProvider>} />
    </Routes>,
    { route: `${path}/install-a` }
  )
}

function aPlaySession(): PlaySession {
  const minute = 60_000

  return {
    id: "session-a",
    startedAt: MOMENT,
    endedAt: MOMENT + 45 * minute,
    intervalMs: 5_000,
    partial: false,
    samples: Array.from({ length: 4 }, (_, index) => ({ t: index * 15 * minute, rssBytes: 1_000_000_000, cpuPercent: 20 }))
  }
}

function aSessionReport(): SessionReportType {
  return {
    verdict: { kind: "clean" },
    source: { fileName: "client-main.log", lastWrittenAtMs: MOMENT, truncated: false },
    mods: [],
    unattributed: [],
    startup: { phases: [], landmarks: [] }
  }
}

/** `GET /api/mod/{id}` for one release, and the empty game version catalog the table also asks for. */
function moddbWithOneRelease(url: string): Promise<string> {
  if (url.includes("/gameversions")) return Promise.resolve(JSON.stringify({ statuscode: "200", gameversions: [] }))

  const release = {
    releaseid: 1,
    mainfile: "https://mods.example/coolmod-1.0.0.zip",
    filename: "coolmod-1.0.0.zip",
    fileid: 1,
    downloads: 0,
    tags: ["1.22.7"],
    modidstr: "coolmod",
    modversion: "1.0.0",
    created: MODDB_MOMENT,
    changelog: ""
  }
  return Promise.resolve(JSON.stringify({ statuscode: "200", mod: { modid: 42, assetid: 4242, name: "Cool Mod", releases: [release] } }))
}

describe.each(LANGUAGES)("with the launcher in $language", ({ language, numeric, long }) => {
  beforeEach(async () => {
    expect(await changeLanguage(language)).toBe(true)
    // After the test, which is after the cleanup that unmounts the page: a language switch on a
    // mounted page would re-render it outside act().
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
  })

  it("writes when an Installation was last played on the Installations list", async () => {
    withInstallation(anInstallation({ lastTimePlayed: MOMENT }))

    renderWithProviders(
      <TaskProvider>
        <ListInstallations />
      </TaskProvider>,
      { route: "/installations" }
    )

    expect(await screen.findByText(numeric)).toBeTruthy()
  })

  it("writes the date of a backup on the backups list", async () => {
    withInstallation(anInstallation({ backups: [{ id: "backup-1", date: MOMENT, path: "/backups/a/backup-1.tar.gz" }] }))

    renderPage("/installations/backups", <ManageInstallationBackups />)

    expect(await screen.findByText(numeric)).toBeTruthy()
  })

  it("writes when a server was last launched, inside the sentence that says so", async () => {
    withInstallation(anInstallation({ servers: [{ id: "server-1", name: "Stratum", host: "play.example.com", port: 42_420, lastLaunched: MOMENT }] }))

    renderPage("/installations/servers", <ManageInstallationServers />)

    // A date i18next had escaped would read "10&#x2F;4&#x2F;2026" and not match.
    expect(await screen.findByText(numeric)).toBeTruthy()
  })

  it("writes the dates of a world and of each backup of it on Manage Worlds", async () => {
    withInstallation(anInstallation({ worldBackups: [{ id: "backup-1", date: MOMENT, path: "/backups/backup-1.tar.gz", worldName: "World.vcdbs" }] }), {
      worldsManager: { list: vi.fn(async () => ({ ok: true as const, worlds: [{ name: "World.vcdbs", size: 5, lastModified: MOMENT, isDefault: false, backupCount: 1 }] })) }
    })

    renderPage("/installations/worlds", <ManageInstallationWorlds />)

    // The size is only printed for a world that is on disk, so it says the list has landed.
    await screen.findByText(/5 B/)
    expect(screen.getAllByText(numeric)).toHaveLength(2)
  })

  it("writes the release date of each release in a Mod's release table", async () => {
    installMockWindowApi({ netManager: { queryURL: vi.fn(moddbWithOneRelease) } })

    renderWithProviders(
      <TaskProvider>
        <InstallModPopup modToInstall="coolmod" setModToInstall={() => {}} modName="Cool Mod" installation={{ installation: anInstallation() }} />
      </TaskProvider>
    )

    expect(await screen.findByText(numeric)).toBeTruthy()
  })

  it("writes when a session started, and when the session it opens ended", async () => {
    const user = userEvent.setup()
    installMockWindowApi({ gameManager: { getPlaySessions: vi.fn(async () => ({ ok: true as const, sessions: [aPlaySession()] })) } })

    renderWithProviders(<RecentSessionsSection installationId="install-a" isPlaying={false} measuring />)

    const row = (await screen.findByText(numeric)).closest("button")
    expect(row).not.toBeNull()
    await user.click(row as HTMLElement)

    // The row's start and the dialog's end fall on the same day.
    expect(await screen.findAllByText(numeric)).toHaveLength(2)
  })

  it("writes when the log behind a session report was last written, in full", async () => {
    withInstallation(anInstallation(), { gameManager: { getGameLogReport: vi.fn(async () => ({ ok: true as const, report: aSessionReport() })) } })

    renderPage("/installations/report", <SessionReport />)

    expect(await screen.findByText(long)).toBeTruthy()
  })
})
