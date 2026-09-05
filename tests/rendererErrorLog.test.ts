import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Logger from "electron-log"

import { logRenderError } from "../src/renderer/src/adapters/errorLog"
import { assertString } from "../src/ipc/validation"
import { logMessage } from "../src/utils/logManager"

/**
 * A value a maintainer must never find in error.log. It carries no marker the main-process
 * redactor recognises: no `password=` prefix, no query key, no absolute path. Redaction cannot
 * save a payload that put this in, which is the point of normalising renderer-side instead.
 */
const SECRET = "sk-live-9f3a2b1c8d7e6f5a"

/** The IPC ceiling in src/ipc/handlers/utilsHandlers.ts. Past it the whole event is thrown away. */
const IPC_LIMIT = 16_384

let logMessageMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  logMessageMock = vi.fn()
  vi.stubGlobal("window", { api: { utils: { logMessage: logMessageMock } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The payload that reached the preload bridge, which is everything the renderer chose to send. */
function bridgePayload(error: unknown, componentStack?: string | null): string {
  logRenderError("PageErrorBoundary", error, componentStack)

  expect(logMessageMock).toHaveBeenCalledTimes(1)

  const [level, payload] = logMessageMock.mock.calls.at(0) ?? []
  expect(level).toBe("error")

  return String(payload)
}

/**
 * The line that ends up in error.log, through the two steps the main process actually applies:
 * the LOG_MESSAGE handler's length check and `redactSensitiveText` inside `logMessage`.
 */
function finalLogText(payload: string): string {
  const logged = vi.spyOn(Logger, "error").mockImplementation(() => undefined)

  logMessage("error", assertString(payload, "log message", IPC_LIMIT))

  return String(logged.mock.calls.at(0)?.[0])
}

/** Builds a stack the way V8 writes one, header line included. */
function stackOf(header: string, ...frames: string[]): string {
  return [header, ...frames].join("\n")
}

describe("what the renderer is allowed to send", () => {
  it("keeps a runtime message it recognises, with the property that was dereferenced", () => {
    const error = new TypeError("Cannot read properties of null (reading 'toLowerCase')")

    expect(bridgePayload(error)).toContain("TypeError: Cannot read properties of null (reading 'toLowerCase')")
  })

  it("keeps the callee of a bad call", () => {
    expect(bridgePayload(new TypeError("installedModTags.map is not a function"))).toContain("TypeError: installedModTags.map is not a function")
  })

  it("keeps a stack overflow apart from a null dereference", () => {
    expect(bridgePayload(new RangeError("Maximum call stack size exceeded"))).toContain("RangeError: Maximum call stack size exceeded")
  })

  it("keeps a bad assignment", () => {
    expect(bridgePayload(new TypeError("Cannot set properties of undefined (setting 'enabled')"))).toContain("TypeError: Cannot set properties of undefined (setting 'enabled')")
  })

  it("keeps a bad spread", () => {
    expect(bridgePayload(new TypeError("installedMods is not iterable"))).toContain("TypeError: installedMods is not iterable")
  })

  it("keeps a bad array size", () => {
    expect(bridgePayload(new RangeError("Invalid array length"))).toContain("RangeError: Invalid array length")
  })

  it("keeps the frames that name a function and a source location", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", "    at loadProfile (app://renderer/profile.js:12:9)", "    at Object.<anonymous> (app://renderer/boot.js:3:4)")

    const payload = bridgePayload(error)

    expect(payload).toContain("at loadProfile (app://renderer/profile.js:12:9)")
    expect(payload).toContain("at Object.<anonymous> (app://renderer/boot.js:3:4)")
  })

  it("keeps the component names React wrote and drops the rest of the component stack", () => {
    const componentStack = "\n    at ManageMods (app://renderer/ManageMods.js:40:7)\n    at PageErrorBoundary"

    const payload = bridgePayload(new Error("boom"), componentStack)

    expect(payload).toContain("Component stack:")
    expect(payload).toContain("    at ManageMods")
    expect(payload).toContain("    at PageErrorBoundary")
    expect(payload).not.toContain("ManageMods.js")
  })
})

describe("a secret nothing marked as one", () => {
  it("does not leave the renderer when it is the error message", () => {
    const payload = bridgePayload(new Error(SECRET))

    expect(payload).not.toContain(SECRET)
    expect(payload).toContain("Error: unclassified-message")
    expect(finalLogText(payload)).not.toContain(SECRET)
  })

  it("does not leave the renderer when it is a rejection reason that is not an Error", () => {
    const payload = bridgePayload(SECRET)

    expect(payload).not.toContain(SECRET)
    expect(payload).toContain("Error: non-error-throw (string)")
    expect(finalLogText(payload)).not.toContain(SECRET)
  })

  it("does not leave the renderer when it is inside a stack frame", () => {
    const error = new Error(`token ${SECRET} is invalid`)
    error.stack = stackOf(`Error: token ${SECRET} is invalid`, "    at loadProfile (app://renderer/profile.js:12:9)", `    at handleSubmit ${SECRET} (app://renderer/form.js:9:1)`, `    ${SECRET}`)

    const payload = bridgePayload(error)

    expect(payload).not.toContain(SECRET)
    // The one frame that looked like a frame is still there, which is what points at the bug.
    expect(payload).toContain("at loadProfile (app://renderer/profile.js:12:9)")
    expect(finalLogText(payload)).not.toContain(SECRET)
  })

  it("does not leave the renderer when it is the name of a custom error class", () => {
    const error = new Error("boom")
    error.name = `TokenError ${SECRET}`

    const payload = bridgePayload(error)

    expect(payload).not.toContain(SECRET)
    expect(payload).toContain("Error: unclassified-message")
    expect(finalLogText(payload)).not.toContain(SECRET)
  })

  it("does not leave the renderer when it is interpolated into a message that almost matches a known shape", () => {
    const payload = bridgePayload(new TypeError(`${SECRET} is not a function`))

    expect(payload).not.toContain(SECRET)
    expect(payload).toContain("TypeError: ? is not a function")
  })
})

describe("a value that fights back", () => {
  it("still logs when the message getter throws, and keeps the stack", () => {
    const error = new Error("boom")
    Object.defineProperty(error, "message", {
      get: () => {
        throw new Error("hostile message getter")
      }
    })
    error.stack = stackOf("Error", "    at boom (app://renderer/a.js:1:2)")

    const payload = bridgePayload(error)

    expect(payload).toContain("Error: unclassified-message")
    expect(payload).toContain("at boom (app://renderer/a.js:1:2)")
  })

  it("still logs when the stack getter throws, and keeps the message", () => {
    const error = new TypeError("Maximum call stack size exceeded")
    Object.defineProperty(error, "stack", {
      get: () => {
        throw new Error("hostile stack getter")
      }
    })

    expect(bridgePayload(error)).toContain("TypeError: Maximum call stack size exceeded")
  })

  it("still logs when toString throws", () => {
    const rejected = {
      toString: (): never => {
        throw new Error("hostile toString")
      }
    }

    expect(bridgePayload(rejected)).toContain("Error: non-error-throw (object)")
  })

  it("still logs when the value is a proxy that throws on every trap", () => {
    const trap = (): never => {
      throw new Error("hostile trap")
    }
    const rejected = new Proxy({}, { get: trap, getPrototypeOf: trap, has: trap })

    expect(bridgePayload(rejected)).toContain("Error: non-error-throw")
  })
})

describe("a payload too big for the bridge", () => {
  /** ~380 characters, the length a bundled source path reaches once it is nested. */
  const longPath = `app://renderer/${"section/".repeat(45)}file.js`

  it("survives a 100 KiB stack, under the limit, still naming the failure", () => {
    const error = new RangeError("Maximum call stack size exceeded")
    error.stack = stackOf("RangeError: Maximum call stack size exceeded", ...Array.from({ length: 300 }, (_, index) => `    at frame${index} (${longPath}:${index + 1}:1)`))
    expect(error.stack.length).toBeGreaterThan(100_000)

    const payload = bridgePayload(error)

    expect(payload.length).toBeLessThan(IPC_LIMIT)
    expect(() => assertString(payload, "log message", IPC_LIMIT)).not.toThrow()
    expect(payload).toContain("RangeError: Maximum call stack size exceeded")
    expect(payload).toContain(`at frame0 (${longPath}:1:1)`)
  })

  it("survives a 100 KiB component stack, under the limit, still naming the component that threw", () => {
    const componentStack = `\n    at ManageMods (${longPath}:40:7)\n${Array.from({ length: 3000 }, (_, index) => `    at Wrapper${index} (${longPath}:1:1)`).join("\n")}`
    expect(componentStack.length).toBeGreaterThan(100_000)

    const payload = bridgePayload(new Error("boom"), componentStack)

    expect(payload.length).toBeLessThan(IPC_LIMIT)
    expect(() => assertString(payload, "log message", IPC_LIMIT)).not.toThrow()
    expect(payload).toContain("    at ManageMods")
  })

  it("survives both oversized at once and still reaches the log file", () => {
    const error = new TypeError("Cannot read properties of null (reading 'toLowerCase')")
    error.stack = stackOf("TypeError: x", ...Array.from({ length: 300 }, (_, index) => `    at frame${index} (${longPath}:${index + 1}:1)`))
    const componentStack = `\n    at ManageMods (${longPath}:40:7)\n${Array.from({ length: 3000 }, (_, index) => `    at Wrapper${index} (${longPath}:1:1)`).join("\n")}`

    const payload = bridgePayload(error, componentStack)

    expect(payload.length).toBeLessThan(IPC_LIMIT)
    expect(finalLogText(payload)).toContain("Cannot read properties of null (reading 'toLowerCase')")
  })
})
