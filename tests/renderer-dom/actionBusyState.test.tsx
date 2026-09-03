import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PiTrashDuotone } from "react-icons/pi"

import { NormalButton } from "@renderer/components/ui/Buttons"
import { FormButton } from "@renderer/components/ui/FormComponents"

/**
 * Every destructive or long-running action in the launcher hangs off an async handler, and until
 * this the button looked identical while that handler ran: launching the game, writing an
 * installation and deleting a version were all re-clickable mid-flight. The button now treats a
 * handler that returns a promise as the signal to block itself, so these pin the two halves that
 * matter to a player — it refuses the second click, and it says out loud that it is working.
 */
describe("an action button running async work", () => {
  it("blocks further clicks until the handler settles", async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const onClick = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))

    render(<FormButton title="Delete" icon={<PiTrashDuotone />} variant="destructive" onClick={onClick} />)
    const button = screen.getByRole("button", { name: "Delete" })

    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"))
    expect((button as HTMLButtonElement).disabled).toBe(true)

    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect(button.getAttribute("aria-busy")).toBe("false")

    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it("swaps a spinner in for the icon while it runs, and keeps the label", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn(() => new Promise<void>(() => {}))

    const { container } = render(<FormButton title="Delete" icon={<PiTrashDuotone data-testid="rest-icon" />} onClick={onClick} />)
    expect(screen.getByTestId("rest-icon")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(screen.queryByTestId("rest-icon")).toBeNull())
    expect(container.querySelector(".animate-spin")).toBeTruthy()
    // The label has to survive: a spinner on its own leaves the player guessing what is running.
    expect(screen.getByText("Delete")).toBeTruthy()
  })

  it("shows the spinner on a button whose label is its own child, like Play", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn(() => new Promise<void>(() => {}))

    const { container } = render(
      <NormalButton title="Play" variant="primary" onClick={onClick}>
        <p>Play</p>
      </NormalButton>
    )

    await user.click(screen.getByRole("button", { name: "Play" }))

    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeTruthy())
    // The resting content stays in the layout, hidden, so the button reserves the same box it
    // had: a control that grows under the cursor is how a second click lands somewhere else.
    const resting = screen.getByText("Play").parentElement
    expect(resting?.className).toContain("invisible")
    expect(container.querySelector(".animate-spin")?.parentElement?.className).toContain("absolute")
  })

  it("never adds the spinner alongside the resting content", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn(() => new Promise<void>(() => {}))

    // An icon-only tool button: the spinner has to take the icon's place, not sit next to it.
    const { container } = render(
      <NormalButton title="Reload" variant="ghost" onClick={onClick}>
        <PiTrashDuotone data-testid="tool-icon" />
      </NormalButton>
    )

    await user.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeTruthy())

    const icon = screen.getByTestId("tool-icon")
    const hidden = icon.closest(".invisible")
    expect(hidden, "the resting icon must be hidden, not left beside the spinner").toBeTruthy()
    // Exactly one of the two is visible at a time.
    expect(container.querySelectorAll(".animate-spin").length).toBe(1)
  })

  it("leaves a synchronous handler alone", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(<FormButton title="Cancel" icon={<PiTrashDuotone />} onClick={onClick} />)
    const button = screen.getByRole("button", { name: "Cancel" })

    await user.click(button)
    await user.click(button)

    expect(onClick).toHaveBeenCalledTimes(2)
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
