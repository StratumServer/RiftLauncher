import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { GridGroup, GridItem, GridWrapper } from "@renderer/components/ui/Grid"
import { TableBody, TableBodyRow, TableCell, TableWrapper } from "@renderer/components/ui/Table"
import ModListCard from "@renderer/features/mods/components/ModListCard"

import "@renderer/i18n"

/**
 * #263: GridItem and TableBodyRow render clickable, selectable list items. The
 * interactive descendant owns the role, name, focus and keyboard path, while
 * the outer li keeps the list structure intact.
 */
describe("GridItem accessibility", () => {
  it("is a plain, non-interactive li when it has no onClick", () => {
    render(
      <GridWrapper>
        <GridGroup>
          <GridItem>static card</GridItem>
        </GridGroup>
      </GridWrapper>
    )

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("static card").closest("li")?.getAttribute("role")).toBeNull()
  })

  it("keeps listitem structure and exposes role=button on its interactive descendant", () => {
    const { rerender } = render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={() => {}} selected={false} pressed={false} ariaLabel="Better Ruins">
            card body
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    const listItem = screen.getByRole("listitem")
    const card = within(listItem).getByRole("button", { name: "Better Ruins" })
    expect(listItem.contains(card)).toBe(true)
    expect(card.getAttribute("aria-pressed")).toBe("false")
    expect(card.getAttribute("tabindex")).toBe("0")

    rerender(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={() => {}} selected={true} pressed={true} ariaLabel="Better Ruins">
            card body
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    expect(within(screen.getByRole("listitem")).getByRole("button", { name: "Better Ruins" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("does not announce selected styling as pressed without an activation state", () => {
    render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={() => {}} selected ariaLabel="Installed mod">
            card body
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    expect(within(screen.getByRole("listitem")).getByRole("button", { name: "Installed mod" }).getAttribute("aria-pressed")).toBeNull()
  })

  it("falls back to its visible content as the accessible name when no ariaLabel is given", () => {
    render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={() => {}}>Plain Card</GridItem>
        </GridGroup>
      </GridWrapper>
    )

    expect(screen.getByRole("button", { name: "Plain Card" })).toBeTruthy()
  })

  it("activates onClick from the keyboard on Enter and Space, not on other keys", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={onClick} ariaLabel="Better Ruins">
            card body
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    const card = screen.getByRole("button", { name: "Better Ruins" })
    card.focus()

    await user.keyboard("{Enter}")
    expect(onClick).toHaveBeenCalledTimes(1)

    await user.keyboard(" ")
    expect(onClick).toHaveBeenCalledTimes(2)

    await user.keyboard("{Escape}")
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it("does not double-activate the card when Enter bubbles up from a focused, non-button descendant", async () => {
    // The guard this pins is event.target !== event.currentTarget in selectableItemProps.
    // A real nested <button> (ModListCard's favorite/ModDB actions) synthesizes its own click
    // on Enter and stops it from bubbling itself, same as it already does for a mouse click.
    // What only this guard catches is a focusable descendant that is not a real button, where
    // pressing Enter produces nothing but a keydown that bubbles straight to this handler.
    const user = userEvent.setup()
    const cardClick = vi.fn()
    const innerActivate = vi.fn()

    render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={cardClick} ariaLabel="Better Ruins">
            <div role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && innerActivate()}>
              nested action
            </div>
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    screen.getByRole("button", { name: "nested action" }).focus()
    await user.keyboard("{Enter}")

    expect(innerActivate).toHaveBeenCalledTimes(1)
    expect(cardClick).not.toHaveBeenCalled()
  })

  it("clicking with a mouse still works, unchanged", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <GridWrapper>
        <GridGroup>
          <GridItem onClick={onClick} ariaLabel="Better Ruins">
            card body
          </GridItem>
        </GridGroup>
      </GridWrapper>
    )

    await user.click(screen.getByRole("button", { name: "Better Ruins" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe("TableBodyRow accessibility", () => {
  function renderRow(props: Partial<React.ComponentProps<typeof TableBodyRow>> = {}): ReturnType<typeof render> {
    return render(
      <TableWrapper>
        <TableBody>
          <TableBodyRow {...props}>
            <TableCell>1.20.4</TableCell>
          </TableBodyRow>
        </TableBody>
      </TableWrapper>
    )
  }

  it("is a plain li with no onClick", () => {
    renderRow()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("exposes role=button and aria-pressed once it is clickable", () => {
    renderRow({ onClick: () => {}, selected: true })

    const row = within(screen.getByRole("listitem")).getByRole("button", { name: "1.20.4" })
    expect(row.getAttribute("aria-pressed")).toBe("true")
  })

  it("activates from the keyboard on Enter", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderRow({ onClick, selected: false })

    within(screen.getByRole("listitem")).getByRole("button", { name: "1.20.4" }).focus()
    await user.keyboard("{Enter}")

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("takes a disabled row out of the tab order and off the activation path, but keeps its state announced", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderRow({ onClick, selected: false, disabled: true })

    const row = within(screen.getByRole("listitem")).getByRole("button", { name: "1.20.4" })
    expect(row.getAttribute("tabindex")).toBe("-1")
    expect(row.getAttribute("aria-disabled")).toBe("true")

    row.focus()
    await user.keyboard("{Enter}")
    await user.click(row)

    expect(onClick).not.toHaveBeenCalled()
  })
})

describe("ModListCard accessibility", () => {
  function makeMod(): DownloadableModOnListType {
    return {
      modid: 123,
      assetid: 123,
      downloads: 42,
      follows: 7,
      trendingpoints: 0,
      comments: 1,
      name: "Better Ruins",
      summary: "More interesting ruins.",
      modidstrs: ["betterruins"],
      author: "Someone",
      urlalias: null,
      side: "both",
      type: "mod",
      logo: "",
      tags: [],
      lastreleased: ""
    }
  }

  it("announces the translated installed state without claiming the card is a toggle", () => {
    const mod = makeMod()
    const props = {
      mod,
      isFav: false,
      onSelect: vi.fn(),
      onToggleFav: vi.fn(),
      onOpenModDb: vi.fn()
    }

    const { rerender } = render(<ModListCard {...props} installed={false} />)
    const notInstalledCard = screen.getByRole("button", { name: "Better Ruins, Not installed" })
    expect(notInstalledCard.getAttribute("aria-pressed")).toBeNull()

    rerender(<ModListCard {...props} installed />)
    const installedCard = screen.getByRole("button", { name: "Better Ruins, Installed" })
    expect(installedCard.getAttribute("aria-pressed")).toBeNull()
  })

  it("keeps the card actions outside the card's role=button", () => {
    const mod = makeMod()
    const props = {
      mod,
      installed: false,
      isFav: false,
      onSelect: vi.fn(),
      onToggleFav: vi.fn(),
      onOpenModDb: vi.fn()
    }

    render(<ModListCard {...props} />)

    const card = screen.getByRole("button", { name: "Better Ruins, Not installed" })
    const listItem = screen.getByRole("listitem")
    const favorite = within(listItem).getByTitle("Favorite")
    const modDb = within(listItem).getByTitle("Open on the ModDB!")

    expect(card.className).toContain("cursor-pointer")
    expect(card.contains(favorite)).toBe(false)
    expect(card.contains(modDb)).toBe(false)
    expect(within(listItem).getAllByRole("button")).toHaveLength(3)
  })
})
