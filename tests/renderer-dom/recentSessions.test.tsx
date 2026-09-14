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

  it("says a session is incomplete rather than calling it a crash", async () => {
    const user = userEvent.setup()
    mountWith({ ok: true, sessions: [aSession({ partial: true })] })

    await user.click(await screen.findByTitle("Open this session"))

    const notice = await screen.findByText(/lost track of the game part way through/)
    expect(notice.textContent).toContain("incomplete")
    expect(notice.textContent).not.toMatch(/crash|error|failed/i)
  })

  it("leaves a file it cannot read alone and says so", async () => {
    mountWith({ ok: false, reason: "newer-format" })

    expect(await screen.findByText(/recorded by a newer version of the launcher/)).toBeTruthy()
    expect(screen.queryByTitle("Open this session")).toBeNull()
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
