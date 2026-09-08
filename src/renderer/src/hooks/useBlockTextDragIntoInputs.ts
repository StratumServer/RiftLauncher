import { useEffect } from "react"

/**
 * Blocks dragging selected page text into text fields (issue #395). By default a browser lets
 * the user select any static text on the page (labels, headings, button text, ...), drag it,
 * and drop it into an <input>/<textarea>, filling the field with text they never typed.
 *
 * This only cancels drags that *start* outside a field, so dragging text you are already
 * editing within an input/textarea keeps working, and text stays selectable/copyable since
 * nothing here touches selection or `user-select`.
 */
export function useBlockTextDragIntoInputs(): void {
  useEffect(() => {
    function handleDragStart(event: DragEvent): void {
      const startsInField = (event.target as Element | null)?.closest?.("input, textarea") != null
      if (!startsInField) event.preventDefault()
    }

    document.addEventListener("dragstart", handleDragStart)
    return (): void => document.removeEventListener("dragstart", handleDragStart)
  }, [])
}
