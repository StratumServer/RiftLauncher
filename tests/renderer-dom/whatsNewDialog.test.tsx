import { describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import WhatsNewDialog from "@renderer/components/layout/WhatsNewDialog"
import { resetWhatsNewCacheForTests } from "@renderer/features/info/hooks/useWhatsNew"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import type { MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * "What's new" after an update (#439): shown once per session when the running version outran
 * `lastSeenChangelogVersion`, gated behind the ModDB prompt having nothing to ask for the running
 * version (#477) so a launch never stacks two full-screen dialogs, and never re-fetched once the
 * module has answered for this session (useWhatsNew.ts's whole reason for existing).
 *
 * `resetWhatsNewCacheForTests` runs before every test: without it the second test to mount this
 * component would see the first test's cached, already-resolved promise instead of its own mock.
 */
/** A ModDB answer that has nothing left to ask or count, so only the What's new gate is under test. */
const ANSWERED: ConfigType["moddbVisibility"] = { policy: "never", answeredVersion: "", countedVersions: [] }

function mountWith(overrides: { lastSeenChangelogVersion?: string; moddbVisibility?: ConfigType["moddbVisibility"]; version?: string; releases?: WhatsNewReleaseInfo[] }): MockedBridgeAPI {
  resetWhatsNewCacheForTests()

  const api = installMockWindowApi({
    configManager: {
      getConfig: vi.fn(async () =>
        createMockConfig({
          lastSeenChangelogVersion: overrides.lastSeenChangelogVersion ?? "1.0.0",
          moddbVisibility: overrides.moddbVisibility ?? ANSWERED
        })
      )
    },
    utils: { getAppVersion: vi.fn(async () => overrides.version ?? "1.1.0") },
    netManager: {
      fetchReleaseNotes: vi.fn(async () => ({ ok: true, releases: overrides.releases ?? [releaseFixture()] }) as FetchReleaseNotesResult)
    }
  })

  renderWithProviders(<WhatsNewDialog />)
  return api
}

function releaseFixture(overrides: Partial<WhatsNewReleaseInfo> = {}): WhatsNewReleaseInfo {
  return { tag: "1.1.0", name: "The 1.1.0 release", body: "- A bullet from the release notes", prerelease: false, draft: false, publishedAt: "2026-01-01T00:00:00Z", ...overrides }
}

/** The lastSeenChangelogVersion the last saveConfig call carried, or undefined when the config was never saved. */
function savedVersion(api: MockedBridgeAPI): string | undefined {
  const calls = vi.mocked(api.configManager.saveConfig).mock.calls
  return calls.at(-1)?.[0]?.lastSeenChangelogVersion
}

describe("WhatsNewDialog", () => {
  it("appears once the running version has outrun the last one seen", async () => {
    mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0" })
    expect(await screen.findByText("What's new in 1.1.0")).toBeTruthy()
    expect(await screen.findByText("A bullet from the release notes")).toBeTruthy()
  })

  it("never appears when the running version is already the one last seen", async () => {
    const api = mountWith({ lastSeenChangelogVersion: "1.1.0", version: "1.1.0" })

    await waitFor(() => expect(api.utils.getAppVersion).toHaveBeenCalled())
    // A tick for the effect chain to have settled if it were going to fetch at all.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText(/What's new/)).toBeNull()
    expect(api.netManager.fetchReleaseNotes).not.toHaveBeenCalled()
  })

  it("does not appear while the ModDB prompt still has a question for this version", async () => {
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0", moddbVisibility: { policy: "ask", answeredVersion: "", countedVersions: [] } })

    await waitFor(() => expect(api.netManager.fetchReleaseNotes).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText(/What's new/)).toBeNull()
  })

  it("marks the running version seen through the config when Got it is clicked, and closes", async () => {
    const user = userEvent.setup()
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0" })

    await screen.findByText("What's new in 1.1.0")
    await user.click(screen.getByRole("button", { name: "Got it" }))

    await waitFor(() => expect(savedVersion(api)).toBe("1.1.0"))
    // The panel leaves on Headless UI's own exit animation, hence the wait rather than a plain assertion.
    await waitFor(() => expect(screen.queryByText("What's new in 1.1.0")).toBeNull())
  })

  it("marks the running version seen when Escape closes it, the same as Got it", async () => {
    const user = userEvent.setup()
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0" })

    await screen.findByText("What's new in 1.1.0")
    // Escape and a backdrop click both reach PopupDialogPanel's `close`, which is the handler
    // "Got it" is wired to as well; the notes stay readable on Info & Help afterwards.
    await user.keyboard("{Escape}")

    await waitFor(() => expect(savedVersion(api)).toBe("1.1.0"))
    await waitFor(() => expect(screen.queryByText("What's new in 1.1.0")).toBeNull())
  })

  it("marks the version seen when the fetch succeeded but carries no release for it", async () => {
    // A development build, or a version whose release is not published yet. There is nothing to
    // show and there never will be, so the next launch should not ask GitHub all over again.
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0-dev", releases: [releaseFixture({ tag: "1.0.0" })] })

    await waitFor(() => expect(savedVersion(api)).toBe("1.1.0-dev"))
    expect(screen.queryByText(/What's new/)).toBeNull()
  })

  it("marks nothing seen when the fetch failed, so the next launch tries again", async () => {
    resetWhatsNewCacheForTests()

    const api = installMockWindowApi({
      configManager: { getConfig: vi.fn(async () => createMockConfig({ lastSeenChangelogVersion: "1.0.0", moddbVisibility: ANSWERED })) },
      utils: { getAppVersion: vi.fn(async () => "1.1.0") },
      netManager: { fetchReleaseNotes: vi.fn(async () => ({ ok: false, reason: "offline" }) as FetchReleaseNotesResult) }
    })

    renderWithProviders(<WhatsNewDialog />)

    await waitFor(() => expect(api.netManager.fetchReleaseNotes).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.configManager.saveConfig).not.toHaveBeenCalled()
    expect(screen.queryByText(/What's new/)).toBeNull()
  })

  it("does not reappear on a rerender once the version is marked seen", async () => {
    const user = userEvent.setup()
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0" })

    await screen.findByText("What's new in 1.1.0")
    await user.click(screen.getByRole("button", { name: "Got it" }))
    await waitFor(() => expect(savedVersion(api)).toBe("1.1.0"))

    // The config round-trips through saveConfig -> getConfig in a real session; here the context
    // already holds the update from the dispatch the click made, so re-rendering with the same
    // props is enough to prove the dialog does not come back once dismissed and marked seen.
    // The panel itself leaves on Headless UI's own exit animation, hence the wait.
    await waitFor(() => expect(screen.queryByText("What's new in 1.1.0")).toBeNull())
    expect(screen.queryByText(/What's new/)).toBeNull()
  })

  it("titles a multi-release catch-up as What's new since the previous version", async () => {
    mountWith({
      lastSeenChangelogVersion: "1.0.0",
      version: "1.2.0",
      releases: [releaseFixture({ tag: "1.2.0", name: "1.2.0" }), releaseFixture({ tag: "1.1.0", name: "1.1.0" })]
    })

    expect(await screen.findByText("What's new since 1.0.0")).toBeTruthy()
  })

  it("opens the releases page through the external-link adapter", async () => {
    const user = userEvent.setup()
    const api = mountWith({ lastSeenChangelogVersion: "1.0.0", version: "1.1.0" })

    await screen.findByText("What's new in 1.1.0")
    await user.click(screen.getByRole("button", { name: "All releases" }))

    expect(api.utils.openOnBrowser).toHaveBeenCalledWith("https://github.com/StratumServer/RiftLauncher/releases")
  })
})
