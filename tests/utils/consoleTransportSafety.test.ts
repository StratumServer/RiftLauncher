import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import Logger from "electron-log"
import { afterEach, describe, it } from "vitest"

import { createSafeConsoleWrite, createSuppressedErrorRecorder, makeConsoleOutputFaultTolerant, suppressStreamWriteErrors } from "../../src/utils/consoleTransportSafety"

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
    const logger = {
      transports: {
        console: Object.assign((): void => {}, {
          writeFn: (): void => {
            throw brokenPipeError()
          }
        })
      }
    }

    makeConsoleOutputFaultTolerant(logger, [])

    assert.doesNotThrow(() => logger.transports.console.writeFn())
  })

  it("guards the streams it is given as well as the transport", () => {
    const stdoutLike = new EventEmitter()
    const stderrLike = new EventEmitter()
    const logger = {
      transports: {
        console: Object.assign(() => {}, { writeFn: (): void => {} })
      }
    }

    makeConsoleOutputFaultTolerant(logger, [stdoutLike, stderrLike])

    assert.doesNotThrow(() => stdoutLike.emit("error", brokenPipeError()))
    assert.doesNotThrow(() => stderrLike.emit("error", brokenPipeError()))
  })

  it("captures callable transport failures without replacing the logger's internal reporter", () => {
    const { errors, onSuppressed } = suppressedErrors()
    const untouched = (): void => {}
    const consoleTransport = Object.assign(
      (): void => {
        throw new TypeError("format hook failed")
      },
      { writeFn: (): void => {} }
    )
    const logger = {
      transports: { console: consoleTransport },
      processInternalErrorFn: untouched
    }

    makeConsoleOutputFaultTolerant(logger, [], onSuppressed)
    assert.doesNotThrow(() => logger.transports.console())

    assert.deepEqual(
      errors.map((error) => String(error)),
      ["TypeError: format hook failed"]
    )
    assert.equal(logger.processInternalErrorFn, untouched)
  })

  it("leaves the reporter alone when there is nothing to record with", () => {
    // Without a recorder, electron-log's own handler is still better than a silent no-op.
    const untouched = (): void => {}
    const logger = {
      transports: { console: Object.assign(() => {}, { writeFn: (): void => {} }) },
      processInternalErrorFn: untouched
    }

    makeConsoleOutputFaultTolerant(logger, [])

    assert.equal(logger.processInternalErrorFn, untouched)
  })
})

describe("createSuppressedErrorRecorder", () => {
  /** Runs one suppression past a collecting file transport and returns the line it was handed. */
  function recordSuppression(error: unknown): { line: string; level: string } {
    const written: { data: unknown[]; level: string }[] = []
    createSuppressedErrorRecorder((message) => void written.push(message))(error)

    const [record] = written
    assert.ok(record, "the recorder wrote nothing to the file transport")
    return { line: String(record.data[0]), level: record.level }
  }

  it("records the first suppressed failure through the file transport", () => {
    const { line, level } = recordSuppression(brokenPipeError())

    assert.equal(level, "error")
    assert.match(line, /console output failed and was suppressed.*Error \(EPIPE\): write EPIPE/)
  })

  it("stays silent after the first one, so a permanently dead pipe writes one line and not thousands", () => {
    const written: unknown[] = []
    const record = createSuppressedErrorRecorder((message) => void written.push(message))

    for (let i = 0; i < 5; i++) record(brokenPipeError())

    assert.equal(written.length, 1)
  })

  it("names the error when it is not a dead pipe, which is the failure this exists to surface", () => {
    const { line } = recordSuppression(new TypeError("hook is not a function"))

    // No errno code on this one, so nothing is invented to fill the slot.
    assert.match(line, /TypeError: hook is not a function/)
    assert.doesNotMatch(line, /TypeError \(/)
  })

  it("redacts credentials out of the error before it reaches disk", () => {
    const { line } = recordSuppression(new Error("write failed for token=hunter2"))

    assert.match(line, /token=\[REDACTED\]/)
    assert.doesNotMatch(line, /hunter2/)
  })

  it("describes a thrown value that is not an Error at all", () => {
    assert.match(recordSuppression("just a string").line, /non-Error value: just a string/)
  })

  it("swallows a failure of its own, because the handler that would catch it is itself", () => {
    const record = createSuppressedErrorRecorder((): void => {
      throw new Error("the file transport is broken too")
    })

    assert.doesNotThrow(() => record(brokenPipeError()))
    // And it does not arm itself for a retry: the flag is set before the write, not after it.
    assert.doesNotThrow(() => record(brokenPipeError()))
  })
})

describe("electron-log's own console failure, guarded and unguarded", () => {
  /** processInternalErrorFn exists on electron-log's Logger class but not in its type definitions. */
  const loggerInternals = Logger as unknown as { processInternalErrorFn: (error: unknown) => void }

  const originalConsoleTransport = Logger.transports.console
  const originalWriteFn = Logger.transports.console.writeFn
  const originalFileTransport = Logger.transports.file
  const originalFormat = Logger.transports.console.format
  const originalTransforms = Logger.transports.console.transforms
  const originalProcessInternalErrorFn = loggerInternals.processInternalErrorFn
  afterEach(() => {
    Logger.transports.console = originalConsoleTransport
    Logger.transports.console.writeFn = originalWriteFn
    Logger.transports.file = originalFileTransport
    Logger.transports.console.format = originalFormat
    Logger.transports.console.transforms = originalTransforms
    loggerInternals.processInternalErrorFn = originalProcessInternalErrorFn
  })

  /**
   * Swaps the singleton's file transport for a collector, so these tests read what the file
   * transport was handed without going near the developer's real Logs directory. The level is
   * set because tests/setup-node.ts pins the real one to false, which would make processMessage
   * skip it and hide the very delivery these tests are about.
   */
  function collectFileTransport(): { data: unknown[] }[] {
    const received: { data: unknown[] }[] = []
    const collector = (message: { data: unknown[] }): void => void received.push(message)
    collector.level = "silly"
    Logger.transports.file = collector as unknown as typeof Logger.transports.file
    return received
  }

  function breakTheConsoleTransport(): void {
    Logger.transports.console.writeFn = (): void => {
      throw brokenPipeError()
    }
  }

  /** Splits what the file transport received into the suppression records and the ordinary log lines. */
  function partitionRecords(received: { data: unknown[] }[]): { records: string[]; lines: unknown[] } {
    const isRecord = (message: { data: unknown[] }): boolean => /console output failed and was suppressed/.test(String(message.data[0]))
    return {
      records: received.filter(isRecord).map((message) => String(message.data[0])),
      lines: received.filter((message) => !isRecord(message)).map((message) => message.data[0])
    }
  }

  /** The same call src/main/index.ts makes, minus the real process streams. */
  function wireTheAppsGuards(): void {
    makeConsoleOutputFaultTolerant(Logger, [], createSuppressedErrorRecorder(Logger.transports.file))
  }

  it("a failing console transport escapes Logger.info while nothing guards it", () => {
    breakTheConsoleTransport()

    assert.throws(() => Logger.info("a line nobody can read"), { code: "EPIPE" })
  })

  it("takes the file transport down with it while nothing guards it", () => {
    // Not a partial record, none at all: electron-log walks its transports in order, console
    // first, and the re-throw out of processInternalErrorFn leaves processMessage before the
    // loop ever reaches the file transport. Losing the console copy loses the on-disk log too.
    const received = collectFileTransport()
    breakTheConsoleTransport()

    assert.throws(() => Logger.info("a line nobody can read"), { code: "EPIPE" })
    assert.equal(received.length, 0)
  })

  it("Logger.info survives the same failing transport once it is made fault tolerant", () => {
    breakTheConsoleTransport()

    makeConsoleOutputFaultTolerant(Logger, [])

    assert.doesNotThrow(() => Logger.info("a line nobody can read"))
  })

  it("keeps delivering to the file transport while the console transport is dead", () => {
    const received = collectFileTransport()
    breakTheConsoleTransport()

    makeConsoleOutputFaultTolerant(Logger, [])
    Logger.info("first line after the pipe died")
    Logger.info("second line after the pipe died")

    assert.deepEqual(
      received.map((message) => message.data[0]),
      ["first line after the pipe died", "second line after the pipe died"]
    )
  })

  it("leaves one suppression record in the file transport, wired the way the app wires it", () => {
    const received = collectFileTransport()
    breakTheConsoleTransport()

    // The same call src/main/index.ts makes, default streams included.
    makeConsoleOutputFaultTolerant(Logger, undefined, createSuppressedErrorRecorder(Logger.transports.file))
    Logger.info("first line after the pipe died")
    Logger.info("second line after the pipe died")

    // The record lands first, from inside the console write that failed, then the two log lines.
    const [record] = received
    assert.ok(record, "no suppression record reached the file transport")
    assert.match(String(record.data[0]), /console output failed and was suppressed.*\(EPIPE\)/)
    assert.deepEqual(
      received.slice(1).map((message) => message.data[0]),
      ["first line after the pipe died", "second line after the pipe died"]
    )
  })

  it("records a throwing console format, which never reaches the write guard at all", () => {
    // The console transport runs its transforms, one of which reads transports.console.format,
    // before it writes anything, so this failure comes out of processMessage's own catch and is
    // reported through processInternalErrorFn. Unhooked, the file transport still gets the line
    // and the app still runs, and the TypeError behind it is never written down anywhere.
    const received = collectFileTransport()
    Logger.transports.console.format = (): never => {
      throw new TypeError("format hook failed")
    }

    wireTheAppsGuards()
    assert.doesNotThrow(() => Logger.info("first line after the format broke"))
    Logger.info("second line after the format broke")

    const { records, lines } = partitionRecords(received)
    assert.equal(records.length, 1, `expected one suppression record, got ${records.length}`)
    assert.match(String(records[0]), /TypeError: format hook failed/)
    assert.deepEqual(lines, ["first line after the format broke", "second line after the format broke"])
  })

  it("redacts the format failure and writes it without going back through the console transport", () => {
    const received = collectFileTransport()
    let consoleWrites = 0
    Logger.transports.console.writeFn = (): void => void consoleWrites++
    Logger.transports.console.format = (): never => {
      throw new TypeError("format hook failed for token=hunter2")
    }

    wireTheAppsGuards()
    Logger.info("a line the console never gets")

    const { records } = partitionRecords(received)
    assert.match(String(records[0]), /token=\[REDACTED\]/)
    assert.doesNotMatch(String(records[0]), /hunter2/)
    // Nothing is echoed to the transport that just failed, which is where the loop would start.
    assert.equal(consoleWrites, 0)
  })

  it("records a throwing transform the same way, since it fails at the same point in the transport", () => {
    const received = collectFileTransport()
    Logger.transports.console.transforms = [
      ...Logger.transports.console.transforms,
      (): never => {
        throw new TypeError("transform hook failed")
      }
    ]

    wireTheAppsGuards()
    assert.doesNotThrow(() => Logger.info("first line after the transform broke"))
    Logger.info("second line after the transform broke")

    const { records, lines } = partitionRecords(received)
    assert.equal(records.length, 1, `expected one suppression record, got ${records.length}`)
    assert.match(String(records[0]), /TypeError: transform hook failed/)
    assert.deepEqual(lines, ["first line after the transform broke", "second line after the transform broke"])
  })

  it("keeps an unrelated file transport failure on electron-log's normal diagnostic path", () => {
    const received: { data: unknown[] }[] = []
    let fileAttempts = 0
    const failingFile = Object.assign(
      (message: { data: unknown[] }): void => {
        fileAttempts++
        if (fileAttempts === 1) throw new Error("disk write failed")
        received.push(message)
      },
      { level: "silly" }
    )
    const consoleMessages: { data: unknown[] }[] = []
    Logger.transports.file = failingFile as unknown as typeof Logger.transports.file
    Logger.transports.console.writeFn = ({ message }): void => void consoleMessages.push(message)

    wireTheAppsGuards()
    assert.doesNotThrow(() => Logger.info("a line with a broken file transport"))

    assert.equal(fileAttempts, 1)
    assert.equal(received.length, 0)
    assert.match(String(consoleMessages[0]?.data[0]), /a line with a broken file transport/)
    assert.equal(consoleMessages[1]?.data[0], "Unhandled electron-log error")
    assert.equal(loggerInternals.processInternalErrorFn, originalProcessInternalErrorFn)
  })

  it("costs one record whichever stage fails first, because every stage shares the one recorder", () => {
    const received = collectFileTransport()
    breakTheConsoleTransport()
    Logger.transports.console.format = (): never => {
      throw new TypeError("format hook failed")
    }

    wireTheAppsGuards()
    for (let i = 0; i < 5; i++) Logger.info("a line nobody can read")

    assert.equal(partitionRecords(received).records.length, 1)
  })
})
