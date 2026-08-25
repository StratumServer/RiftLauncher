import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it } from "vitest"

import { parseLegacyAccount, parseLoginAccount } from "../src/domain/account/credentials"
import { isAllowedRendererUrl, parseSafeEnvironment, validateGameInstallation, validateGameVersion } from "../src/ipc/validation"

describe("credential boundaries", () => {
  it("keeps session credentials out of the public account object", () => {
    const credentials = parseLoginAccount("player@example.test", {
      playername: "Player",
      uid: "uid-1",
      entitlements: "game",
      hasgameserver: 1,
      sessionkey: "session-key",
      sessionsignature: "session-signature",
      mptoken: "multiplayer-token"
    })

    assert.deepEqual(credentials.publicAccount, {
      email: "player@example.test",
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: true
    })
    assert.equal("sessionKey" in credentials.publicAccount, false)
    assert.equal("sessionSignature" in credentials.publicAccount, false)
    assert.equal("mptoken" in credentials.publicAccount, false)
  })

  it("can read legacy credentials only in the main-process migration shape", () => {
    const legacy = parseLegacyAccount({
      email: "player@example.test",
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: false,
      sessionKey: "session-key",
      sessionSignature: "session-signature",
      mptoken: null
    })

    assert.equal(legacy?.secrets.sessionKey, "session-key")
    assert.equal(legacy?.publicAccount.playerName, "Player")
  })
})

describe("process and navigation boundaries", () => {
  it("rejects dangerous environment overrides", () => {
    assert.deepEqual(parseSafeEnvironment("LANG=en_US,VS_LAUNCHER_TEST=1"), { LANG: "en_US", VS_LAUNCHER_TEST: "1" })
    assert.throws(() => parseSafeEnvironment("PATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("NODE_OPTIONS=--require=/tmp/payload"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("PYTHONPATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("bad-entry"), /Invalid environment variable/)
  })

  it("validates game launch objects instead of trusting TypeScript casts", () => {
    assert.deepEqual(validateGameVersion({ version: "1.22.6", path: "/tmp/versions/1.22.6" }), { version: "1.22.6", path: "/tmp/versions/1.22.6" })
    assert.deepEqual(validateGameInstallation({ path: "/tmp/installations/main", startParams: "", mesaGlThread: false, envVars: "" }), {
      path: "/tmp/installations/main",
      startParams: "",
      mesaGlThread: false,
      envVars: ""
    })
    assert.throws(() => validateGameVersion({ version: "1.22.6", path: "/" }), /Invalid game version path/)
    assert.throws(() => parseSafeEnvironment("PATH=/tmp"), /Invalid environment variable/)
  })

  it("accepts only the exact renderer document or development origin", () => {
    const packagedPath = resolve("/tmp/out/renderer/index.html")
    assert.equal(isAllowedRendererUrl(`${pathToFileURL(packagedPath).toString()}#/home`, undefined, packagedPath), true)
    assert.equal(isAllowedRendererUrl(`${pathToFileURL(`${packagedPath}.evil`).toString()}`, undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://renderer/index.html#/home", undefined, packagedPath), true)
    assert.equal(isAllowedRendererUrl("app://renderer/index.html?file=outside", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://renderer/other.html", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://evil/index.html", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("http://localhost:5173/#/home", "http://localhost:5173", "/tmp/out/renderer/index.html"), true)
    assert.equal(isAllowedRendererUrl("http://localhost:5173.evil/#/home", "http://localhost:5173", "/tmp/out/renderer/index.html"), false)
  })
})

/**
 * src/main/index.ts cannot be imported here: it is the Electron main process
 * bootstrap and runs app.whenReady() on load. The property worth guarding does
 * not need it running, so this reads the source, the same approach
 * tests/ipc/accountLoginFlow.test.ts takes with the login handler.
 *
 * The property: both session calls survive. setSpellCheckerLanguages([]) is the
 * one that keeps a fresh profile from downloading a multi-megabyte hunspell
 * dictionary from a third-party CDN (#129, #132), and setSpellCheckerEnabled(false)
 * sitting next to it makes the pair look redundant. Both assertions match on the
 * session.defaultSession. prefix so that a comment naming either method cannot
 * satisfy them.
 */
const MAIN_SOURCE = readFileSync(resolve(__dirname, "../src/main/index.ts"), "utf8")

describe("startup network boundaries", () => {
  it("keeps both session calls that stop the spellcheck dictionary download", () => {
    assert.equal(MAIN_SOURCE.includes("session.defaultSession.setSpellCheckerLanguages([])"), true, "src/main/index.ts stopped clearing the spellchecker language list")
    assert.equal(MAIN_SOURCE.includes("session.defaultSession.setSpellCheckerEnabled(false)"), true, "src/main/index.ts stopped disabling the session spellchecker")
  })

  it("keeps the mod icon cache lifecycle wiring in the main process", () => {
    assert.equal(MAIN_SOURCE.includes("ipcMain.on(IPC_CHANNELS.MODS_MANAGER.CLEAR_MOD_ICON_MEMORY_CACHE"), true, "src/main/index.ts stopped registering the trusted mod icon cache clear handler")

    const windowClosedStart = MAIN_SOURCE.indexOf('app.on("window-all-closed"')
    assert.notEqual(windowClosedStart, -1, "src/main/index.ts stopped registering the window-close handler")
    assert.equal(MAIN_SOURCE.slice(windowClosedStart).includes("clearModIconMemoryCache(modIconMemoryCache)"), true, "src/main/index.ts stopped clearing the mod icon cache when all windows close")
  })

  // An offline launch of a packaged build rejects the update check, and a
  // rejection nobody catches takes the main process down with it. The check
  // itself lives in autoUpdaterEvents.ts, which tests/main/autoUpdaterEvents.test.ts
  // exercises for real; this keeps index.ts from growing a second, uncaught one.
  it("leaves the startup update check to the module that catches its rejection", () => {
    assert.equal(MAIN_SOURCE.includes("scheduleUpdateCheck("), true, "src/main/index.ts stopped arming the startup update check")
    assert.equal(MAIN_SOURCE.includes("autoUpdater.checkForUpdates("), false, "src/main/index.ts calls checkForUpdates itself again, where nothing catches its rejection")
  })
})

/**
 * Two renderer trees are held off the preload bridge. Shared components reach the host only
 * through a feature they were handed, and the mods feature keeps its bridge calls in
 * features/moddb/adapters, which is what the comment at the top of moddb.ts describes. Both rules
 * lived in comments alone, so anything could quietly walk back into either tree. Reading the
 * sources is the same approach the main-process assertions above take.
 */
function filesReachingTheBridge(tree: string): string[] {
  const root = resolve(__dirname, "..", tree)
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .filter((entry) => readFileSync(resolve(root, entry), "utf8").includes("window.api"))
}

describe("renderer preload bridge boundaries", () => {
  it("keeps the mods feature behind its adapters", () => {
    assert.deepEqual(filesReachingTheBridge("src/renderer/src/features/mods"), [], "a file under src/renderer/src/features/mods calls window.api instead of going through an adapter")
  })

  it("keeps the shared components behind the features they are handed", () => {
    assert.deepEqual(filesReachingTheBridge("src/renderer/src/components"), [], "a file under src/renderer/src/components calls window.api instead of going through a feature")
  })
})
