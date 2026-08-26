import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import Logger from "electron-log"
import { afterEach, describe, it } from "vitest"

import { createSafeConsoleWrite, makeConsoleOutputFaultTolerant, suppressStreamWriteErrors } from "../../src/utils/consoleTransportSafety"

/** What Node hands the app when the reader on the other end of stdout is gone. */
function brokenPipeError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("write EPIPE")
  error.code = "EPIPE"
  error.syscall = "write"
  return error
}

/** Every error a guard swallowed, in call order. */
function suppressedErrors(): { errors: unknown[]; onSuppressed: (error: unknown) => void } {
  const errors: unknown[] = []
  return { errors, onSuppressed: (error: unknown): void => void errors.push(error) }
}

describe("suppressStreamWriteErrors", () => {
  it("an unguarded stream turns a failed write into a thrown error", () => {
    // This is the bug: Node's console removes its own noop "error" listener once the
    // synchronous write() call returns, so a later EPIPE has nothing listening for it.
    const stream = new EventEmitter()
    assert.throws(() => stream.emit("error", brokenPipeError()), { code: "EPIPE" })
  })

  it("a guarded stream swallows the EPIPE the closed terminal produces", () => {
    const stream = new EventEmitter()
    const { errors, onSuppressed } = suppressedErrors()
    suppressStreamWriteErrors(stream, onSuppressed)

    assert.doesNotThrow(() => stream.emit("error", brokenPipeError()))
    assert.equal(errors.length, 1)
  })

  it("keeps swallowing every later failure, not just the first", () => {
    const stream = new EventEmitter()
    const { errors, onSuppressed } = suppressedErrors()
    suppressStreamWriteErrors(stream, onSuppressed)

    for (let i = 0; i < 3; i++) assert.doesNotThrow(() => stream.emit("error", brokenPipeError()))
    assert.equal(errors.length, 3)
  })

  it("swallows a stream error that is not EPIPE", () => {
    // Deliberate: an allowlist of codes leaves the app one unlisted code away from the same
    // dialog, and the file transport keeps the full record regardless.
    const stream = new EventEmitter()
    const { errors, onSuppressed } = suppressedErrors()
    suppressStreamWriteErrors(stream, onSuppressed)

    const eio: NodeJS.ErrnoException = Object.assign(new Error("write EIO"), { code: "EIO" })
    assert.doesNotThrow(() => stream.emit("error", eio))
    assert.equal(errors.length, 1)
  })

  it("guards every stream it is handed", () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const { errors, onSuppressed } = suppressedErrors()
    suppressStreamWriteErrors(stdout, onSuppressed)
    suppressStreamWriteErrors(stderr, onSuppressed)

    assert.doesNotThrow(() => stdout.emit("error", brokenPipeError()))
    assert.doesNotThrow(() => stderr.emit("error", brokenPipeError()))
    assert.equal(errors.length, 2)
  })

  it("ignores a missing stream instead of throwing", () => {
    assert.doesNotThrow(() => suppressStreamWriteErrors(undefined))
  })
})

describe("createSafeConsoleWrite", () => {
  it("passes the message through untouched while writes succeed", () => {
    const calls: unknown[][] = []
    const safeWrite = createSafeConsoleWrite((...args: unknown[]) => void calls.push(args))

    safeWrite({ message: { data: ["hello"], level: "info" } })

    assert.deepEqual(calls, [[{ message: { data: ["hello"], level: "info" } }]])
  })

  it("does not propagate an EPIPE thrown by the write", () => {
    const { errors, onSuppressed } = suppressedErrors()
    const safeWrite = createSafeConsoleWrite((): void => {
      throw brokenPipeError()
    }, onSuppressed)

    assert.doesNotThrow(() => safeWrite())
    assert.equal(errors.length, 1)
  })

  it("still attempts the next write after one failed", () => {
    const calls: unknown[] = []
    let attempt = 0
    const safeWrite = createSafeConsoleWrite((arg: unknown): void => {
      attempt++
      if (attempt === 1) throw brokenPipeError()
      calls.push(arg)
    })

    safeWrite("first")
    safeWrite("second")

    assert.deepEqual(calls, ["second"])
  })

  it("swallows a write failure that is not EPIPE", () => {
    // Same deliberate choice as the stream guard: no allowlist of error codes.
    const { errors, onSuppressed } = suppressedErrors()
    const safeWrite = createSafeConsoleWrite((): void => {
      throw new Error("boom")
    }, onSuppressed)

    assert.doesNotThrow(() => safeWrite())
    assert.equal(errors.length, 1)
  })
})

describe("makeConsoleOutputFaultTolerant", () => {
  it("replaces the transport's writeFn with one that cannot throw", () => {
    const transport = {
      writeFn: (): void => {
        throw brokenPipeError()
      }
    }

    makeConsoleOutputFaultTolerant(transport, [])

    assert.doesNotThrow(() => transport.writeFn())
  })

  it("guards the streams it is given as well as the transport", () => {
    const stdoutLike = new EventEmitter()
    const stderrLike = new EventEmitter()
    const transport = { writeFn: (): void => {} }

    makeConsoleOutputFaultTolerant(transport, [stdoutLike, stderrLike])

    assert.doesNotThrow(() => stdoutLike.emit("error", brokenPipeError()))
    assert.doesNotThrow(() => stderrLike.emit("error", brokenPipeError()))
  })
})

describe("electron-log's own console failure, guarded and unguarded", () => {
  const originalWriteFn = Logger.transports.console.writeFn
  afterEach(() => {
    Logger.transports.console.writeFn = originalWriteFn
  })

  it("a failing console transport escapes Logger.info while nothing guards it", () => {
    Logger.transports.console.writeFn = (): void => {
      throw brokenPipeError()
    }

    assert.throws(() => Logger.info("a line nobody can read"), { code: "EPIPE" })
  })

  it("Logger.info survives the same failing transport once it is made fault tolerant", () => {
    Logger.transports.console.writeFn = (): void => {
      throw brokenPipeError()
    }

    makeConsoleOutputFaultTolerant(Logger.transports.console, [])

    assert.doesNotThrow(() => Logger.info("a line nobody can read"))
  })
})
