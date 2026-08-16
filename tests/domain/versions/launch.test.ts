import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { MESA_GL_THREAD_VARIABLE, buildGameLaunchPlan } from "../../../src/domain/versions/launch"
import type { BuildGameLaunchPlanInput, GameLaunchPlan } from "../../../src/domain/versions/launch"
import type { PathBuilder } from "../../../src/domain/ports"

const VERSION_FOLDER = "/games/1.20.4"
const INSTALLATION_PATH = "/data/survival"

const paths: PathBuilder = { join: async (parts: string[]): Promise<string> => parts.join("/") }

function input(overrides: Partial<BuildGameLaunchPlanInput> = {}): BuildGameLaunchPlanInput {
  return {
    platform: "linux",
    versionFolder: VERSION_FOLDER,
    fileNames: ["Vintagestory"],
    installationPath: INSTALLATION_PATH,
    startParams: "",
    mesaGlThread: false,
    ...overrides
  }
}

/** The plan, or a failed assertion naming the refusal that came instead. */
async function planFor(overrides: Partial<BuildGameLaunchPlanInput> = {}): Promise<GameLaunchPlan> {
  const result = await buildGameLaunchPlan({ paths }, input(overrides))
  if (!result.ok) assert.fail(`expected a plan, got ${result.reason}`)
  return result.plan
}

describe("buildGameLaunchPlan executable selection", () => {
  it("runs the native Linux launcher directly when it is present", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory", "readme.txt"] })

    assert.equal(plan.command, `${VERSION_FOLDER}/Vintagestory`)
    assert.equal(plan.executablePath, `${VERSION_FOLDER}/Vintagestory`)
  })

  it("prefers the native Linux launcher over the mono fallback when both are present", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory", "Vintagestory.exe"] })

    assert.equal(plan.command, `${VERSION_FOLDER}/Vintagestory`)
  })

  it("falls back to mono on Linux when only the .exe is there", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory.exe"] })

    assert.equal(plan.command, "mono")
    assert.equal(plan.executablePath, `${VERSION_FOLDER}/Vintagestory.exe`)
  })

  it("runs the Windows executable directly, never through mono", async () => {
    const plan = await planFor({ platform: "win32", fileNames: ["Vintagestory.exe"] })

    assert.equal(plan.command, `${VERSION_FOLDER}/Vintagestory.exe`)
  })

  it("ignores the native Linux launcher name on Windows", async () => {
    const result = await buildGameLaunchPlan({ paths }, input({ platform: "win32", fileNames: ["Vintagestory"] }))

    assert.deepEqual(result, { ok: false, reason: "no-executable" })
  })

  it("refuses a version folder holding none of the expected executables", async () => {
    const result = await buildGameLaunchPlan({ paths }, input({ fileNames: ["readme.txt"] }))

    assert.deepEqual(result, { ok: false, reason: "no-executable" })
  })

  it("refuses macOS, which the launcher has never been able to start the game on", async () => {
    const result = await buildGameLaunchPlan({ paths }, input({ platform: "darwin", fileNames: ["Vintagestory"] }))

    assert.deepEqual(result, { ok: false, reason: "unsupported-platform" })
  })

  it("refuses an unrecognised platform instead of treating it as Linux", async () => {
    const result = await buildGameLaunchPlan({ paths }, input({ platform: "freebsd", fileNames: ["Vintagestory"] }))

    assert.deepEqual(result, { ok: false, reason: "unsupported-platform" })
  })
})

describe("buildGameLaunchPlan arguments", () => {
  it("points the game at the installation folder and passes the start parameters", async () => {
    const plan = await planFor({ startParams: "--openWorld" })

    assert.deepEqual(plan.args, [`--dataPath=${INSTALLATION_PATH}`, "--openWorld"])
  })

  it("passes the start parameters as ONE argument, spaces and all", async () => {
    const plan = await planFor({ startParams: "--one --two three" })

    assert.deepEqual(plan.args, [`--dataPath=${INSTALLATION_PATH}`, "--one --two three"])
  })

  it("still passes an argument for empty start parameters", async () => {
    const plan = await planFor({ startParams: "" })

    assert.deepEqual(plan.args, [`--dataPath=${INSTALLATION_PATH}`, ""])
  })

  it("puts the executable ahead of everything else under mono", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory.exe"], startParams: "--openWorld" })

    assert.deepEqual(plan.args, [`${VERSION_FOLDER}/Vintagestory.exe`, `--dataPath=${INSTALLATION_PATH}`, "--openWorld"])
  })

  it("runs the game from the version folder", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory.exe"] })

    assert.equal(plan.cwd, VERSION_FOLDER)
  })
})

describe("buildGameLaunchPlan environment", () => {
  it("adds nothing when the installation does not ask for the Mesa GL thread", async () => {
    const plan = await planFor({ mesaGlThread: false })

    assert.deepEqual(plan.env, {})
  })

  it("sets the Mesa GL thread variable for the native Linux launcher, spelled the way Mesa reads it", async () => {
    // Pinned against the literal, not just the imported constant: asserting
    // `{ [MESA_GL_THREAD_VARIABLE]: "true" }` alone would pass no matter what
    // the constant said, uppercase included, since both sides would still be
    // the same symbol. Issue #60 found exactly that: the constant spelled
    // MESA_GLTHREAD, Mesa reads mesa_glthread, and this test never noticed.
    assert.equal(MESA_GL_THREAD_VARIABLE, "mesa_glthread")

    const plan = await planFor({ mesaGlThread: true })

    assert.deepEqual(plan.env, { [MESA_GL_THREAD_VARIABLE]: "true" })
  })

  it("leaves the mono fallback without the Mesa GL thread variable, as it always has been", async () => {
    const plan = await planFor({ fileNames: ["Vintagestory.exe"], mesaGlThread: true })

    assert.deepEqual(plan.env, {})
  })

  it("never sets the Mesa GL thread variable on Windows", async () => {
    const plan = await planFor({ platform: "win32", fileNames: ["Vintagestory.exe"], mesaGlThread: true })

    assert.deepEqual(plan.env, {})
  })
})
