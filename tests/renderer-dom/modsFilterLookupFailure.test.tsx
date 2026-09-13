import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import AuthorFilter from "@renderer/features/mods/components/AuthorFilter"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const LOOKUP_FAILED = "Couldn't reach the ModDB. Check your connection and try again."

function renderAuthorFilter(queryURL: (url: string) => Promise<string>): void {
  installMockWindowApi({ netManager: { queryURL: vi.fn(queryURL) } })
  renderWithProviders(<AuthorFilter authorFilter={{ userid: "", name: "" }} setAuthorFilter={() => {}} />, { route: "/mods" })
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

  it("says nothing when the lookup lands", async () => {
    const user = userEvent.setup()
    renderAuthorFilter(async () => JSON.stringify({ statuscode: "200", authors: [{ userid: "1", name: "Someone" }] }))

    await user.click(screen.getByRole("button"))

    expect(await screen.findByText("Someone")).toBeTruthy()
    expect(screen.queryByText(LOOKUP_FAILED)).toBeNull()
  })
})
