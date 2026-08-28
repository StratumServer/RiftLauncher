import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import type { IpcMainInvokeEvent } from "electron"

import "./helpers/electronMock"
import { createTrustedEvent, createUntrustedEvent, getIpcHandler, setElectronUserDataPath } from "./helpers/electronMock"

import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { removeAccountSecrets, saveAccountSecrets } from "@src/ipc/accountStore"
import { requestBoundedTextViaNode } from "@src/ipc/network"

/**
 * The LOGIN and LOGOUT shells in src/ipc/handlers/accountHandlers.ts, which
 * were at 0%: nothing had ever imported the file, because it calls
 * `ipcMain.handle` at module load. The registry helper captures those
 * registrations, so the callbacks can be invoked here the way a real IPC
 * dispatch would.
 *
 * What is under test is the shell and only the shell. Reading a response is
 * `@domain/account/login`'s job and is covered by tests/domain/account; the
 * verdict-to-wire mapping is accountLoginOutcome.ts's and is covered by
 * accountLoginOutcome.test.ts. What is left here, and untested until now, is
 * the part that can leak or lose things: which passes get made, what the
 * transport is asked for, where the secrets go, and what the renderer is told
 * when the request itself fails.
 *
 * The transport is mocked at the module boundary, so no test here opens a
 * socket. `@src/ipc/accountStore` is mocked for the same reason gameHandlers
 * mocks it: real secure storage does not exist in a test process, and the
 * narrow port this handler actually calls is the honest thing to stand in for.
 *
 * Every credential below is a placeholder. Nothing here is shaped like a real
 * session key, and the password strings exist only to be asserted absent.
 */
vi.mock("@src/ipc/network", () => ({
  requestBoundedTextViaNode: vi.fn()
}))

vi.mock("@src/ipc/accountStore", () => ({
  saveAccountSecrets: vi.fn(async () => undefined),
  removeAccountSecrets: vi.fn(async () => true)
}))

import "@src/ipc/handlers/accountHandlers"

const EMAIL = "player@example.invalid"
const PASSWORD = "placeholder-password"
const TWO_FACTOR_CODE = "123456"

/** A body the service answers when the credentials are good. Placeholder values throughout. */
const SUCCESS_BODY = JSON.stringify({
  valid: 1,
  playername: "Placeholder Player",
  uid: "placeholder-uid",
  entitlements: "singleplayer",
  hasgameserver: false,
  sessionkey: "placeholder-session-key",
  sessionsignature: "placeholder-session-signature",
  mptoken: null
})

type LoginHandler = (event: IpcMainInvokeEvent, email: unknown, password: unknown, twoFactorCode?: unknown) => Promise<AccountLoginResult>
type RemoveAccountHandler = (event: IpcMainInvokeEvent, accountId: unknown) => Promise<boolean>

let userDataFolder: string
let trustedEvent: IpcMainInvokeEvent

function loginHandler(): LoginHandler {
  return getIpcHandler<LoginHandler>(IPC_CHANNELS.ACCOUNT_MANAGER.LOGIN)
}

function removeAccountHandler(): RemoveAccountHandler {
  return getIpcHandler<RemoveAccountHandler>(IPC_CHANNELS.ACCOUNT_MANAGER.REMOVE_ACCOUNT)
}

/** Queues one response body per pass, in order. */
function transportAnswers(...bodies: string[]): void {
  for (const body of bodies) vi.mocked(requestBoundedTextViaNode).mockResolvedValueOnce(body)
}

/** The decoded form fields of the nth request the handler made. */
function requestFields(index: number): Record<string, string> {
  const call = vi.mocked(requestBoundedTextViaNode).mock.calls[index]
  assert.ok(call, `no request was made at index ${index}`)
  const options = call[1] as { body?: string } | undefined
  return Object.fromEntries(new URLSearchParams(options?.body ?? ""))
}

beforeEach(async () => {
  userDataFolder = mkdtempSync(join(tmpdir(), "rift-account-handlers-test-"))
  setElectronUserDataPath(userDataFolder)
  vi.mocked(requestBoundedTextViaNode).mockReset()
  vi.mocked(saveAccountSecrets).mockReset().mockResolvedValue(undefined)
  vi.mocked(removeAccountSecrets).mockReset().mockResolvedValue(true)
  trustedEvent = await createTrustedEvent()
})

afterEach(() => {
  rmSync(userDataFolder, { recursive: true, force: true })
})

describe("LOGIN", () => {
  it("refuses a sender nothing registered as trusted", async () => {
    await assert.rejects(loginHandler()(createUntrustedEvent(), EMAIL, PASSWORD), /sender|trusted|refused/i)

    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 0)
  })

  for (const [label, email, password] of [
    ["an email that is not a string", 42, PASSWORD],
    ["an empty email", "", PASSWORD],
    ["a password that is not a string", EMAIL, null],
    ["an empty password", EMAIL, ""]
  ] as const) {
    it(`refuses ${label} before making any request`, async () => {
      await assert.rejects(loginHandler()(trustedEvent, email, password), TypeError)

      assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 0)
    })
  }

  it("refuses a two-factor code that is not a string", async () => {
    await assert.rejects(loginHandler()(trustedEvent, EMAIL, PASSWORD, 123456), TypeError)

    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 0)
  })

  it("returns the public account and stores the secrets on a first-pass success", async () => {
    transportAnswers(SUCCESS_BODY)

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.deepEqual(result, {
      status: "success",
      account: { email: EMAIL, playerName: "Placeholder Player", playerUid: "placeholder-uid", playerEntitlements: "singleplayer", hostGameServer: false }
    })
    assert.deepEqual(vi.mocked(saveAccountSecrets).mock.calls, [["placeholder-uid", { sessionKey: "placeholder-session-key", sessionSignature: "placeholder-session-signature", mptoken: null }]])
  })

  it("sends nothing back to the renderer that the store is meant to hold", async () => {
    transportAnswers(SUCCESS_BODY)

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    // The wire result is the public half only: a session key riding back over
    // IPC would put it in the renderer, which is the one place it must not be.
    assert.equal(JSON.stringify(result).includes("placeholder-session-key"), false)
    assert.equal(JSON.stringify(result).includes("placeholder-session-signature"), false)
    assert.equal(JSON.stringify(result).includes(PASSWORD), false)
  })

  it("posts to the account service with a bounded response and the credentials in the body", async () => {
    transportAnswers(SUCCESS_BODY)

    await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    const [url, options] = vi.mocked(requestBoundedTextViaNode).mock.calls[0] ?? []
    assert.equal(url?.toString(), "https://auth3.vintagestory.at/v2/gamelogin")
    assert.equal((options as { method?: string; maxBytes?: number } | undefined)?.method, "POST")
    assert.equal((options as { method?: string; maxBytes?: number } | undefined)?.maxBytes, 512 * 1024)
    assert.deepEqual(requestFields(0), { email: EMAIL, password: PASSWORD, totpcode: "", prelogintoken: "", gameloginversion: "1.22.6" })
  })

  it("makes one pass only, and asks for no code, when the account has no two-factor", async () => {
    transportAnswers(SUCCESS_BODY)

    await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 1)
  })

  it("asks the user for a code, without a second pass, when none was supplied", async () => {
    transportAnswers(JSON.stringify({ valid: 0, reason: "requiretotpcode", prelogintoken: "placeholder-pre-login-token" }))

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.deepEqual(result, { status: "requires-two-factor" })
    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 1)
    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })

  it("runs the second pass with the code and the token the first pass returned", async () => {
    transportAnswers(JSON.stringify({ valid: 0, reason: "requiretotpcode", prelogintoken: "placeholder-pre-login-token" }), SUCCESS_BODY)

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD, TWO_FACTOR_CODE)

    assert.equal(result.status, "success")
    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 2)
    assert.deepEqual(requestFields(1), { email: EMAIL, password: PASSWORD, totpcode: TWO_FACTOR_CODE, prelogintoken: "placeholder-pre-login-token", gameloginversion: "1.22.6" })
    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 1)
  })

  it("still runs the second pass when the first one returned no token", async () => {
    // The service omits `prelogintoken` often enough that the launcher has
    // always sent the second pass regardless.
    transportAnswers(JSON.stringify({ valid: 0, reason: "requiretotpcode" }), SUCCESS_BODY)

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD, TWO_FACTOR_CODE)

    assert.equal(result.status, "success")
    assert.equal(requestFields(1).prelogintoken, "")
  })

  it("reports a refused code, and makes no third pass", async () => {
    transportAnswers(JSON.stringify({ valid: 0, reason: "requiretotpcode" }), JSON.stringify({ valid: 0, reason: "wrongtotpcode" }))

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD, TWO_FACTOR_CODE)

    assert.deepEqual(result, { status: "wrong-two-factor" })
    assert.equal(vi.mocked(requestBoundedTextViaNode).mock.calls.length, 2)
    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })

  it("reports a refusal as bad credentials, and stores nothing", async () => {
    transportAnswers(JSON.stringify({ valid: 0, reason: "invalidemailorpassword" }))

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.deepEqual(result, { status: "invalid-credentials" })
    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })

  it("reports an unreadable success payload as unexpected rather than as a wrong password", async () => {
    // The live bug this arm exists for: a response the service called valid but
    // that carries no session used to reach the renderer as "invalid email or
    // password", sending the user to reset a password that was fine.
    transportAnswers(JSON.stringify({ valid: 1, playername: "Placeholder Player", uid: "placeholder-uid" }))

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.deepEqual(result, { status: "unexpected-response" })
    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })

  it("reports a body that is not JSON as unexpected too", async () => {
    transportAnswers("<html>maintenance</html>")

    const result = await loginHandler()(trustedEvent, EMAIL, PASSWORD)

    assert.deepEqual(result, { status: "unexpected-response" })
  })

  it("fails the login when the transport throws, without saying why", async () => {
    vi.mocked(requestBoundedTextViaNode).mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND auth3.vintagestory.at"))

    await assert.rejects(loginHandler()(trustedEvent, EMAIL, PASSWORD), (error: Error) => {
      // The reason stays in the log: the renderer is told the login failed and
      // nothing more, so a transport message cannot end up on screen.
      assert.equal(error.message, "Login failed")
      assert.equal(error.message.includes("ENOTFOUND"), false)
      return true
    })

    assert.equal(vi.mocked(saveAccountSecrets).mock.calls.length, 0)
  })

  it("fails the login when the second pass throws", async () => {
    transportAnswers(JSON.stringify({ valid: 0, reason: "requiretotpcode" }))
    vi.mocked(requestBoundedTextViaNode).mockRejectedValueOnce(new Error("socket hang up"))

    await assert.rejects(loginHandler()(trustedEvent, EMAIL, PASSWORD, TWO_FACTOR_CODE), /Login failed/)
  })

  it("fails the login when the secrets cannot be stored", async () => {
    transportAnswers(SUCCESS_BODY)
    vi.mocked(saveAccountSecrets).mockRejectedValueOnce(new Error("Secure account storage is unavailable"))

    // A success the launcher cannot persist is not a success: reporting one
    // would leave a session that vanishes on the next start.
    await assert.rejects(loginHandler()(trustedEvent, EMAIL, PASSWORD), /Login failed/)
  })
})

describe("REMOVE_ACCOUNT", () => {
  it("refuses a sender nothing registered as trusted", async () => {
    await assert.rejects(removeAccountHandler()(createUntrustedEvent(), "uid-a"), /sender|trusted|refused/i)

    assert.equal(vi.mocked(removeAccountSecrets).mock.calls.length, 0)
  })

  for (const [label, accountId] of [
    ["an id that is not a string", 42],
    ["an empty id", ""]
  ] as const) {
    it(`refuses ${label} before touching the store`, async () => {
      await assert.rejects(removeAccountHandler()(trustedEvent, accountId), TypeError)

      assert.equal(vi.mocked(removeAccountSecrets).mock.calls.length, 0)
    })
  }

  it("removes the stored secrets for the given account", async () => {
    const result = await removeAccountHandler()(trustedEvent, "uid-a")

    assert.equal(result, true)
    assert.deepEqual(vi.mocked(removeAccountSecrets).mock.calls, [["uid-a"]])
  })

  it("reports the failure when the secrets could not be removed", async () => {
    vi.mocked(removeAccountSecrets).mockResolvedValueOnce(false)

    assert.equal(await removeAccountHandler()(trustedEvent, "uid-a"), false)
  })
})
