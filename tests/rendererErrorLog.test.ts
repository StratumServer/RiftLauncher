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

/**
 * The same kind of value, shaped like a JS identifier.
 *
 * This is the one the second review caught: identifier syntax proves formatting, not provenance,
 * so every place the old code lifted an identifier out of a message got this value through.
 */
const IDENTIFIER_SECRET = "PASSWORD123"

/** A compiled chunk from our own bundle, the only location shape a frame may name. */
const TRUSTED_LOCATION = "app://renderer/assets/index-abc123.js"

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

/** Asserts a value reaches neither the bridge nor the log file. */
function expectSuppressed(payload: string, secret: string): void {
  expect(payload).not.toContain(secret)
  expect(finalLogText(payload)).not.toContain(secret)
}

describe("what the renderer is allowed to send", () => {
  it("tells a null dereference apart from the other failures", () => {
    const error = new TypeError("Cannot read properties of null (reading 'toLowerCase')")

    expect(bridgePayload(error)).toContain("TypeError: null-property-read")
  })

  it("tells an undefined dereference apart from a null one", () => {
    expect(bridgePayload(new TypeError("Cannot read properties of undefined (reading 'toLowerCase')"))).toContain("TypeError: undefined-property-read")
  })

  it("tells a bad call apart", () => {
    expect(bridgePayload(new TypeError("installedModTags.map is not a function"))).toContain("TypeError: not-a-function")
  })

  it("tells a stack overflow apart from a null dereference", () => {
    expect(bridgePayload(new RangeError("Maximum call stack size exceeded"))).toContain("RangeError: stack-overflow")
  })

  it("tells a bad assignment apart", () => {
    expect(bridgePayload(new TypeError("Cannot set properties of undefined (setting 'enabled')"))).toContain("TypeError: undefined-property-write")
    logMessageMock.mockClear()
    expect(bridgePayload(new TypeError("Cannot set properties of null (setting 'enabled')"))).toContain("TypeError: null-property-write")
  })

  it("tells a bad spread apart", () => {
    expect(bridgePayload(new TypeError("installedMods is not iterable"))).toContain("TypeError: not-iterable")
  })

  it("tells a bad array size apart", () => {
    expect(bridgePayload(new RangeError("Invalid array length"))).toContain("RangeError: invalid-array-length")
  })

  it("keeps the file, line and column of a frame from our own bundle, and nothing else from it", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", `    at loadProfile (${TRUSTED_LOCATION}:12:9)`, "    at Object.<anonymous> (app://renderer/assets/boot-9f8e7d6c.js:3:4)")

    const payload = bridgePayload(error)

    expect(payload).toContain("    at index-abc123.js:12:9")
    expect(payload).toContain("    at boot-9f8e7d6c.js:3:4")
    expect(payload).not.toContain("loadProfile")
    expect(payload).not.toContain("app://")
  })

  it("keeps a frame served by the vite dev server", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", "    at ManageMods (http://localhost:5173/src/renderer/src/pages/ManageMods.tsx?t=1757000000000:40:7)")

    expect(bridgePayload(error)).toContain("    at ManageMods.tsx:40:7")
  })

  it("keeps the component names React wrote and drops the rest of the component stack", () => {
    const componentStack = `\n    at ManageMods (${TRUSTED_LOCATION}:40:7)\n    at PageErrorBoundary`

    const payload = bridgePayload(new Error("boom"), componentStack)

    expect(payload).toContain("Component stack:")
    expect(payload).toContain("    at ManageMods")
    expect(payload).toContain("    at PageErrorBoundary")
    expect(payload).not.toContain("index-abc123.js")
  })
})

describe("a secret nothing marked as one", () => {
  it("does not leave the renderer when it is the error message", () => {
    const payload = bridgePayload(new Error(SECRET))

    expect(payload).toContain("Error: unclassified-message")
    expectSuppressed(payload, SECRET)
  })

  it("does not leave the renderer when it is a rejection reason that is not an Error", () => {
    const payload = bridgePayload(SECRET)

    expect(payload).toContain("Error: non-error-throw (string)")
    expectSuppressed(payload, SECRET)
  })

  it("does not leave the renderer when it is the name of a custom error class", () => {
    const error = new Error("boom")
    error.name = `TokenError ${SECRET}`

    const payload = bridgePayload(error)

    expect(payload).toContain("Error: unclassified-message")
    expectSuppressed(payload, SECRET)
  })
})

describe("a secret shaped like an identifier, which the message shapes used to let through", () => {
  it("does not leave the renderer as the callee of a bad call", () => {
    const payload = bridgePayload(new TypeError(`${IDENTIFIER_SECRET} is not a function`))

    expect(payload).toContain("TypeError: not-a-function")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("does not leave the renderer as the subject of a bad spread", () => {
    const payload = bridgePayload(new TypeError(`${IDENTIFIER_SECRET} is not iterable`))

    expect(payload).toContain("TypeError: not-iterable")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("does not leave the renderer as the property of a null dereference", () => {
    const payload = bridgePayload(new TypeError(`Cannot read properties of null (reading '${IDENTIFIER_SECRET}')`))

    expect(payload).toContain("TypeError: null-property-read")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("does not leave the renderer as the property of a bad assignment", () => {
    const payload = bridgePayload(new TypeError(`Cannot set properties of undefined (setting '${IDENTIFIER_SECRET}')`))

    expect(payload).toContain("TypeError: undefined-property-write")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })
})

describe("a secret inside a stack frame, which the location pattern used to let through", () => {
  it("drops a frame whose location is not a path our build produced", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", `    at loadProfile (app://renderer/${IDENTIFIER_SECRET}:12:9)`, `    at loadProfile (${TRUSTED_LOCATION}:12:9)`)

    const payload = bridgePayload(error)

    // The trusted frame is still there, which is what points at the bug.
    expect(payload).toContain("    at index-abc123.js:12:9")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("drops the function name of a frame it keeps", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", `    at ${IDENTIFIER_SECRET} (${TRUSTED_LOCATION}:1:1)`)

    const payload = bridgePayload(error)

    expect(payload).toContain("    at index-abc123.js:1:1")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("drops a frame whose location is a bare host with no path of ours", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", `    at eval (https://evil.example/${IDENTIFIER_SECRET}.js:1:1)`, `    at run (file:///home/player/${IDENTIFIER_SECRET}.js:1:1)`)

    const payload = bridgePayload(error)

    expect(payload).not.toContain("    at ")
    expectSuppressed(payload, IDENTIFIER_SECRET)
  })

  it("drops the free text a thrown string leaves in the stack", () => {
    const error = new Error(`token ${SECRET} is invalid`)
    error.stack = stackOf(`Error: token ${SECRET} is invalid`, `    at handleSubmit ${SECRET} (${TRUSTED_LOCATION}:9:1)`, `    ${SECRET}`, `    at loadProfile (${TRUSTED_LOCATION}:12:9)`)

    const payload = bridgePayload(error)

    expect(payload).toContain("    at index-abc123.js:12:9")
    expectSuppressed(payload, SECRET)
  })

  it("forwards at most a bounded number of frames", () => {
    const error = new Error("boom")
    error.stack = stackOf("Error: boom", ...Array.from({ length: 300 }, (_, index) => `    at frame${index} (${TRUSTED_LOCATION}:${index + 1}:1)`))

    const kept = bridgePayload(error)
      .split("\n")
      .filter((line) => line.startsWith("    at "))

    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(60)
  })
})

describe("a component name, which comes from our own source rather than from a value", () => {
  it("drops a name that is not shaped like a component", () => {
    const payload = bridgePayload(new Error("boom"), `\n    at ${SECRET}\n    at PageErrorBoundary`)

    expect(payload).toContain("    at PageErrorBoundary")
    expectSuppressed(payload, SECRET)
  })

  it("drops a name too long to be one of ours", () => {
    const longSecret = `S${"9f3a2b1c8d7e6f5a".repeat(4)}`
    expect(longSecret.length).toBeGreaterThan(41)

    const payload = bridgePayload(new Error("boom"), `\n    at ${longSecret}\n    at PageErrorBoundary`)

    expect(payload).toContain("    at PageErrorBoundary")
    expectSuppressed(payload, longSecret)
  })

  it("forwards at most a bounded number of component names", () => {
    const componentStack = `\n${Array.from({ length: 300 }, (_, index) => `    at Wrapper${index}`).join("\n")}`

    const kept = bridgePayload(new Error("boom"), componentStack)
      .split("\n")
      .filter((line) => line.startsWith("    at "))

    expect(kept.length).toBeLessThanOrEqual(60)
  })

  /**
   * The accepted residual, pinned so it stays a decision rather than a surprise. React derives
   * these names from the function names in our own bundle, so a value never lands here on the
   * normal path; the shape check is a backstop, and an uppercase word survives it. Closing it
   * would take a build-time allowlist of every component we ship.
   */
  it("still forwards an uppercase word that happens to look like a component", () => {
    expect(bridgePayload(new Error("boom"), `\n    at ${IDENTIFIER_SECRET}`)).toContain(`    at ${IDENTIFIER_SECRET}`)
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
    error.stack = stackOf("Error", `    at boom (${TRUSTED_LOCATION}:1:2)`)

    const payload = bridgePayload(error)

    expect(payload).toContain("Error: unclassified-message")
    expect(payload).toContain("    at index-abc123.js:1:2")
  })

  it("still logs when the stack getter throws, and keeps the message", () => {
    const error = new TypeError("Maximum call stack size exceeded")
    Object.defineProperty(error, "stack", {
      get: () => {
        throw new Error("hostile stack getter")
      }
    })

    expect(bridgePayload(error)).toContain("TypeError: stack-overflow")
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
  /** ~360 characters, the length a bundled chunk path reaches once it is nested. */
  const longPath = `app://renderer/assets/${"section/".repeat(40)}index-abc123.js`

  it("survives a 100 KiB stack, under the limit, still naming the failure", () => {
    const error = new RangeError("Maximum call stack size exceeded")
    error.stack = stackOf("RangeError: Maximum call stack size exceeded", ...Array.from({ length: 300 }, (_, index) => `    at frame${index} (${longPath}:${index + 1}:1)`))
    expect(error.stack.length).toBeGreaterThan(100_000)

    const payload = bridgePayload(error)

    expect(payload.length).toBeLessThan(IPC_LIMIT)
    expect(() => assertString(payload, "log message", IPC_LIMIT)).not.toThrow()
    expect(payload).toContain("RangeError: stack-overflow")
    expect(payload).toContain("    at index-abc123.js:1:1")
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
    expect(finalLogText(payload)).toContain("null-property-read")
  })
})
