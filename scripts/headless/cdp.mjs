#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver for a headless RiftLauncher: no
 * chrome-remote-interface, no puppeteer. Node 22's native fetch and WebSocket
 * are enough for what this needs (read the page, click something, type,
 * resize, screenshot).
 *
 * Talks to the port a packaged build was launched on with
 * --remote-debugging-port (see launch.sh). Never launches or closes the app
 * itself, and never clicks Play: driving a real game launch is out of scope
 * for a headless check.
 *
 *   CDP_PORT=9561 node scripts/headless/cdp.mjs <command> [args...]
 *
 * Commands:
 *   text                  Print the page's visible text (document.body.innerText).
 *   eval <expr>            Evaluate a JS expression in the page and print the result.
 *   clickText <text>       Click the element whose own trimmed text exactly matches <text>.
 *   click <selector>        Click the first element matching a CSS selector.
 *   clickxy <x> <y>         Dispatch a real mouse click at viewport coordinates.
 *   type <text>             Insert text into the currently focused element.
 *   key <name>              Press a key (Enter, Escape, Tab, Backspace, Space, ArrowUp/Down/Left/Right).
 *   shot <outfile>           Capture a PNG screenshot to <outfile>.
 *   size <WxH>               Set the viewport size, e.g. size 1024x600.
 *
 * Exit codes: 0 on success, 1 on usage or connection errors, 2 when the
 * requested command found nothing to act on: no matching element, no page
 * target, or an element that scrolled into view still has no box, sits
 * outside the viewport, or is covered by something else (an overlay, a
 * dialog backdrop), so a click on it would not land.
 *
 * Every CDP call rejects on its own if the browser never answers it, after
 * CDP_TIMEOUT_MS (default 15000).
 */

import { writeFileSync } from "node:fs"

const USAGE = `usage: CDP_PORT=<port> [CDP_TIMEOUT_MS=<ms>] node scripts/headless/cdp.mjs <command> [args...]

commands:
  text                    print the page's visible text
  eval <expr>             evaluate a JS expression, print the result
  clickText <text>        click the element whose own text matches exactly
  click <selector>        click the first element matching a CSS selector
  clickxy <x> <y>         real mouse click at viewport coordinates
  type <text>              insert text into the focused element
  key <name>               press a key (Enter, Escape, Tab, Backspace, Space, Arrow*)
  shot <outfile>            capture a PNG screenshot
  size <WxH>                set the viewport size, e.g. size 1024x600`

/** windows virtual key codes for the keys this driver bothers naming. CDP needs one to reproduce a real keypress. */
const KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }
}

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

async function pickPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === "page")
  if (!page) fail(`no page target on the given port`, 2)
  return page
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.addEventListener("open", () => resolve(ws))
    ws.addEventListener("error", () => reject(new Error("could not open the CDP websocket")))
  })
}

const DEFAULT_RPC_TIMEOUT_MS = 15_000

/** A CDP call that never gets a reply (a hung renderer, a dropped socket) used to hang the tool forever. Every call now rejects, naming its own method, after `timeoutMs`. */
function rpc(ws, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  let id = 0
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message ?? "CDP call failed"))
      else resolve(msg.result)
    }
  })
  return function call(method, params = {}) {
    const thisId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(thisId)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(thisId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: thisId, method, params }))
    })
  }
}

/** Evaluates `expression`, returning its value by value (JSON-serializable) rather than a remote handle. */
async function evaluate(call, expression) {
  const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

const FIND_BY_TEXT = (text) => `(() => {
  const target = ${JSON.stringify(text)}
  const all = Array.from(document.querySelectorAll("body *"))
  const matches = all.filter((el) => el.textContent && el.textContent.trim() === target)
  // Prefer the deepest match: a wrapping container's textContent includes the same string.
  return matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) || null
})()`

const FIND_BY_SELECTOR = (selector) => `document.querySelector(${JSON.stringify(selector)})`

/**
 * Resolves a click target found by `findExpr` (a JS expression evaluating to an element or
 * null) to viewport coordinates, or a reason it cannot be clicked. Scrolls the element into
 * view first: `getBoundingClientRect()` on an element below the fold used to hand back
 * coordinates outside the viewport, `Input.dispatchMouseEvent` hit nothing there, and the
 * command still exited 0 (#536). A box that scrolling still leaves off-screen, has no size
 * (display:none), or is not what `elementFromPoint` finds at its own centre (covered by an
 * overlay, a dialog backdrop) is refused the same way, before any mouse event is sent.
 */
async function resolveClickTarget(call, findExpr) {
  return evaluate(
    call,
    `(() => {
      const el = ${findExpr}
      if (!el) return { ok: false, reason: "not-found" }
      el.scrollIntoView({ block: "center" })
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return { ok: false, reason: "no-box" }
      const x = rect.x + rect.width / 2
      const y = rect.y + rect.height / 2
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return { ok: false, reason: "outside-viewport" }
      }
      const atPoint = document.elementFromPoint(x, y)
      if (!atPoint || !(atPoint === el || el.contains(atPoint))) return { ok: false, reason: "covered" }
      return { ok: true, x, y }
    })()`
  )
}

/** Resolves `findExpr` to a clickable point, or fails with exit code 2 and a reason a click there would not land. `notFoundMessage` covers the "no element" case; the rest describe an element that was found but is not actually clickable. */
async function clickTarget(call, findExpr, notFoundMessage) {
  const result = await resolveClickTarget(call, findExpr)
  if (result.ok) return result
  const messages = {
    "not-found": notFoundMessage,
    "no-box": "element has no box to click (display:none, or zero size)",
    "outside-viewport": "element's centre is outside the viewport even after scrolling into view",
    covered: "element is covered by something else (an overlay, a dialog backdrop) at its own centre point"
  }
  fail(messages[result.reason] ?? `element is not clickable (${result.reason})`, 2)
}

async function clickAt(call, x, y) {
  const options = { x, y, button: "left", clickCount: 1 }
  await call("Input.dispatchMouseEvent", { type: "mousePressed", ...options })
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...options })
}

async function runCommand(call, command, args) {
  switch (command) {
    case "text": {
      console.log(await evaluate(call, "document.body.innerText"))
      return
    }
    case "eval": {
      if (args.length < 1) fail(USAGE)
      const value = await evaluate(call, args[0])
      console.log(typeof value === "string" ? value : JSON.stringify(value))
      return
    }
    case "clickText": {
      if (args.length < 1) fail(USAGE)
      const { x, y } = await clickTarget(call, FIND_BY_TEXT(args[0]), "no element with that text was found")
      await clickAt(call, x, y)
      return
    }
    case "click": {
      if (args.length < 1) fail(USAGE)
      const { x, y } = await clickTarget(call, FIND_BY_SELECTOR(args[0]), "no element matched the selector")
      await clickAt(call, x, y)
      return
    }
    case "clickxy": {
      if (args.length < 2) fail(USAGE)
      await clickAt(call, Number(args[0]), Number(args[1]))
      return
    }
    case "type": {
      if (args.length < 1) fail(USAGE)
      await call("Input.insertText", { text: args[0] })
      return
    }
    case "key": {
      if (args.length < 1) fail(USAGE)
      const mapped = KEY_CODES[args[0]]
      if (!mapped) fail(`unknown key name. known keys: ${Object.keys(KEY_CODES).join(", ")}`)
      await call("Input.dispatchKeyEvent", { type: "keyDown", ...mapped })
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...mapped })
      return
    }
    case "shot": {
      if (args.length < 1) fail(USAGE)
      const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
      writeFileSync(args[0], Buffer.from(data, "base64"))
      return
    }
    case "size": {
      if (args.length < 1) fail(USAGE)
      const match = /^(\d+)x(\d+)$/.exec(args[0])
      if (!match) fail(`size must be WxH, e.g. 1024x600`)
      await call("Emulation.setDeviceMetricsOverride", { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: 1, mobile: false })
      return
    }
    default:
      fail(USAGE)
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === "--help" || command === "-h") fail(USAGE)

  const port = Number(process.env.CDP_PORT)
  if (!port) fail("CDP_PORT must be set to the launched build's --remote-debugging-port.")

  const timeoutMs = process.env.CDP_TIMEOUT_MS === undefined ? DEFAULT_RPC_TIMEOUT_MS : Number(process.env.CDP_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("CDP_TIMEOUT_MS must be a positive number of milliseconds.")

  const target = await pickPageTarget(port)
  const ws = await connect(target.webSocketDebuggerUrl)
  const call = rpc(ws, timeoutMs)

  await call("Page.enable")
  await call("Runtime.enable")

  try {
    await runCommand(call, command, args)
  } finally {
    ws.close()
  }
}

main().catch((err) => fail(err.message ?? String(err)))
