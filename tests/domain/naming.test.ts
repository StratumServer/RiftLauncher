import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { cleanFolderName } from "../../src/domain/naming"

describe("cleanFolderName", () => {
  it("replaces characters a folder name cannot carry", () => {
    assert.equal(cleanFolderName('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j")
  })

  it("turns whitespace runs into a single dash", () => {
    assert.equal(cleanFolderName("My  great \t installation"), "My-great-installation")
  })

  it("collapses repeated dashes and trims the edges", () => {
    assert.equal(cleanFolderName("--My--Install--"), "My-Install")
  })

  it("leaves dots alone, which is why formatted dates survive intact", () => {
    assert.equal(cleanFolderName("1.755.300.000.000"), "1.755.300.000.000")
  })

  it("can return an empty string", () => {
    assert.equal(cleanFolderName("   "), "")
  })
})
