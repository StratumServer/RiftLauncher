/**
 * Console output must never be able to take the launcher down (#247).
 *
 * Two different failures are possible when the terminal that started the app goes away, and
 * they need two different guards:
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
 * Every write error on the guarded streams is swallowed, not only EPIPE: the same "nobody is
 * reading any more" condition surfaces as EIO on a closed pty, ERR_STREAM_DESTROYED or
 * ERR_STREAM_WRITE_AFTER_END on a follow-up write after the stream tore itself down, or
 * ECONNRESET for socket-backed stdio. An allowlist of codes leaves the app one unlisted code
 * away from the same modal dialog, which is the class of bug this guards against. The file
 * transport is untouched by either guard, so the Logs directory still records every line the
 * app logs; only the console copy is dropped. The one thing this hides is a genuine ENOSPC
 * from a redirected stdout, judged acceptable since the file transport is the app's real log.
 */

/** Anything that accepts an "error" listener: process.stdout/process.stderr here, a plain EventEmitter in tests. */
export interface ErrorEmittingStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * Diagnostics seam. Called with every error that was swallowed. Never wire this to logMessage
 * in production: logging to the same broken stream would emit another "error" event, which
 * would call this handler again, an unbounded async loop. It exists so tests can observe
 * suppression, and so a future caller can route to the file transport only if that ever
 * becomes necessary.
 */
export type SuppressedErrorHandler = (error: unknown) => void

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

/** Wires both guards. `consoleTransport` is electron-log's Logger.transports.console; the generic keeps its exact writeFn signature. */
export function makeConsoleOutputFaultTolerant<Args extends unknown[]>(
  consoleTransport: { writeFn: (...args: Args) => void },
  streams: readonly (ErrorEmittingStream | undefined)[] = [process.stdout, process.stderr],
  onSuppressed?: SuppressedErrorHandler
): void {
  for (const stream of streams) {
    suppressStreamWriteErrors(stream, onSuppressed)
  }

  consoleTransport.writeFn = createSafeConsoleWrite(consoleTransport.writeFn, onSuppressed)
}
