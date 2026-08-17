import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"

import ModChangeSummaryPopup from "@renderer/features/mods/components/ModChangeSummaryPopup"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * An entry whose `assetid` is missing or zero has no ModDB page to open, so its
 * actions cell is meant to stay empty. `{entry.assetid && <button/>}` did not
 * say that: a zero is falsy but it is also a renderable React node, so React
 * printed the digit into the cell instead of skipping it.
 */
function anEntry(overrides: Partial<ModChangeSummaryEntry> = {}): ModChangeSummaryEntry {
  return {
    name: "Alpha Mod",
    modid: "alpha",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    ...overrides
  }
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li")
  if (!row) throw new Error(`No table row found for "${name}".`)
  return row
}

describe("ModChangeSummaryPopup actions cell", () => {
  it("renders no ModDB button and leaks no digit for an entry whose assetid is zero", () => {
    installMockWindowApi()

    renderWithProviders(<ModChangeSummaryPopup isOpen close={(): void => {}} title="Summary" entries={[anEntry({ name: "Zero Asset", modid: "zero", assetid: 0 })]} />)

    const row = rowFor("Zero Asset")
    expect(within(row).queryByRole("button", { name: "Open on the ModDB!" })).toBeNull()
    expect(within(row).queryByText("0")).toBeNull()
  })

  it("renders no ModDB button for an entry with no assetid at all", () => {
    installMockWindowApi()

    renderWithProviders(<ModChangeSummaryPopup isOpen close={(): void => {}} title="Summary" entries={[anEntry({ name: "No Asset", modid: "none" })]} />)

    expect(within(rowFor("No Asset")).queryByRole("button", { name: "Open on the ModDB!" })).toBeNull()
  })

  it("still renders the ModDB button for an entry with a real assetid", () => {
    installMockWindowApi()

    renderWithProviders(<ModChangeSummaryPopup isOpen close={(): void => {}} title="Summary" entries={[anEntry({ name: "Real Asset", modid: "real", assetid: 42 })]} />)

    expect(within(rowFor("Real Asset")).getByRole("button", { name: "Open on the ModDB!" })).toBeTruthy()
  })
})
