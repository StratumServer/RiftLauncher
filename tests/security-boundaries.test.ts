import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { parseLegacyAccount, parseLoginAccount } from "../src/ipc/accountTypes"
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
