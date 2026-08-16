import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MODS_FOLDER_NAME, modsFolder } from "../../../src/domain/mods/folder"
import type { PathBuilder } from "../../../src/domain/ports"

const windowsPaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("\\") }
const posixPaths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }

describe("modsFolder", () => {
  it("appends the folder the game loads mods from", async () => {
    assert.equal(await modsFolder(posixPaths, "/home/user/.vs/installations/main"), "/home/user/.vs/installations/main/Mods")
  })

  it("leaves the joining to the host, separator included", async () => {
    assert.equal(await modsFolder(windowsPaths, "C:\\Users\\me\\VS\\main"), "C:\\Users\\me\\VS\\main\\Mods")
  })

  it("spells the folder the way the game does", () => {
    assert.equal(MODS_FOLDER_NAME, "Mods")
  })
})
