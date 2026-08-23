import { describe, expect, it } from "vitest"

import { INSTALLATION_ICONS, installationIconSrc } from "@renderer/utils/installationIcons"

/**
 * Lives with the DOM tests because the icon list imports the bundled PNGs,
 * which only resolve under the renderer's own alias and asset handling.
 */
describe("installationIconSrc", () => {
  const custom = { id: "custom-1", name: "Mine", icon: "abc.png" }

  it("answers a built-in icon with its own bundled source", () => {
    expect(installationIconSrc("bookshelf", [])).toBe(INSTALLATION_ICONS[1]!.icon)
  })

  it("reaches a custom icon through the icons protocol", () => {
    expect(installationIconSrc("custom-1", [custom])).toBe("icons:abc.png")
  })

  it("falls back to the first built-in when the id names nothing", () => {
    expect(installationIconSrc("deleted-long-ago", [custom])).toBe(INSTALLATION_ICONS[0].icon)
  })

  it("keeps the built-in when a custom icon claims the same id", () => {
    expect(installationIconSrc("basalt", [{ id: "basalt", name: "Shadow", icon: "shadow.png" }])).toBe(INSTALLATION_ICONS[0].icon)
  })
})
