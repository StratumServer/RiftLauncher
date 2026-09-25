import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AuthorFilter from "@renderer/features/mods/components/AuthorFilter"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const LOOKUP_FAILED = "Couldn't reach the ModDB. Check your connection and try again."

function renderAuthorFilter(queryURL: (url: string) => Promise<string>): ReturnType<typeof installMockWindowApi> {
  const api = installMockWindowApi({ netManager: { queryURL: vi.fn(queryURL) } })
  renderWithProviders(<AuthorFilter authorFilter={{ userid: "", name: "" }} setAuthorFilter={() => {}} />, { route: "/mods" })
  return api
}

/**
 * #411: the author lookup rejected (a timed out QUERY_URL), the hook swallowed it, and the
 * suggestion box stayed empty. An empty box is also what "nobody has published a Mod" looks
 * like, so the player was told nothing at all.
 */
describe("ModDB filter lookups", () => {
  it("tells the player in the suggestion box when the author lookup fails", async () => {
    const user = userEvent.setup()
    renderAuthorFilter(async () => {
      throw new Error("Network request timed out")
    })

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText(LOOKUP_FAILED)).toBeTruthy()
  })

  /**
   * #526: a too-large response is a permanent, size-shaped refusal, not a network hiccup.
   * `useModDbLookups.ts` tells the two apart from `err.message` alone, so this pins the token
   * the log line actually carries for each, without touching what the player sees (still
   * LOOKUP_FAILED either way, since neither is something a retry fixes).
   */
  it("logs a distinct token for a too-large response instead of the generic request-failed one", async () => {
    const user = userEvent.setup()
    const api = renderAuthorFilter(async () => {
      throw new Error("Network response is too large")
    })

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText(LOOKUP_FAILED)).toBeTruthy()
    expect(vi.mocked(api.utils.logMessage)).toHaveBeenCalledWith("warn", expect.stringContaining("Lookup failed: response-too-large."))
  })

  it("keeps the generic token for every other rejection", async () => {
    const user = userEvent.setup()
    const api = renderAuthorFilter(async () => {
      throw new Error("Network request timed out")
    })

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText(LOOKUP_FAILED)).toBeTruthy()
    expect(vi.mocked(api.utils.logMessage)).toHaveBeenCalledWith("warn", expect.stringContaining("Lookup failed: request-failed."))
  })

  it("says nothing when the lookup lands", async () => {
    const user = userEvent.setup()
    renderAuthorFilter(async () => JSON.stringify({ statuscode: "200", authors: [{ userid: "1", name: "Someone" }] }))

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText("Someone")).toBeTruthy()
    expect(screen.queryByText(LOOKUP_FAILED)).toBeNull()
  })
})
