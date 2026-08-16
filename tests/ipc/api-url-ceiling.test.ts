import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { assertAllowedApiUrl, getApiUrlMaxBytes, MAX_MODS_CATALOG_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from "../../src/ipc/validation"

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
