/**
 * Keeps the main window reachable. The saved position is whatever the window had when the launcher
 * was last closed, and a monitor can be gone by the next start (a laptop taken off its dock). Windows
 * does not pull a window back from a spot that is on no screen, so without a check the player gets a
 * taskbar button and no window.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of the Electron window the helpers use, so tests can hand in a plain object. */
export interface WindowLike {
  getBounds(): Rect
  isMinimized(): boolean
  isMaximized(): boolean
  restore(): void
  setPosition(x: number, y: number): void
  focus(): void
}

/** The strip along the top of the window the player grabs to drag it. */
const GRAB_STRIP_HEIGHT = 32

/** How much of that strip has to be on a display for the window to count as reachable. */
const MIN_GRAB_WIDTH = 100
const MIN_GRAB_HEIGHT = 16

function isReachable(bounds: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some((area) => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const height = Math.min(bounds.y + GRAB_STRIP_HEIGHT, area.y + area.height) - Math.max(bounds.y, area.y)
    return width >= MIN_GRAB_WIDTH && height >= MIN_GRAB_HEIGHT
  })
}

/**
 * The position to open the window at: the saved one while its title bar is on a connected display,
 * otherwise centered on the primary display (never past that display's top left corner).
 */
export function placeOnScreen(bounds: Rect, workAreas: readonly Rect[], primary: Rect): { x: number; y: number } {
  if (isReachable(bounds, workAreas)) return { x: bounds.x, y: bounds.y }

  return {
    x: primary.x + Math.max(0, Math.round((primary.width - bounds.width) / 2)),
    y: primary.y + Math.max(0, Math.round((primary.height - bounds.height) / 2))
  }
}

/** What a second launch asks of the running window: be visible, be on a screen, take focus. */
export function bringWindowToFront(win: WindowLike, workAreas: readonly Rect[], primary: Rect): void {
  if (win.isMinimized()) win.restore()

  // A maximized window belongs to whichever display holds it; the system already keeps it there.
  if (!win.isMaximized()) {
    const bounds = win.getBounds()
    const { x, y } = placeOnScreen(bounds, workAreas, primary)
    if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y)
  }

  win.focus()
}
