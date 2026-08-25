import { describe, expect, it } from "vitest"

import { backgroundThumbnailSource } from "@renderer/utils/backgroundThumbnail"

describe("backgroundThumbnailSource", () => {
  it("builds a remote source from the manifest thumbnail path", () => {
    expect(backgroundThumbnailSource("thumbnails/village-lane.jpg")).toBe("https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/thumbnails/village-lane.jpg")
  })

  it("returns no preview when an older manifest row has no thumbnail", () => {
    expect(backgroundThumbnailSource(undefined)).toBeUndefined()
  })
})
