import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import yauzl from "yauzl"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

/**
 * scripts/headless/seed.mjs against the repo's own config normalizer.
 *
 * seed.mjs is a dependency-free Node script, run out of process exactly the way a developer
 * or a reviewer runs it, so this never re-implements what it does: it spawns the real script,
 * then feeds the config.json it wrote through `normalizeConfig` (src/config/configManager.ts),
 * the same function the launcher itself runs on every read. That is what "cannot drift from the
 * schema" means here: if a future config field is added or a field's shape changes and the seed
 * is not updated to match, one of these assertions breaks instead of a reviewer finding out from
 * a broken headless check weeks later.
 *
 * `electron` is mocked the same way tests/ipc/configManager.test.ts does it, reusing the same
 * helper (see its own doc comment for why `app.getPath("appData")` has to be set before the
 * dynamic import): normalizeConfig itself only reads `app.getPath("appData")` (for its
 * default-folder fallbacks, not exercised here since the seed always fills those fields) and, for
 * a pre-#477 moddbVisibilityAnswer, `app.getVersion()`.
 */
import "../ipc/helpers/electronMock"
import { setElectronPath, setElectronUserDataPath } from "../ipc/helpers/electronMock"

const repoRoot = resolve(__dirname, "../..")
const seedScript = resolve(repoRoot, "scripts/headless/seed.mjs")

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "headless-seed-"))
  setElectronUserDataPath(join(sandbox, "unused-userdata"))
  setElectronPath("appData", join(sandbox, "profile", "config"))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  vi.resetModules()
})

async function freshNormalizeConfig(): Promise<typeof import("@src/config/configManager").normalizeConfig> {
  vi.resetModules()
  const { normalizeConfig } = await import("@src/config/configManager")
  return normalizeConfig
}

function runSeed(spec: unknown): { profileRoot: string; configPath: string; config: ConfigType } {
  const specPath = join(sandbox, "spec.json")
  const profileRoot = join(sandbox, "profile")
  writeFileSync(specPath, JSON.stringify(spec))

  const result = spawnSync(process.execPath, [seedScript, specPath, profileRoot], { encoding: "utf-8" })
  assert.equal(result.status, 0, result.stderr)

  const configPath = join(profileRoot, "config", "RiftLauncher", "config.json")
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigType
  return { profileRoot, configPath, config }
}

/** Reads a mod archive's `modinfo.json` back out, the same entry scanInstalledMods reads. */
function readModinfo(archivePath: string): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return rejectPromise(err ?? new Error("archive did not open"))
      zip.on("entry", (entry) => {
        if (entry.fileName !== "modinfo.json") return zip.readEntry()
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return rejectPromise(streamErr)
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("end", () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf-8"))))
        })
      })
      zip.on("end", () => rejectPromise(new Error("archive carried no modinfo.json")))
      zip.readEntry()
    })
  })
}

describe("headless seed: config.json against normalizeConfig", () => {
  it("writes a config that normalizeConfig reads back unchanged", async () => {
    const normalizeConfig = await freshNormalizeConfig()
    const { config } = runSeed({
      installations: [{ name: "Vanilla Test", gameVersion: "1.20.4", mods: ["Primitive Survival", "Carry Capacity"] }],
      window: { width: 1024, height: 600 }
    })

    assert.deepEqual(normalizeConfig(config), config)
    assert.equal(config.installations.length, 1)
    assert.equal(config.installations[0]?.gameVersionId, config.gameVersions[0]?.id)
    assert.equal(config.window.width, 1024)
    assert.equal(config.window.height, 600)
  })

  it("dedupes installation ids, mod ids and shared game versions", async () => {
    const normalizeConfig = await freshNormalizeConfig()
    const { config } = runSeed({
      installations: [
        { name: "Test!", gameVersion: "1.20.4", mods: ["Same Mod", "Same Mod"] },
        { name: "Test!", gameVersion: "1.20.4", mods: [] }
      ]
    })

    assert.deepEqual(normalizeConfig(config), config)
    assert.equal(config.gameVersions.length, 1, "one shared game version, not one per installation")
    assert.deepEqual(
      config.installations.map((installation) => installation.id),
      ["test", "test-2"]
    )
  })

  it("fabricates archives scanInstalledMods can read, with dedicated modids", async () => {
    const { config } = runSeed({ installations: [{ name: "Mods", gameVersion: "1.20.4", mods: ["Same Mod", "Same Mod"] }] })

    const installation = config.installations[0]
    assert.ok(installation)
    const first = await readModinfo(join(installation.path, "Mods", "same-mod.zip"))
    const second = await readModinfo(join(installation.path, "Mods", "same-mod-2.zip"))
    assert.deepEqual(first, { name: "Same Mod", modid: "same-mod", version: "1.0.0" })
    assert.deepEqual(second, { name: "Same Mod", modid: "same-mod-2", version: "1.0.0" })
  })

  it("answers the ModDB prompt in advance under its pre-#477 name, and normalizeConfig migrates it", async () => {
    const normalizeConfig = await freshNormalizeConfig()
    const { config } = runSeed({ installations: [], moddbVisibilityAnswer: "declined" })

    assert.equal((config as unknown as Record<string, unknown>)["moddbVisibilityAnswer"], "declined")
    const normalized = normalizeConfig(config)
    // "declined" is a pre-#477 answer: the migration reads it as "ask again next version", not as
    // a permanent opt-out, with the running (mocked) app version recorded so this exact launch
    // does not re-prompt. See migrateLegacyAnswer in src/domain/moddbVisibility.ts.
    assert.equal(normalized.moddbVisibility.policy, "ask")
    assert.equal(normalized.moddbVisibility.answeredVersion, "0.0.0-test")
    assert.deepEqual(normalized.moddbVisibility.countedVersions, [])
  })

  it("leaves the ModDB prompt unanswered, already at today's shape, when the spec says nothing", async () => {
    const normalizeConfig = await freshNormalizeConfig()
    const { config } = runSeed({ installations: [] })

    assert.deepEqual(config.moddbVisibility, { policy: "ask", answeredVersion: "", countedVersions: [] })
    assert.deepEqual(normalizeConfig(config), config)
  })
})
