import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { assertAllowedApiUrl, getApiUrlMaxBytes, MAX_BACKGROUND_IMAGE_BYTES, MAX_BACKGROUND_MANIFEST_BYTES, MAX_MODS_CATALOG_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../../src/ipc/validation"
import { BACKGROUNDS_MANIFEST_URL, backgroundImageUrl, backgroundThumbnailUrl } from "../../src/domain/backgrounds"

describe("per-endpoint response ceilings (issue #24)", () => {
  it("keeps the generic 4 MB ceiling for ordinary allow-listed API endpoints", () => {
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/tags")), MAX_RESPONSE_BYTES)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/authors")), MAX_RESPONSE_BYTES)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/gameversions")), MAX_RESPONSE_BYTES)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/mod/123")), MAX_RESPONSE_BYTES)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://auth3.vintagestory.at/v2/gamelogin")), MAX_RESPONSE_BYTES)
  })

  it("raises the ceiling only for the mods-catalog listing endpoint", () => {
    assert.equal(MAX_MODS_CATALOG_RESPONSE_BYTES, 16 * 1024 * 1024)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/mods")), MAX_MODS_CATALOG_RESPONSE_BYTES)
    // Search filters must not fall back to the generic ceiling.
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl("https://mods.vintagestory.at/api/mods?text=foo&orderby=follows")), MAX_MODS_CATALOG_RESPONSE_BYTES)
  })

  it("still rejects URLs that are not on the API allow-list", () => {
    assert.throws(() => assertAllowedApiUrl("https://example.com/api/mods"), /URL is not allowed/)
    assert.throws(() => assertAllowedApiUrl("http://mods.vintagestory.at/api/mods"), /Invalid URL/)
  })
})

describe("the background catalog rules (issue #192)", () => {
  it("admits the manifest and the scenes beside it on the backgrounds branch", () => {
    assert.equal(assertAllowedApiUrl(BACKGROUNDS_MANIFEST_URL).hostname, "raw.githubusercontent.com")
    assert.equal(assertAllowedApiUrl(backgroundImageUrl("village-lane.jpg")).pathname, "/StratumServer/RiftLauncher/backgrounds/village-lane.jpg")
    assert.equal(assertAllowedApiUrl(backgroundThumbnailUrl("thumbnails/village-lane.jpg")).pathname, "/StratumServer/RiftLauncher/backgrounds/thumbnails/village-lane.jpg")
  })

  it("refuses everything else raw.githubusercontent.com serves", () => {
    // Another branch of this same repository, another repository entirely, and the prefix used as
    // a bare string rather than a path segment, which is what a `startsWith` check would let past.
    assert.throws(() => assertAllowedApiUrl("https://raw.githubusercontent.com/StratumServer/RiftLauncher/dev/package.json"), /URL is not allowed/)
    assert.throws(() => assertAllowedApiUrl("https://raw.githubusercontent.com/attacker/RiftLauncher/backgrounds/manifest.json"), /URL is not allowed/)
    assert.throws(() => assertAllowedApiUrl("https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds-evil/payload.jpg"), /URL is not allowed/)
    assert.throws(() => assertAllowedApiUrl("http://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/manifest.json"), /Invalid URL/)
  })

  it("caps the manifest far tighter than the images, and both under the generic ceiling", () => {
    assert.equal(MAX_BACKGROUND_MANIFEST_BYTES, 32 * 1024)
    assert.equal(MAX_BACKGROUND_IMAGE_BYTES, 2 * 1024 * 1024)

    // The manifest rule is listed first precisely so its ceiling wins the match: a path that both
    // rules cover must get the small one, not the image one.
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl(BACKGROUNDS_MANIFEST_URL)), MAX_BACKGROUND_MANIFEST_BYTES)
    assert.equal(getApiUrlMaxBytes(assertAllowedApiUrl(backgroundImageUrl("village-lane.jpg"))), MAX_BACKGROUND_IMAGE_BYTES)
    assert.ok(MAX_BACKGROUND_IMAGE_BYTES < MAX_RESPONSE_BYTES)
  })
})
