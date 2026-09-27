/**
 * The renderer's side of the session report (#462): one bridge call, and getting the text onto the
 * clipboard in a window where the modern API may not be allowed to.
 */

/** Asks the main process to read one Installation's last session and answer the report built from it. */
export function fetchSessionReport(installationPath: string): Promise<GameLogReportResult> {
  return window.api.gameManager.getGameLogReport(installationPath)
}

/**
 * Puts the report on the clipboard, and says whether it landed.
 *
 * `navigator.clipboard.writeText` first. It can reject here even though the app scheme is
 * registered secure: Chromium routes a clipboard write through a permission request, and
 * src/main/index.ts denies every one of them. The fallback is the selection-based copy, which
 * predates the permission model and does not go through it. Both can fail, and the caller says so
 * rather than pretending the text was copied.
 */
export async function copyReportText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the selection-based copy below.
  }

  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "0"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  } catch {
    return false
  }
}
