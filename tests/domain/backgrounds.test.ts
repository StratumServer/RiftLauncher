import assert from "node:assert/strict"
import { describe, it } from "vitest"

import {
  backgroundCacheFileName,
  backgroundImageUrl,
  backgroundThumbnailUrl,
  BACKGROUNDS_MANIFEST_URL,
  CUSTOM_BACKGROUND_ID,
  DEFAULT_BACKGROUND_ID,
  isBackgroundFileName,
  isBackgroundSha256,
  isBackgroundThumbnailFileName,
  isBackgroundId,
  isCatalogBackgroundId,
  isJpegBytes,
  isPngBytes,
  normalizeBackgroundId,
  parseBackgroundManifest
} from "@domain/backgrounds"

function entry(overrides: Partial<BackgroundType> = {}): BackgroundType {
  return { id: "village-lane", name: "Village Lane", file: "village-lane.jpg", sha256: "a".repeat(64), ...overrides }
}

describe("background ids", () => {
  it("accepts the two reserved ids and well-formed slugs", () => {
    for (const id of [DEFAULT_BACKGROUND_ID, CUSTOM_BACKGROUND_ID, "village-lane", "a", "a1", "scene-2024-12-04"]) {
      assert.equal(isBackgroundId(id), true, id)
    }
  })

  it("refuses anything that could name something other than a file in the cache", () => {
    for (const id of ["", ".", "..", "../secret", "a/b", "a\\b", "Village-Lane", "village lane", "village_lane", "-lead", "trail-", "a".repeat(65), 3, null, undefined, {}]) {
      assert.equal(isBackgroundId(id), false, String(id))
    }
  })

  it("keeps the reserved ids out of the catalog", () => {
    assert.equal(isCatalogBackgroundId("village-lane"), true)
    assert.equal(isCatalogBackgroundId(DEFAULT_BACKGROUND_ID), false)
    assert.equal(isCatalogBackgroundId(CUSTOM_BACKGROUND_ID), false)
  })

  it("normalizes anything unusable to the bundled default", () => {
    assert.equal(normalizeBackgroundId("village-lane"), "village-lane")
    assert.equal(normalizeBackgroundId(CUSTOM_BACKGROUND_ID), CUSTOM_BACKGROUND_ID)
    assert.equal(normalizeBackgroundId(undefined), DEFAULT_BACKGROUND_ID)
    assert.equal(normalizeBackgroundId("../../etc/passwd"), DEFAULT_BACKGROUND_ID)
  })

  it("caches every scene under its own id, whatever it was called on the branch", () => {
    assert.equal(backgroundCacheFileName("village-lane"), "village-lane.jpg")
    assert.equal(backgroundCacheFileName(CUSTOM_BACKGROUND_ID), "custom.jpg")
  })
})

describe("background file names and URLs", () => {
  it("accepts a plain slug with a .jpg extension and nothing else", () => {
    assert.equal(isBackgroundFileName("village-lane.jpg"), true)
    assert.equal(isBackgroundFileName("village-lane.jpeg"), false)
    assert.equal(isBackgroundFileName("village-lane.JPG"), false)
    assert.equal(isBackgroundFileName("nested/village-lane.jpg"), false)
    assert.equal(isBackgroundFileName("../village-lane.jpg"), false)
    assert.equal(isBackgroundFileName("village-lane.jpg.exe"), false)
    assert.equal(isBackgroundFileName(7), false)
  })

  it("accepts only thumbnails inside the branch thumbnail directory", () => {
    assert.equal(isBackgroundThumbnailFileName("thumbnails/village-lane.jpg"), true)
    for (const value of [
      "village-lane.jpg",
      "evil/thumbnails/x.jpg",
      "thumbnails/../village-lane.jpg",
      "thumbnails/nested/village-lane.jpg",
      "thumbnails/x.jpg/../../evil.jpg",
      `thumbnails/${"a".repeat(65)}.jpg`,
      "thumbnails/village-lane.png",
      "thumbnails/Village-Lane.jpg",
      7
    ]) {
      assert.equal(isBackgroundThumbnailFileName(value), false, String(value))
    }
  })

  it("builds the catalog URLs off the backgrounds branch of this repository", () => {
    assert.equal(BACKGROUNDS_MANIFEST_URL, "https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/manifest.json")
    assert.equal(backgroundImageUrl("village-lane.jpg"), "https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/village-lane.jpg")
    assert.equal(backgroundThumbnailUrl("thumbnails/village-lane.jpg"), "https://raw.githubusercontent.com/StratumServer/RiftLauncher/backgrounds/thumbnails/village-lane.jpg")
  })
})

describe("background hashes", () => {
  it("accepts exactly one SHA-256 digest", () => {
    assert.equal(isBackgroundSha256("a".repeat(64)), true)
    assert.equal(isBackgroundSha256("A".repeat(64)), true)
    for (const value of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "a".repeat(64) + "\n", 7]) {
      assert.equal(isBackgroundSha256(value), false, String(value))
    }
  })
})

describe("parseBackgroundManifest", () => {
  it("reads the rows a well-formed manifest carries, in order", () => {
    const entries = parseBackgroundManifest(
      JSON.stringify([
        entry({ thumbnail: "thumbnails/village-lane.jpg" }),
        entry({ id: "river-sailboat", name: "River Sailboat", file: "river-sailboat.jpg", thumbnail: "thumbnails/river-sailboat.jpg" })
      ])
    )

    assert.deepEqual(
      entries.map((e) => e.id),
      ["village-lane", "river-sailboat"]
    )
    assert.equal(entries[0]!.name, "Village Lane")
    assert.equal(entries[0]!.file, "village-lane.jpg")
    assert.equal(entries[0]!.thumbnail, "thumbnails/village-lane.jpg")
    assert.equal(entries[0]!.sha256, "a".repeat(64))
    assert.equal(entries[1]!.thumbnail, "thumbnails/river-sailboat.jpg")
  })

  it("keeps older rows without a hash usable during the manifest rollout", () => {
    const [parsed] = parseBackgroundManifest(JSON.stringify([entry({ sha256: undefined })]))

    assert.deepEqual(parsed, { id: "village-lane", name: "Village Lane", file: "village-lane.jpg" })
  })

  it("normalizes an uppercase hash and drops a malformed one", () => {
    const parsed = parseBackgroundManifest(JSON.stringify([entry({ id: "upper", file: "upper.jpg", sha256: "B".repeat(64) }), entry({ id: "bad", file: "bad.jpg", sha256: "not-a-hash" })]))

    assert.equal(parsed[0]!.sha256, "b".repeat(64))
    assert.deepEqual(
      parsed.map((item) => item.id),
      ["upper"]
    )
  })

  it("ignores an unsafe thumbnail path without dropping the usable scene", () => {
    const [parsed] = parseBackgroundManifest(JSON.stringify([entry({ thumbnail: "../../outside.jpg" })]))

    assert.equal(parsed?.id, "village-lane")
    assert.equal(parsed?.thumbnail, undefined)
  })

  it("answers with an empty list for anything that is not an array of rows", () => {
    for (const text of ["", "not json", "null", "7", '"a string"', '{"backgrounds":[]}']) {
      assert.deepEqual(parseBackgroundManifest(text), [], text)
    }
  })

  it("drops a bad row without losing the good ones beside it", () => {
    const entries = parseBackgroundManifest(
      JSON.stringify([
        "nope",
        null,
        entry({ id: "../escape" }),
        entry({ file: "../../etc/passwd" }),
        entry({ file: "elsewhere.png" }),
        entry({ name: "" }),
        entry({ name: "x".repeat(65) }),
        entry({ sha256: "not-a-hash" }),
        entry({ id: DEFAULT_BACKGROUND_ID }),
        entry({ id: CUSTOM_BACKGROUND_ID }),
        entry()
      ])
    )

    assert.deepEqual(
      entries.map((e) => e.id),
      ["village-lane"]
    )
  })

  it("keeps the first row of a duplicated id and caps the list at 64", () => {
    const duplicated = parseBackgroundManifest(JSON.stringify([entry({ name: "First" }), entry({ name: "Second" })]))
    assert.equal(duplicated.length, 1)
    assert.equal(duplicated[0]!.name, "First")

    const many = Array.from({ length: 70 }, (_, i) => entry({ id: `scene-${i}`, file: `scene-${i}.jpg` }))
    assert.equal(parseBackgroundManifest(JSON.stringify(many)).length, 64)
  })
})

describe("isJpegBytes", () => {
  it("recognises the JPEG start-of-image marker and nothing else", () => {
    assert.equal(isJpegBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), true)
    // A PNG, a truncated marker, and an empty file: all named .jpg, none of them one.
    assert.equal(isJpegBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), false)
    assert.equal(isJpegBytes(Uint8Array.from([0xff, 0xd8, 0xff])), false)
    assert.equal(isJpegBytes(Uint8Array.from([])), false)
  })
})

describe("isPngBytes", () => {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  it("recognises the PNG signature and nothing else", () => {
    assert.equal(isPngBytes(Uint8Array.from([...SIGNATURE, 0x00, 0x00])), true)
    // A JPEG, the signature one byte short, a signature with a byte flipped,
    // and an empty file: all named .png, none of them one.
    assert.equal(isPngBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])), false)
    assert.equal(isPngBytes(Uint8Array.from(SIGNATURE.slice(0, 7))), false)
    assert.equal(isPngBytes(Uint8Array.from([...SIGNATURE.slice(0, 7), 0x0b])), false)
    assert.equal(isPngBytes(Uint8Array.from([])), false)
  })
})
