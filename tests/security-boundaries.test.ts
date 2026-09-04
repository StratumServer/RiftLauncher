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
      envVars: "",
      launchWrapper: ""
    })
    assert.throws(() => validateGameVersion({ version: "1.22.6", path: "/" }), /Invalid game version path/)
    assert.throws(() => parseSafeEnvironment("PATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => validateGameInstallation({ path: "/tmp/installations/main", startParams: "", mesaGlThread: false, envVars: "", launchWrapper: "x".repeat(4_097) }), /Invalid launch wrapper/)
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
const PRELOAD_SOURCE = readFileSync(resolve(__dirname, "../src/preload/index.ts"), "utf8")
const RENDERER_HTML = readFileSync(resolve(__dirname, "../src/renderer/index.html"), "utf8")

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

  it("keeps the local app protocol CORS-aware and records non-renderer child exits", () => {
    assert.equal(MAIN_SOURCE.includes("corsEnabled: true"), true, "the app protocol lost its CORS enforcement for cross-origin renderer paths")
    assert.equal(MAIN_SOURCE.includes('app.on("child-process-gone"'), true, "non-renderer child process failures are no longer logged")
  })
})

/**
 * The renderer CSP is one long attribute, so a substring match on it is a poor
 * pin: "script-src 'self'" is still present after someone appends a host to the
 * source list. Parsing the attribute into directives means the assertion below
 * compares the value the browser will actually apply, and it survives a
 * reordering or a reflow of the attribute.
 */
function rendererCspDirectives(): Map<string, string> {
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(RENDERER_HTML)?.[1]
  if (policy === undefined) throw new Error("src/renderer/index.html no longer carries a Content-Security-Policy meta tag")

  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name = "", ...sources] = directive.split(/\s+/)
        return [name, sources.join(" ")] as const
      })
  )
}

describe("renderer document boundaries", () => {
  it("keeps every renderer script source local", () => {
    const directives = rendererCspDirectives()

    assert.equal(directives.get("script-src"), "'self'", `renderer script-src is now ${JSON.stringify(directives.get("script-src"))}; the renderer must not run script from anywhere but the bundle`)
    assert.equal(directives.get("default-src"), "'self'", `renderer default-src is now ${JSON.stringify(directives.get("default-src"))}; it is the fallback every directive that goes missing lands on`)
    assert.equal(directives.get("object-src"), "'none'", "renderer object-src stopped blocking plugin content")
    assert.equal(directives.get("base-uri"), "'none'", "renderer base-uri stopped blocking a rewritten document base")
  })

  it("does not allow framed content in the renderer CSP", () => {
    assert.match(RENDERER_HTML, /frame-src 'none'/)
    // Match the full directive up to its semicolon or end-of-string so that
    // frame-src 'none' https://evil.example does not slip through: when a
    // source list holds 'none' alongside other expressions, browsers ignore
    // the 'none' and honour the rest.
    assert.doesNotMatch(RENDERER_HTML, /frame-src\s+'none'\s*[^';"\n]/)
  })

  it("exposes the preload bridge only in the main frame", () => {
    const guardStart = PRELOAD_SOURCE.lastIndexOf("if (process.isMainFrame)")
    const exposeStart = PRELOAD_SOURCE.indexOf('contextBridge.exposeInMainWorld("api", api)')

    assert.notEqual(guardStart, -1, "preload stopped checking process.isMainFrame")
    assert.notEqual(exposeStart, -1, "preload stopped exposing the launcher API")
    assert.ok(guardStart < exposeStart, "preload exposes the API before its main-frame guard")
    // Ensure the expose call sits inside the guarded block, not outside it
    // as a dead-statement hoist. The pattern is anchored so a dead guard
    // followed by a hoisted expose (or an empty guard block) breaks it.
    assert.match(PRELOAD_SOURCE.slice(guardStart, exposeStart), /^if \(process\.isMainFrame\) \{\s*(try \{\s*)?$/)
    // Exactly one exposeInMainWorld keeps a future duplicate from leaking
    // the bridge into every frame.
    const exposeCount = PRELOAD_SOURCE.split("contextBridge.exposeInMainWorld").length - 1
    assert.equal(exposeCount, 1, `preload has ${exposeCount} exposeInMainWorld calls; expected exactly 1`)
  })
})

function mainHandlerSource(startMarker: string, endMarker: string): string {
  const start = MAIN_SOURCE.indexOf(startMarker)
  if (start === -1) throw new Error(`Could not find main-process handler: ${startMarker}`)

  const end = MAIN_SOURCE.indexOf(endMarker, start + startMarker.length)
  if (end === -1) throw new Error(`Could not find end of main-process handler: ${startMarker}`)

  return MAIN_SOURCE.slice(start, end)
}

/**
 * Reads the boolean webPreferences the main window is built with as values
 * rather than as text. A substring pin on "sandbox: true" would also be
 * satisfied by a comment mentioning it, and it says nothing when the flag flips;
 * this fails with the flag that changed and its new value. Comment lines and
 * non-boolean options (preload, icon) do not match, so they are simply skipped.
 */
function mainWindowFlags(): Map<string, boolean> {
  const source = mainHandlerSource("webPreferences: {", "\n  })")
  return new Map([...source.matchAll(/^\s*(\w+): (true|false),?\s*$/gm)].map(([, name = "", value]) => [name, value === "true"] as const))
}

/**
 * The renderer defenses the main process holds on its own side of the bridge.
 * None of them can be exercised for real here: index.ts bootstraps Electron on
 * import, and the only harness that drives a rendered window is the packaged CDP
 * run under tests/e2e, which is started by hand from a workflow rather than by
 * vitest. So these read the source, the same way the assertions above do, with
 * the values pulled out where they can be (the webPreferences flags) and matched
 * as anchored patterns where they cannot (the handler bodies). Each pattern is
 * written to accept a renamed local or a prettier pass and to reject a weakened
 * value.
 */
describe("main process renderer defenses", () => {
  it("builds the main window with the renderer locked out of node", () => {
    const flags = mainWindowFlags()

    assert.equal(flags.get("sandbox"), true, `the main window webPreferences set sandbox: ${flags.get("sandbox")}, which drops the renderer out of the OS sandbox`)
    assert.equal(flags.get("nodeIntegration"), false, `the main window webPreferences set nodeIntegration: ${flags.get("nodeIntegration")}, which hands the renderer require()`)
    assert.equal(flags.get("contextIsolation"), true, `the main window webPreferences set contextIsolation: ${flags.get("contextIsolation")}, which puts the preload bridge in the page's own world`)
  })

  it("blocks any main-frame navigation the renderer policy rejects", () => {
    // will-navigate alone is not the boundary: a redirect and a frame
    // navigation reach the same window through their own events, so all three
    // guards are pinned together.
    for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const marker = `.on("${event}"`
      assert.ok(MAIN_SOURCE.includes(marker), `src/main/index.ts stopped registering the ${event} guard, so the renderer can navigate the window away from the bundle`)
      // Accepts a renamed parameter or guard function, rejects a body that
      // stops preventing, and rejects the negation being dropped.
      assert.match(mainHandlerSource(marker, "\n  })"), /if \(.*!.*\) \w+\.preventDefault\(\)/, `the ${event} guard no longer prevents a URL the renderer policy rejects`)
    }
  })

  it("denies every window the renderer asks Electron to open", () => {
    const handler = mainHandlerSource("setWindowOpenHandler(", "\n  })")

    assert.match(handler, /return \{ action: "deny" \}/, "the window open handler stopped denying, so a renderer window.open() gets a real Electron window instead of the external browser")
    assert.doesNotMatch(handler, /action: "allow"/, "the window open handler can now open an Electron window for the renderer")
  })

  it("refuses every renderer permission request", () => {
    assert.match(
      MAIN_SOURCE,
      /setPermissionRequestHandler\(\([^)]*\) => \{?\s*\w+\(false\)/,
      "the permission request handler stopped answering false, so the renderer can be granted device permissions"
    )
    assert.match(MAIN_SOURCE, /setPermissionCheckHandler\(\([^)]*\) => false\)/, "the permission check handler stopped answering false, so a synchronous permission check now passes")
  })
})

describe("main process protocol boundary wiring", () => {
  // index.ts bootstraps Electron on import, so keep this contract scoped to each inline handler.
  it("routes app and custom icon requests through containment before file checks", () => {
    const appSource = mainHandlerSource('protocol.handle("app", async (request) => {', "\n  // Handler for mod icons")
    const iconsSource = mainHandlerSource('protocol.handle("icons", async (req) => {', "\n  await ensureConfig()")
    const handlers: ReadonlyArray<readonly [string, string]> = [
      ["app", appSource],
      ["icons", iconsSource]
    ]

    for (const [name, source] of handlers) {
      const containmentCall = source.indexOf("const filePath = resolveContainedPath")
      assert.notEqual(containmentCall, -1, `${name}: handler stopped resolving a contained path`)

      const containmentReturn = source.indexOf("if (!filePath) return new Response(null, { status: 404 })", containmentCall)
      assert.notEqual(containmentReturn, -1, `${name}: handler stopped rejecting paths outside its root explicitly`)
      assert.equal(source.includes("if (!filePath ||"), false, `${name}: containment was folded into another gate`)

      const filesystemCheck = source.indexOf("if (!(await isSafeProtocolFile(filePath)))", containmentReturn)
      assert.notEqual(filesystemCheck, -1, `${name}: handler stopped checking the resolved filesystem object`)
      assert.ok(containmentReturn < filesystemCheck, `${name}: filesystem safety ran before containment`)
    }

    const containmentReturn = iconsSource.indexOf("if (!filePath) return new Response(null, { status: 404 })")
    const extensionCheck = iconsSource.indexOf('if (!filePath.toLowerCase().endsWith(".png"))', containmentReturn)
    const filesystemCheck = iconsSource.indexOf("if (!(await isSafeProtocolFile(filePath)))", extensionCheck)
    assert.ok(containmentReturn < extensionCheck, "icons: extension checking ran before containment")
    assert.ok(extensionCheck < filesystemCheck, "icons: filesystem safety ran before the extension check")
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
