/**
 * The renderer's only way to the play session channels (#461).
 *
 * Both are reads. There is deliberately no write here: the only thing that ever appends to a
 * sessions file is EXECUTE_GAME on the main side, so nothing the renderer runs can put a series
 * into a player's history.
 */

/** The sessions recorded for one Installation, newest first, or the reason there are none to show. */
export async function loadPlaySessions(installationId: string): Promise<PlaySessionsReadResult> {
  return window.api.gameManager.getPlaySessions(installationId)
}

/** Clears one Installation's recorded sessions. False when the file was left as it was. */
export async function forgetPlaySessions(installationId: string): Promise<boolean> {
  return (await window.api.gameManager.forgetPlaySessions(installationId)).ok
}
