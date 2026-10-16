import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { checkConfiguredFolder } from "@domain/config/folders"

const INSTALLATIONS = ["/data/Main", "/elsewhere/Custom"]

describe("checkConfiguredFolder", () => {
  it("refuses any configured folder placed inside an Installation, or on one", () => {
    for (const kind of ["installations", "versions", "backups"] as const) {
      assert.equal(checkConfiguredFolder(kind, "/data/Main/Backups", INSTALLATIONS), "inside-installation")
      assert.equal(checkConfiguredFolder(kind, "/data/Main", INSTALLATIONS), "inside-installation")
      assert.equal(checkConfiguredFolder(kind, "/elsewhere/Custom/deep/er/", INSTALLATIONS), "inside-installation")
    }
  })

  it("refuses a Backups folder that holds an Installation, and only that one", () => {
    assert.equal(checkConfiguredFolder("backups", "/data", INSTALLATIONS), "holds-installation")
    assert.equal(checkConfiguredFolder("installations", "/data", INSTALLATIONS), null)
    assert.equal(checkConfiguredFolder("versions", "/data", INSTALLATIONS), null)
  })

  it("accepts folders that touch no Installation, even when a name starts with an Installation's", () => {
    for (const kind of ["installations", "versions", "backups"] as const) {
      assert.equal(checkConfiguredFolder(kind, "/data/Main2", INSTALLATIONS), null)
      assert.equal(checkConfiguredFolder(kind, "/backups", INSTALLATIONS), null)
      assert.equal(checkConfiguredFolder(kind, "/backups", []), null)
    }
  })

  it("reads case the way the host does", () => {
    assert.equal(checkConfiguredFolder("backups", "C:\\DATA\\main\\Backups", ["c:/data/Main"], "win32"), "inside-installation")
    assert.equal(checkConfiguredFolder("backups", "/Users/p/MAIN/Backups", ["/Users/p/main"], "darwin"), "inside-installation")
    assert.equal(checkConfiguredFolder("backups", "/home/p/MAIN/Backups", ["/home/p/main"], "posix"), null)
  })
})
