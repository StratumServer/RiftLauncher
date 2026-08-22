import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AddCustomIconPupup } from "@renderer/components/ui/AddCustomIconPupup"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import { installMockWindowApi, type MockedBridgeAPI, type WindowApiOverrides } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The picker button, then whatever the flow decided.
 *
 * Every refusal below reached the player as either the wrong sentence or no
 * sentence at all before #202, and none of them wrote a line anywhere, so each
 * row here pins both halves: the notification, and whether the log was told.
 */
async function pickIcon(overrides: WindowApiOverrides): Promise<MockedBridgeAPI> {
  const user = userEvent.setup()
  const api = installMockWindowApi(overrides)

  renderWithProviders(
    <>
      <AddCustomIconPupup open={true} setOpen={() => {}} />
      <NotificationsOverlay />
    </>
  )

  await user.click(screen.getByTitle("Select icon"))
  return api
}

/** The log lines the flow itself wrote, ignoring the config provider's own start-up line. */
function iconLogLines(api: MockedBridgeAPI): string[] {
  return vi
    .mocked(api.utils.logMessage)
    .mock.calls.filter(([, message]) => message.includes("useAddCustomIcon"))
    .map(([level, message]) => `${level}: ${message}`)
}

const pickedPath = "/home/player/Pictures/icon.png"

describe("AddCustomIconPupup refusals", () => {
  it("says a picked png is on its way in and shows its thumbnail", async () => {
    const api = await pickIcon({
      utils: { selectFolderDialog: vi.fn(async () => [pickedPath]) },
      pathsManager: { copyToIcons: vi.fn(async () => ({ status: true as const, file: "a-generated-id.png" })) }
    })

    const thumbnail = (await screen.findByAltText("Icon")) as HTMLImageElement
    expect(thumbnail.getAttribute("src")).toBe("icons:a-generated-id.png")
    expect(iconLogLines(api)).toEqual([])
  })

  it("names the format when the copy refuses a file that is not a png", async () => {
    await pickIcon({
      utils: { selectFolderDialog: vi.fn(async () => ["/home/player/Pictures/icon.jpg"]) },
      pathsManager: { copyToIcons: vi.fn(async () => ({ status: false as const, reason: "unsupported-format" as const })) }
    })

    expect(await screen.findByText("That file isn't a PNG! Custom icons have to be .png images, so convert it or pick another file.")).toBeTruthy()
  })

  it("says the file could not be read when the path policy or the disk refuses the source", async () => {
    await pickIcon({
      utils: { selectFolderDialog: vi.fn(async () => [pickedPath]) },
      pathsManager: { copyToIcons: vi.fn(async () => ({ status: false as const, reason: "source-unavailable" as const })) }
    })

    expect(await screen.findByText("RiftLauncher couldn't read that file! Move it somewhere RiftLauncher can reach, then pick it again.")).toBeTruthy()
  })

  it("logs a failed copy as well as telling the player about it", async () => {
    const api = await pickIcon({
      utils: { selectFolderDialog: vi.fn(async () => [pickedPath]) },
      pathsManager: { copyToIcons: vi.fn(async () => ({ status: false as const, reason: "copy-failed" as const })) }
    })

    expect(await screen.findByText(/That icon couldn't be copied to the icons folder!/)).toBeTruthy()
    expect(iconLogLines(api).some((line) => line.startsWith("error:"))).toBe(true)
    expect(iconLogLines(api).some((line) => line.startsWith("debug:") && line.includes("copy-failed"))).toBe(true)
  })

  it("tells the player and the log when the copy call itself rejects", async () => {
    const api = await pickIcon({
      utils: { selectFolderDialog: vi.fn(async () => [pickedPath]) },
      pathsManager: {
        copyToIcons: vi.fn(async () => {
          throw new Error("Unauthorized IPC sender")
        })
      }
    })

    expect(await screen.findByText("Something went wrong adding that icon! Restart RiftLauncher, and let us know if it keeps happening.")).toBeTruthy()
    expect(iconLogLines(api).some((line) => line.startsWith("debug:") && line.includes("bridge-failed") && line.includes("Unauthorized IPC sender"))).toBe(true)
  })

  it("tells the player and the log when the picker call itself rejects", async () => {
    const api = await pickIcon({
      utils: {
        selectFolderDialog: vi.fn(async () => {
          throw new Error("Invalid dialog extensions")
        })
      }
    })

    expect(await screen.findByText("Something went wrong adding that icon! Restart RiftLauncher, and let us know if it keeps happening.")).toBeTruthy()
    expect(iconLogLines(api).some((line) => line.startsWith("debug:") && line.includes("bridge-failed") && line.includes("Invalid dialog extensions"))).toBe(true)
  })

  it("mentions the png rule when the picker comes back with nothing", async () => {
    const api = await pickIcon({ utils: { selectFolderDialog: vi.fn(async () => []) } })

    expect(await screen.findByText(/Custom icons have to be PNG images/)).toBeTruthy()
    // A cancelled picker is a choice, not a fault: nothing to investigate later.
    expect(iconLogLines(api)).toEqual([])
  })

  it("never asks the main process to copy anything when the picker came back empty", async () => {
    const copyToIcons = vi.fn(async () => ({ status: true as const, file: "never.png" }))
    await pickIcon({ utils: { selectFolderDialog: vi.fn(async () => []) }, pathsManager: { copyToIcons } })

    expect(copyToIcons).not.toHaveBeenCalled()
  })
})
