/**
 * Console output must never be able to take the launcher down (#247).
 *
 * Three different failures reach the console transport, at three different points, and they need
 * three different guards. The first two are what a terminal that has gone away produces:
 *
 * 1. Asynchronous. On Linux and macOS a write to process.stdout completes on a later tick,
 *    so the EPIPE arrives as an "error" event on the stream, long after console.info() has
 *    returned. Node's own console adds a noop "error" listener only for the duration of the
 *    synchronous write() call and removes it in a finally block, so nothing is listening by
 *    the time the event fires; an "error" event with no listener is an uncaught exception,
 *    which Electron turns into the "A JavaScript error occurred in the main process" dialog.
 *    A try/catch around the write cannot see this one. A permanent listener can.
 *
 * 2. Synchronous. Where the write does throw in place, electron-log catches it, then reports
 *    it through Logger.processInternalErrorFn, which writes the report to the very same
 *    console transport with no try/catch of its own (node_modules/electron-log/src/node/
 *    createDefaultLogger.js). That second write throws again and escapes into the caller of
 *    Logger.info(). Wrapping writeFn covers both writes, since the internal error reporter
 *    reads transports.console.writeFn at call time.
 *
 * 3. Earlier than the write. The console transport formats and transforms the message before it
 *    writes anything, and a throw from that stage never reaches writeFn at all. electron-log
 *    catches it per transport, so it crashes nothing, and reports it through
 *    processInternalErrorFn, which is where the recorder has to be hooked for the failure to be
 *    diagnosable rather than merely survivable. See makeConsoleOutputFaultTolerant below.
 *
 * Every write error on the guarded streams is swallowed, not only EPIPE: the same "nobody is
 * reading any more" condition surfaces as EIO on a closed pty, ERR_STREAM_DESTROYED or
 * ERR_STREAM_WRITE_AFTER_END on a follow-up write after the stream tore itself down, or
 * ECONNRESET for socket-backed stdio. An allowlist of codes leaves the app one unlisted code
 * away from the same modal dialog, which is the class of bug this guards against. The file
 * transport is untouched by all three, so the Logs directory still records every line the
 * app logs; only the console copy is dropped. The one thing this hides is a genuine ENOSPC
 * from a redirected stdout, judged acceptable since the file transport is the app's real log.
 */

import { redactSensitiveText } from "./logManager"

/** Anything that accepts an "error" listener: process.stdout/process.stderr here, a plain EventEmitter in tests. */
export interface ErrorEmittingStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * Diagnostics seam. Called with every error that was swallowed. Never wire this to logMessage
 * in production: logging to the same broken stream would emit another "error" event, which
 * would call this handler again, an unbounded async loop. createSuppressedErrorRecorder below
 * is the handler production uses; anything else here exists so tests can observe suppression.
 */
export type SuppressedErrorHandler = (error: unknown) => void

/** The subset of electron-log's file transport the recorder calls: Logger.transports.file satisfies it. */
export type LogFileTransport = (message: { data: unknown[]; date: Date; level: "error" }) => void

/** Error name, errno code and message on one line. The code is the part that separates a dead pipe from a real bug. */
function describeSuppressedError(error: unknown): string {
  if (!(error instanceof Error)) return redactSensitiveText(`non-Error value: ${String(error)}`)

  const code = (error as NodeJS.ErrnoException).code
  return redactSensitiveText(`${error.name}${code ? ` (${code})` : ""}: ${error.message}`)
}

/**
 * Records the first suppressed console failure and stays silent afterwards (#256).
 *
 * The catches above keep a dead pipe from taking the app down, but on their own they hide an
 * ordinary transport bug just as completely: a TypeError out of a format hook would vanish with
 * no trace anywhere. This writes one line so that bug is findable. Three properties make the
 * recording safe to do from inside a failing write:
 *
 * - It calls the file transport directly instead of Logger.error, which would fan the message
 *   back out to the very console transport that just failed.
 * - It fires once. A dead pipe fails on every subsequent write, and a per-failure record would
 *   fill the log file with copies of the same error; the flag is set before the write, so a
 *   throw on the way out cannot leave it armed for a second attempt.
 * - It swallows its own failure. The handler that would otherwise catch a throw from here is
 *   this same handler, so letting one escape is how the recursion the guard exists to prevent
 *   would come back.
 */
export function createSuppressedErrorRecorder(writeToFile: LogFileTransport): SuppressedErrorHandler {
  let recorded = false

  return (error: unknown): void => {
    if (recorded) return
    recorded = true

    try {
      writeToFile({
        data: [`[back] [index] [utils/consoleTransportSafety.ts] [onSuppressed] console output failed and was suppressed, later suppressions are silent: ${describeSuppressedError(error)}`],
        date: new Date(),
        level: "error"
      })
    } catch {
      // Nothing to do with it: reporting a failure to report a failure is where the loop starts.
    }
  }
}

/** Keeps a failed write on `stream` from becoming an unhandled "error" event, i.e. an uncaught exception. */
export function suppressStreamWriteErrors(stream: ErrorEmittingStream | undefined, onSuppressed?: SuppressedErrorHandler): void {
  if (!stream) return

  stream.on("error", (error: NodeJS.ErrnoException): void => {
    onSuppressed?.(error)
  })
}

/** Wraps a console write so a throw from it cannot reach the code that called Logger.info(). */
export function createSafeConsoleWrite<Args extends unknown[]>(write: (...args: Args) => void, onSuppressed?: SuppressedErrorHandler): (...args: Args) => void {
  return (...args: Args): void => {
    try {
      write(...args)
    } catch (error) {
      onSuppressed?.(error)
    }
  }
}

/**
 * The parts of electron-log's Logger this file touches. The whole logger is accepted because the
 * console transport must be guarded before electron-log's per-transport error handler runs.
 */
export interface FaultTolerantLogger<Args extends unknown[]> {
  transports: { console: { writeFn: (...args: Args) => void } }
}

/** Wires all three guards. `logger` is electron-log's default export; the generic keeps writeFn's exact signature. */
export function makeConsoleOutputFaultTolerant<Args extends unknown[]>(
  logger: FaultTolerantLogger<Args>,
  streams: readonly (ErrorEmittingStream | undefined)[] = [process.stdout, process.stderr],
  onSuppressed?: SuppressedErrorHandler
): void {
  for (const stream of streams) {
    suppressStreamWriteErrors(stream, onSuppressed)
  }

  const consoleTransport = logger.transports.console
  consoleTransport.writeFn = createSafeConsoleWrite(consoleTransport.writeFn, onSuppressed)

  // The write guard above is the last stage of the console transport, and only that stage. A
  // console transport call is transform() over transports.console.transforms, one of which reads
  // transports.console.format, and only then writeFn (node_modules/electron-log/src/node/
  // transports/console.js). A throw from a format hook or any other transform never reaches the
  // write, so the wrapper cannot see it; processMessage catches it per transport and hands it to
  // processInternalErrorFn. Wrap the callable transport itself so the failure reaches the same
  // bounded recorder without replacing the logger's global error reporter. That keeps unrelated
  // file, IPC, and remote transport errors on electron-log's normal diagnostic path.
  if (onSuppressed) {
    const callableTransport = consoleTransport as typeof consoleTransport & ((...args: unknown[]) => void)
    logger.transports.console = new Proxy(callableTransport, {
      apply(target, thisArg, args): void {
        try {
          Reflect.apply(target, thisArg, args)
        } catch (error) {
          onSuppressed(error)
        }
      }
    }) as typeof consoleTransport
  }
}
