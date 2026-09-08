import { describe, expect, it } from "vitest"

import GlobalActionsWrapper from "@renderer/components/layout/GlobalActionsWrapper"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Pins src/renderer/src/hooks/useBlockTextDragIntoInputs.ts (issue #395): dragging static page
 * text into a text field must do nothing, while dragging text already inside a field, where the
 * drag starts on the input/textarea itself, stays allowed.
 */
describe("useBlockTextDragIntoInputs", () => {
  it("prevents a dragstart that begins on plain page text", () => {
    installMockWindowApi()

    const { container } = renderWithProviders(
      <GlobalActionsWrapper>
        <h1>Some label</h1>
      </GlobalActionsWrapper>
    )

    const heading = container.querySelector("h1")!
    const event = new Event("dragstart", { bubbles: true, cancelable: true })
    heading.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it("allows a dragstart that begins inside an input", () => {
    installMockWindowApi()

    const { container } = renderWithProviders(
      <GlobalActionsWrapper>
        <input defaultValue="hello" />
      </GlobalActionsWrapper>
    )

    const input = container.querySelector("input")!
    const event = new Event("dragstart", { bubbles: true, cancelable: true })
    input.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
