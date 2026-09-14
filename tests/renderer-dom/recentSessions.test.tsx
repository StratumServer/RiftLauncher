import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RecentSessionsSection } from "@renderer/features/installations/components/RecentSessionsSection"
import { MAX_SESSIONS_PER_INSTALLATION } from "@domain/sessions/sampling"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const MIB = 1024 * 1024
const MINUTE = 60_000

/** A session of `count` readings over `minutes`, rising by `stepMiB` a reading from `baseMiB`. */
function aSession(overrides: Partial<PlaySession> = {}, shape: { count?: number; minutes?: number; baseMiB?: number; stepMiB?: number } = {}): PlaySession {
  const count = shape.count ?? 120
  const minutes = shape.minutes ?? 60
  const base = shape.baseMiB ?? 1_000
  const step = shape.stepMiB ?? 0

  return {
    id: "session-a",
    startedAt: Date.UTC(2026, 0, 2, 20, 0, 0),
    endedAt: Date.UTC(2026, 0, 2, 20, 0, 0) + minutes * MINUTE,
    intervalMs: 5_000,
    partial: false,
    samples: Array.from({ length: count }, (_, index) => ({ t: (index * minutes * MINUTE) / count, rssBytes: (base + index * step) * MIB, cpuPercent: 20 })),
    ...overrides
  }
}

function mountWith(read: PlaySessionsReadResult, options: { measuring?: boolean; isPlaying?: boolean } = {}): ReturnType<typeof installMockWindowApi> {
  const api = installMockWindowApi({
    gameManager: {
      getPlaySessions: vi.fn(async () => read),
      forgetPlaySessions: vi.fn(async () => ({ ok: true }))
    }
  })

  renderWithProviders(<RecentSessionsSection installationId="install-a" isPlaying={options.isPlaying ?? false} measuring={options.measuring ?? true} />)
  return api
}

describe("Recent sessions", () => {
  it("says nothing has been recorded yet, and names what it would record", async () => {
    mountWith({ ok: true, sessions: [] })

    expect(await screen.findByText(new RegExp(`No sessions recorded yet.*last ${MAX_SESSIONS_PER_INSTALLATION} sessions here`))).toBeTruthy()
  })

  it("renders nothing at all when there is no history and nothing is being measured", async () => {
    mountWith({ ok: true, sessions: [] }, { measuring: false })

    await waitFor(() => expect(screen.queryByText("Recent sessions")).toBeNull())
  })

  it("still shows a history that was recorded before the setting was turned off", async () => {
    mountWith({ ok: true, sessions: [aSession()] }, { measuring: false })

    expect(await screen.findByTitle("Open this session")).toBeTruthy()
  })

  it("gives each session a row a keyboard can reach, with its length and its peak", async () => {
    mountWith({ ok: true, sessions: [aSession({}, { baseMiB: 1_000, stepMiB: 8, count: 120, minutes: 90 })] })

    const row = await screen.findByRole("button", { name: /1h 30m/ })
    expect(row.tagName).toBe("BUTTON")
    // 1000 MiB rising by 8 a reading over 120 readings peaks at 1952 MiB, which reads in GiB.
    expect(row.textContent).toContain("1.91 GiB")
  })

  it("opens the session on a click and says how long it ran", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({}, { minutes: 45 })] })

    await user.click(await screen.findByTitle("Open this session"))

    expect(await screen.findByText(/Ran for 45m/)).toBeTruthy()
  })

  it("draws the chart with a name, and offers the same readings as a table", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({}, { count: 4, minutes: 30, baseMiB: 1_000, stepMiB: 100 })] })

    await user.click(await screen.findByTitle("Open this session"))

    const chart = await screen.findByRole("img", { name: /Memory and CPU across one session/ })
    expect(chart.querySelectorAll("polyline").length).toBe(2)

    // The table is the accessible equivalent, so it carries every point the line is drawn from.
    const table = screen.getByRole("table")
    expect(table.querySelectorAll("tbody tr").length).toBe(4)
    expect(table.textContent).toContain("1.27 GiB")
    expect(screen.getByText(/CPU is the dashed line/)).toBeTruthy()
  })

  it("says CPU is not measured rather than drawing a line it does not have", async () => {
    const user = userEvent.setup()
    const noCpu = aSession({}, { count: 4 })
    mountWith({ ok: true, sessions: [{ ...noCpu, samples: noCpu.samples.map(({ t, rssBytes }) => ({ t, rssBytes })) }] })

    await user.click(await screen.findByTitle("Open this session"))

    expect(await screen.findByText(/CPU is not measured on this system/)).toBeTruthy()
    expect(screen.getByRole("img", { name: /Memory and CPU/ }).querySelectorAll("polyline").length).toBe(1)
  })

  it("says a session is incomplete rather than calling it a crash", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({ partial: true })] })

    await user.click(await screen.findByTitle("Open this session"))

    const notice = await screen.findByText(/lost track of the game part way through/)
    expect(notice.textContent).toContain("incomplete")
    expect(notice.textContent).not.toMatch(/crash|error|failed/i)
  })

  /**
   * A session the rule flags, and the two things the wording must never do: name a cause, or say
   * anything about a Mod. The launcher measures the whole game from outside; a curve cannot say
   * what inside it grew.
   */
  it("flags a steady climb without ever naming a cause", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({}, { count: 240, minutes: 60, baseMiB: 1_000, stepMiB: 4 })] })

    await user.click(await screen.findByTitle("Open this session"))

    expect(await screen.findByText("Memory only went up during this session.")).toBeTruthy()

    const meaning = screen.getByText(/cannot say what used the memory/).textContent ?? ""
    expect(meaning).toMatch(/A mod, the game itself and a large world all look the same from here/)
    expect(meaning).not.toMatch(/\bleak/i)
    expect(meaning).not.toMatch(/at fault|blame|caused by|responsible/i)
  })

  it("says nothing at all about a session it did not flag", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({}, { count: 240, minutes: 60, baseMiB: 2_000, stepMiB: 0 })] })

    await user.click(await screen.findByTitle("Open this session"))

    await screen.findByRole("img", { name: /Memory and CPU/ })
    // Not flagged is not the same as cleared, so nothing reassuring is printed either.
    expect(screen.queryByText(/Memory only went up/)).toBeNull()
    expect(screen.queryByText(/fine|healthy|no problem|nothing wrong/i)).toBeNull()
  })

  it("leaves a file it cannot read alone and says so", async () => {
    mountWith({ ok: false, reason: "newer-format" })

    expect(await screen.findByText(/recorded by a newer version of the launcher/)).toBeTruthy()
    expect(screen.queryByTitle("Open this session")).toBeNull()
  })

  it("treats a channel that never answers as a file it could not read", async () => {
    installMockWindowApi({
      gameManager: {
        getPlaySessions: vi.fn(async () => {
          throw new Error("the bridge went away")
        })
      }
    })
    renderWithProviders(<RecentSessionsSection installationId="install-a" isPlaying={false} measuring />)

    expect(await screen.findByText(/could not be read/)).toBeTruthy()
  })

  it("keeps the rows when the file refuses to be cleared", async () => {
    const user = userEvent.setup()
    installMockWindowApi({
      gameManager: {
        getPlaySessions: vi.fn(async () => ({ ok: true as const, sessions: [aSession()] })),
        forgetPlaySessions: vi.fn(async () => ({ ok: false }))
      }
    })
    renderWithProviders(<RecentSessionsSection installationId="install-a" isPlaying={false} measuring />)

    await user.click(await screen.findByTitle("Forget these sessions"))

    expect(screen.getByTitle("Open this session")).toBeTruthy()
  })

  it("clears the sessions when the player asks it to", async () => {
    const user = userEvent.setup()
    const api = mountWith({ ok: true, sessions: [aSession()] })

    await user.click(await screen.findByTitle("Forget these sessions"))

    await waitFor(() => expect(screen.queryByTitle("Open this session")).toBeNull())
    expect(api.gameManager.forgetPlaySessions).toHaveBeenCalledWith("install-a")
  })

  it("does not read the file again while the game is still running", async () => {
    const api = mountWith({ ok: true, sessions: [] }, { isPlaying: true })

    await waitFor(() => expect(screen.queryByTitle("Open this session")).toBeNull())
    expect(api.gameManager.getPlaySessions).not.toHaveBeenCalled()
  })
})
