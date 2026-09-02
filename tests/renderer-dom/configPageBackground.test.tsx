import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import ConfigPage from "@renderer/features/config/pages/ConfigPage"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { backgroundThumbnailSource } from "@renderer/utils/backgroundThumbnail"

import { createMockConfig, installMockWindowApi, type MockedBridgeAPI } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

const CATALOG_FAILED = "The background list couldn't be loaded. Check your connection and try again."
const PICKED_PATH = "/home/player/pictures/sunset.jpg"

const MANIFEST = JSON.stringify([
  { id: "village-lane", name: "Village Lane", file: "village-lane.jpg", thumbnail: "thumbnails/village-lane.jpg", sha256: "a".repeat(64) },
  { id: "river-sailboat", name: "River Sailboat", file: "river-sailboat.jpg", thumbnail: "thumbnails/river-sailboat.jpg", sha256: "b".repeat(64) }
])

type Options = {
  manifest?: () => Promise<string>
  ensureBackground?: () => Promise<boolean>
  copyCustomBackground?: () => Promise<boolean>
  selectFolderDialog?: () => Promise<string[]>
  background?: string
}

const catalogManifest = async (): Promise<string> => MANIFEST
const downloadWorks = async (): Promise<boolean> => true
const copyWorks = async (): Promise<boolean> => true
const dialogPicks = async (): Promise<string[]> => [PICKED_PATH]

function renderConfigPage({
  manifest = catalogManifest,
  ensureBackground = downloadWorks,
  copyCustomBackground = copyWorks,
  selectFolderDialog = dialogPicks,
  background = "default"
}: Options = {}): MockedBridgeAPI {
  const api = installMockWindowApi({
    configManager: { getConfig: async () => createMockConfig({ background }) },
    netManager: { queryURL: vi.fn(manifest) },
    utils: { selectFolderDialog: vi.fn(selectFolderDialog) },
    backgroundsManager: { ensureBackground: vi.fn(ensureBackground), copyCustomBackground: vi.fn(copyCustomBackground) }
  })

  renderWithProviders(
    <>
      <ConfigPage />
      <NotificationsOverlay />
    </>,
    { route: "/config" }
  )
  return api
}

/** The image inside a tile, found through the tile's own label. */
function tileImage(name: string): HTMLImageElement | null {
  return screen.getByRole("button", { name }).querySelector("img")
}

// The applied background lives on the root element, which jsdom keeps for the whole file.
beforeEach(() => {
  document.documentElement.style.removeProperty("--background-image-image-vs")
})

describe("ConfigPage background picker", () => {
  it("renders catalog tiles with eager remote thumbnails", async () => {
    renderConfigPage()

    expect(await screen.findByRole("button", { name: "Village Lane" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "River Sailboat" })).toBeTruthy()
    expect(tileImage("Village Lane")?.getAttribute("src")).toBe(backgroundThumbnailSource("thumbnails/village-lane.jpg"))
    expect(tileImage("Village Lane")?.getAttribute("loading")).toBe("eager")
    expect(tileImage("Village Lane")?.getAttribute("decoding")).toBe("async")
    expect(tileImage("River Sailboat")?.getAttribute("src")).toBe(backgroundThumbnailSource("thumbnails/river-sailboat.jpg"))

    // The bundled scene and the player's own slot sit in the same grid, and neither comes from the
    // manifest, so they are there whatever the branch lists.
    expect(screen.getByRole("button", { name: "Default" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Your own image" })).toBeTruthy()
  })

  it("keeps a catalog tile usable when the manifest has no preview", async () => {
    renderConfigPage({ manifest: async () => JSON.stringify([{ id: "village-lane", name: "Village Lane", file: "village-lane.jpg" }]) })

    expect(await screen.findByRole("button", { name: "Village Lane" })).toBeTruthy()
    expect(tileImage("Village Lane")).toBeNull()
  })

  it("does not fetch the manifest until the settings page is mounted", async () => {
    const api = installMockWindowApi({ netManager: { queryURL: vi.fn(async () => MANIFEST) } })

    renderWithProviders(<div />, { route: "/config" })
    await waitFor(() => expect(api.configManager.getConfig).toHaveBeenCalled())

    expect(api.netManager.queryURL).not.toHaveBeenCalled()
  })

  it("downloads the scene, then selects it and paints it", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    await user.click(await screen.findByRole("button", { name: "Village Lane" }))

    await waitFor(() => expect(api.backgroundsManager.ensureBackground).toHaveBeenCalledWith("village-lane", "village-lane.jpg", "a".repeat(64)))
    await waitFor(() => expect(screen.getByRole("button", { name: "Village Lane" }).getAttribute("aria-pressed")).toBe("true"))
    expect(tileImage("Village Lane")?.getAttribute("src")).toBe(backgroundThumbnailSource("thumbnails/village-lane.jpg"))
    expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toContain('url("background:village-lane.jpg?r=1")')
  })

  it("selects nothing when the download fails, and says so", async () => {
    const user = userEvent.setup()
    renderConfigPage({ ensureBackground: async () => false })

    await user.click(await screen.findByRole("button", { name: "Village Lane" }))

    expect(await screen.findByText("That background couldn't be downloaded. Check your connection and try again.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Village Lane" }).getAttribute("aria-pressed")).toBe("false")
    expect(tileImage("Village Lane")?.getAttribute("src")).toBe(backgroundThumbnailSource("thumbnails/village-lane.jpg"))
  })

  it("hides a failed thumbnail without disabling the scene tile", async () => {
    renderConfigPage()

    const image = await screen.findByRole("button", { name: "Village Lane" }).then(() => tileImage("Village Lane"))
    expect(image).toBeTruthy()
    fireEvent.error(image!)

    expect(tileImage("Village Lane")).toBeNull()
    expect(screen.getByRole("button", { name: "Village Lane" })).toBeTruthy()
  })

  it("shows the failure and a retry rather than an endless spinner when the manifest cannot be read", async () => {
    const user = userEvent.setup()
    let attempts = 0

    renderConfigPage({
      manifest: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("Network request timed out")
        return MANIFEST
      }
    })

    expect(await screen.findByText(CATALOG_FAILED)).toBeTruthy()

    // A second attempt that lands renders the grid as if the first had never failed.
    await user.click(screen.getByRole("button", { name: "Reload" }))

    expect(await screen.findByRole("button", { name: "Village Lane" })).toBeTruthy()
    expect(screen.queryByText(CATALOG_FAILED)).toBeNull()
  })

  it("treats a manifest that parses into nothing usable as a failure too", async () => {
    renderConfigPage({ manifest: async () => '[{"id":"../escape","name":"Escape","file":"../../etc/passwd"}]' })

    expect(await screen.findByText(CATALOG_FAILED)).toBeTruthy()
  })

  it("copies the picked image and applies it", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    await user.click(await screen.findByRole("button", { name: "Your own image" }))

    await waitFor(() => expect(api.utils.selectFolderDialog).toHaveBeenCalledWith({ type: "file", extensions: ["jpg", "jpeg"] }))
    await waitFor(() => expect(api.backgroundsManager.copyCustomBackground).toHaveBeenCalledWith(PICKED_PATH))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toContain('url("background:custom.jpg?r=1")'))
  })

  it("repaints on a re-pick, even though the id and the cached file name never change", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    const ownImage = await screen.findByRole("button", { name: "Your own image" })
    await user.click(ownImage)
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toContain("?r=1"))

    await user.click(ownImage)

    await waitFor(() => expect(api.backgroundsManager.copyCustomBackground).toHaveBeenCalledTimes(2))
    // Same id, same file on disk, different URL: without this the renderer would keep showing the
    // picture that name used to hold.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toContain("?r=2"))
  })

  it("says so and changes nothing when the picked image is refused", async () => {
    const user = userEvent.setup()
    renderConfigPage({ copyCustomBackground: async () => false })

    await user.click(await screen.findByRole("button", { name: "Your own image" }))

    expect(await screen.findByText("That image couldn't be used as a background. It has to be a JPEG under 2 MB.")).toBeTruthy()
    expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toBe("")
  })

  it("re-downloads the selected scene when the section opens, in case its cached file went missing", async () => {
    const api = renderConfigPage({ background: "river-sailboat" })

    await waitFor(() => expect(api.backgroundsManager.ensureBackground).toHaveBeenCalledWith("river-sailboat", "river-sailboat.jpg", "b".repeat(64)))
    expect(tileImage("River Sailboat")?.getAttribute("src")).toBe(backgroundThumbnailSource("thumbnails/river-sailboat.jpg"))
    expect(api.backgroundsManager.ensureBackground).toHaveBeenCalledTimes(1)
  })

  it("keeps the selected thumbnail visible when repairing its full-size cache fails", async () => {
    let finishRepair: (cached: boolean) => void = () => undefined
    const repair = new Promise<boolean>((resolve) => {
      finishRepair = resolve
    })
    const api = renderConfigPage({ background: "river-sailboat", ensureBackground: () => repair })

    await waitFor(() => expect(api.backgroundsManager.ensureBackground).toHaveBeenCalledWith("river-sailboat", "river-sailboat.jpg", "b".repeat(64)))
    finishRepair(false)

    await waitFor(() => expect(tileImage("River Sailboat")).toBeTruthy())
    expect(screen.getByRole("button", { name: "River Sailboat" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("shows a replacement after a failed image when its source changes", async () => {
    const user = userEvent.setup()
    const api = renderConfigPage()

    const ownImage = await screen.findByRole("button", { name: "Your own image" })
    await user.click(ownImage)
    const failedImage = await waitFor(() => {
      const image = tileImage("Your own image")
      expect(image).toBeTruthy()
      return image!
    })
    fireEvent.error(failedImage)
    expect(tileImage("Your own image")).toBeNull()

    await user.click(ownImage)
    await waitFor(() => expect(api.backgroundsManager.copyCustomBackground).toHaveBeenCalledTimes(2))
    expect(tileImage("Your own image")).toBeTruthy()
  })

  it("goes back to the bundled scene, which clears the override entirely", async () => {
    const user = userEvent.setup()
    renderConfigPage({ background: "village-lane" })

    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toContain("village-lane"))

    await user.click(await screen.findByRole("button", { name: "Default" }))

    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background-image-image-vs")).toBe(""))
  })
})
