import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { registerUserSelectedPaths } from "@src/ipc/pathPolicy"
import { makeManagedAssembly } from "../fixtures/managedAssembly"

import "@src/ipc/handlers/optimumHandlers"

/**
 * The Remove Optimum channel of src/ipc/handlers/optimumHandlers.ts, on a made-up
 * game folder. Only `electron` is mocked: the restore, the hashing and the path
 * policy are the real ones, so "the update changed the build" is decided here the
 * way it is decided for a player.
 */
type RestoreHandler = (event: IpcMainInvokeEvent, id: unknown, gameDirectory: unknown) => Promise<OptimumPatchResult>

let temporaryRoot: string
let gameDirectory: string

function sha256(text: Buffer): string {
  return createHash("sha256").update(text).digest("hex")
}

const original = (build: string, name: string): Buffer => makeManagedAssembly(["System.Runtime"], [`original ${build} ${name}`])
const patched = (name: string): Buffer => makeManagedAssembly(["System.Runtime", "Optimum.Api.Contracts"], [`overlay 0.3.20 ${name}`])

function write(path: string[], contents: string | Buffer): void {
  const full = join(gameDirectory, ...path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, contents)
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "optimum-handlers-"))
  mkdirSync(join(temporaryRoot, "userData"), { recursive: true })
  setElectronUserDataPath(join(temporaryRoot, "userData"))
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

beforeEach(() => {
  gameDirectory = join(temporaryRoot, `game-${Math.random().toString(36).slice(2)}`)
  write(["VintagestoryLib.dll"], patched("lib"))
  write(["VintagestoryAPI.dll"], patched("api"))
  write(["Optimum.Api.Contracts.dll"], "contracts")
  write([".optimum", "vanilla", "VintagestoryLib.vanilla.dll"], original("1.22.7", "lib"))
  write([".optimum", "vanilla", "VintagestoryAPI.vanilla.dll"], original("1.22.7", "api"))
  write(
    [".optimum", "manifest.json"],
    JSON.stringify({
      optimumVersion: "0.3.20",
      targets: [
        { assembly: "VintagestoryLib.dll", patchedHash: `sha256:${sha256(patched("lib"))}` },
        { assembly: "VintagestoryAPI.dll", patchedHash: `sha256:${sha256(patched("api"))}` }
      ]
    })
  )
  registerUserSelectedPaths([gameDirectory])
})

function restore(): Promise<OptimumPatchResult> {
  return createTrustedEvent().then((event) => getIpcHandler<RestoreHandler>(IPC_CHANNELS.OPTIMUM_MANAGER.RESTORE_VANILLA)(event, "task-1", gameDirectory))
}

describe("RESTORE_VANILLA", () => {
  it("throws Unauthorized IPC sender for an untrusted caller", async () => {
    await assert.rejects(() => getIpcHandler<RestoreHandler>(IPC_CHANNELS.OPTIMUM_MANAGER.RESTORE_VANILLA)(createUntrustedEvent(), "task-1", gameDirectory), /Unauthorized IPC sender/)
  })

  it("puts the originals back on a build that still carries the patch", async () => {
    assert.deepEqual(await restore(), { ok: true })
    assert.deepEqual(readFileSync(join(gameDirectory, "VintagestoryLib.dll")), original("1.22.7", "lib"))
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
  })

  it("does not write the older backups over a build the official installer updated in place, and clears what Optimum left", async () => {
    write(["VintagestoryLib.dll"], original("1.22.8", "lib"))
    write(["VintagestoryAPI.dll"], original("1.22.8", "api"))

    assert.deepEqual(await restore(), { ok: true, buildUpdated: true })
    assert.deepEqual(readFileSync(join(gameDirectory, "VintagestoryLib.dll")), original("1.22.8", "lib"))
    assert.equal(existsSync(join(gameDirectory, ".optimum")), false)
    assert.equal(existsSync(join(gameDirectory, "Optimum.Api.Contracts.dll")), false)
  })

  it("refuses a build where only one assembly was replaced by the update, and keeps its files and the backups", async () => {
    write(["VintagestoryLib.dll"], original("1.22.8", "lib"))

    assert.deepEqual(await restore(), { ok: false, reason: "build-unrecognized" })
    assert.deepEqual(readFileSync(join(gameDirectory, "VintagestoryLib.dll")), original("1.22.8", "lib"))
    assert.deepEqual(readFileSync(join(gameDirectory, ".optimum", "vanilla", "VintagestoryLib.vanilla.dll")), original("1.22.7", "lib"))
  })
})
