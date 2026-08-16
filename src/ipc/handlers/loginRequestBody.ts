/**
 * Builds the request body `POST auth3.vintagestory.at/v2/gamelogin` expects,
 * for either pass of the login protocol.
 *
 * Pulled out of accountHandlers.ts for the same reason as
 * accountLoginOutcome.ts: that file calls `ipcMain.handle` at module load,
 * which needs a running Electron main process and so cannot be imported by a
 * unit test. Nothing here touches Electron, Node, or the network, so a test
 * can pin the field order directly.
 */

/**
 * The game client's own version, sent as `gameloginversion`.
 *
 * Decompiled out of `VintagestoryLib.dll` 1.22.6: `DoLogin` builds its
 * `FormUrlEncodedContent` from exactly five fields, this one included, set to
 * the client's own version string. The auth endpoint accepts a request
 * without it today (verified by direct calls both ways), so leaving it out is
 * not the bug this constant fixes; sending it is matching the game's own
 * contract instead of a launcher-only guess at one.
 *
 * This needs to move every time the launcher starts targeting a newer stable
 * game version: it is not read from anywhere, so nothing else will remind
 * you to update it.
 */
export const GAME_LOGIN_VERSION = "1.22.6"

/**
 * The five fields the game client sends, in the game client's order:
 * email, password, totpcode, prelogintoken, gameloginversion.
 *
 * `totpcode` and `prelogintoken` are sent empty rather than omitted even on a
 * first pass with neither, which is what the launcher has always done and
 * what keeps this a pure function of its four inputs.
 *
 * @param email The address the user typed.
 * @param password The password the user typed. Held only for the length of this call, never logged.
 * @param twoFactorCode The six-digit code, on the second pass of a two-factor login.
 * @param preLoginToken The token the first pass returned, sent back on the second pass.
 */
export function buildLoginRequestBody(email: string, password: string, twoFactorCode?: string, preLoginToken?: string): URLSearchParams {
  return new URLSearchParams({
    email,
    password,
    totpcode: twoFactorCode ?? "",
    prelogintoken: preLoginToken ?? "",
    gameloginversion: GAME_LOGIN_VERSION
  })
}
