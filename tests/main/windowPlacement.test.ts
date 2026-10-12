import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"

import { bringWindowToFront, placeOnScreen } from "@src/main/windowPlacement"
import type { Rect, WindowLike } from "@src/main/windowPlacement"

/** A laptop screen with an external monitor docked to its left, so the external one has negative x. */
const LAPTOP: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const EXTERNAL_LEFT: Rect = { x: -2560, y: -200, width: 2560, height: 1400 }
const SIZE = { width: 1280, height: 720 }

describe("placeOnScreen", () => {
  it("keeps a position that is on the only display", () => {
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 100, y: 50 }, [LAPTOP], LAPTOP), { x: 100, y: 50 })
  })

  it("keeps a position on a secondary display that is still connected, negative coordinates included", () => {
    assert.deepEqual(placeOnScreen({ ...SIZE, x: -2000, y: 0 }, [LAPTOP, EXTERNAL_LEFT], LAPTOP), { x: -2000, y: 0 })
  })

  it("centers on the primary display when the saved monitor was unplugged", () => {
    // Saved while docked on the monitor to the left; now only the laptop screen is there.
    assert.deepEqual(placeOnScreen({ ...SIZE, x: -2000, y: 0 }, [LAPTOP], LAPTOP), { x: 320, y: 160 })
  })

  it("centers when the window is far beyond the right or bottom edge", () => {
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 3000, y: 100 }, [LAPTOP], LAPTOP), { x: 320, y: 160 })
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 100, y: 5000 }, [LAPTOP], LAPTOP), { x: 320, y: 160 })
  })

  it("centers on the primary display, not on the first one listed", () => {
    const primary: Rect = { x: 1920, y: 0, width: 1600, height: 900 }
    assert.deepEqual(placeOnScreen({ ...SIZE, x: -9000, y: 0 }, [LAPTOP, primary], primary), { x: 2080, y: 90 })
  })

  it("keeps a window that hangs partly off a display while its title bar can still be grabbed", () => {
    assert.deepEqual(placeOnScreen({ ...SIZE, x: -1000, y: 20 }, [LAPTOP], LAPTOP), { x: -1000, y: 20 })
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 1800, y: 20 }, [LAPTOP], LAPTOP), { x: 1800, y: 20 })
  })

  it("centers a window whose title bar is above the display, where it cannot be dragged back", () => {
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 100, y: -600 }, [LAPTOP], LAPTOP), { x: 320, y: 160 })
  })

  it("never puts a window larger than the primary display past its top left corner", () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 600 }
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 9000, y: 9000 }, [small], small), { x: 0, y: 0 })
  })

  it("keeps the centered window inside a primary display that does not start at the origin", () => {
    const primary: Rect = { x: 1920, y: 100, width: 1600, height: 900 }
    assert.deepEqual(placeOnScreen({ ...SIZE, x: 0, y: 0 }, [primary], primary), { x: 2080, y: 190 })
  })
})

function fakeWindow(bounds: Rect, state: { minimized?: boolean; maximized?: boolean } = {}): WindowLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getBounds: () => bounds,
    isMinimized: () => state.minimized === true,
    isMaximized: () => state.maximized === true,
    restore: () => calls.push("restore"),
    setPosition: (x, y) => calls.push(`setPosition ${x} ${y}`),
    focus: () => calls.push("focus")
  }
}

describe("bringWindowToFront", () => {
  it("restores a minimized window and focuses it without moving one that is on a display", () => {
    const win = fakeWindow({ ...SIZE, x: 100, y: 50 }, { minimized: true })
    bringWindowToFront(win, [LAPTOP], LAPTOP)
    assert.deepEqual(win.calls, ["restore", "focus"])
  })

  it("brings a window left on an unplugged monitor back to the primary display, then focuses it", () => {
    const win = fakeWindow({ ...SIZE, x: -2000, y: 0 })
    bringWindowToFront(win, [LAPTOP], LAPTOP)
    assert.deepEqual(win.calls, ["setPosition 320 160", "focus"])
  })

  it("leaves a maximized window where the system put it", () => {
    const win = fakeWindow({ ...SIZE, x: -2000, y: 0 }, { maximized: true })
    bringWindowToFront(win, [LAPTOP], LAPTOP)
    assert.deepEqual(win.calls, ["focus"])
  })
})

/**
 * src/main/index.ts cannot be imported here (it runs app.whenReady() on load), so the wiring is read
 * from the source, the way tests/security-boundaries.test.ts does. What matters is that the two
 * entry points reach the helpers above: the saved position at ready-to-show, and the second start.
 */
describe("main process wiring", () => {
  const source = readFileSync(resolve(__dirname, "../../src/main/index.ts"), "utf8")

  it("checks the saved position against the connected displays before it is applied", () => {
    const readyStart = source.indexOf('mainWindow.on("ready-to-show"')
    assert.notEqual(readyStart, -1)
    const handler = source.slice(readyStart, source.indexOf("mainWindow.show()", readyStart))
    assert.match(handler, /placeOnScreen\(/)
    assert.match(handler, /screen\.getAllDisplays\(\)/)
    assert.match(handler, /screen\.getPrimaryDisplay\(\)/)
    assert.doesNotMatch(handler, /setPosition\(oldWindowsState\.x/)
  })

  it("brings the running window forward when a second copy is started", () => {
    const start = source.indexOf('app.on("second-instance"')
    assert.notEqual(start, -1, "nothing listens for second-instance, so a second start leaves the running window where it is")
    const handler = source.slice(start, source.indexOf("\n})", start))
    assert.match(handler, /bringWindowToFront\(\s*mainWindow/)
    assert.match(handler, /isDestroyed\(\)/)
  })
})
