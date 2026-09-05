const LOG_TAG = "[front] [app] [adapters/errorLog.ts]"

/**
 * Error names that may be repeated as they are. Everything else logs as "Error".
 *
 * A custom error class can be named after whatever built it, and nothing stops that name from
 * carrying a value, so only the built-in names React and the DOM actually raise get through.
 */
const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "DOMException"])

/** A JS identifier or a dotted member path, which is all a runtime message ever names. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const IDENTIFIER_MAX_LENGTH = 48

/** What goes in the place of an identifier that did not look like one. */
const UNKNOWN_IDENTIFIER = "?"

/** What goes in the place of a message that matched no known shape. */
const UNCLASSIFIED_MESSAGE = "unclassified-message"

/**
 * The runtime-error messages worth keeping, and the only ones kept.
 *
 * An error message is an arbitrary string: `new Error(token)` puts a credential in it, and so does
 * a rejected fetch quoting a signed URL. Forwarding it and hoping the main-process redactor
 * recognises the value is the mistake #368 closed everywhere else. So no message is forwarded as
 * it was written. A message either matches one of the shapes V8 raises by itself, in which case
 * the shape's own fixed template is emitted with at most an identifier lifted out of it, or it is
 * replaced by a token.
 *
 * The shapes below cover what a page actually dies of: a null dereference, a bad assignment, a
 * bad call, a bad spread, a runaway recursion, a bad array size. A maintainer can still tell them apart, which is the whole
 * job of the message field.
 */
const MESSAGE_SHAPES: readonly { readonly pattern: RegExp; readonly build: (match: RegExpExecArray) => string }[] = [
  {
    pattern: /^Cannot read properties of (null|undefined) \(reading '([^']*)'\)$/,
    build: (match) => `Cannot read properties of ${match[1]} (reading '${asIdentifier(match[2])}')`
  },
  {
    pattern: /^Cannot set properties of (null|undefined) \(setting '([^']*)'\)$/,
    build: (match) => `Cannot set properties of ${match[1]} (setting '${asIdentifier(match[2])}')`
  },
  { pattern: /^(.*) is not a function$/, build: (match) => `${asIdentifier(match[1])} is not a function` },
  { pattern: /^(.*) is not iterable$/, build: (match) => `${asIdentifier(match[1])} is not iterable` },
  { pattern: /^Maximum call stack size exceeded$/, build: () => "Maximum call stack size exceeded" },
  { pattern: /^Invalid array length$/, build: () => "Invalid array length" }
]

/**
 * A JS stack frame, kept only in the shape V8 writes for a named call site.
 *
 * The header line of a stack repeats the message, an interpolated string thrown instead of an
 * Error lands in the stack too, and a frame from an eval or a data URL carries whatever was in it.
 * None of those match this, so all of them are dropped. What survives is a function name and a
 * source location, which is what points at the bug.
 */
const STACK_FRAME_PATTERN = /^\s*at (?:new |async )?((?:[A-Za-z_$][A-Za-z0-9_$]*|<anonymous>)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|<anonymous>|<computed>))*) \(([^\s()]{1,400}:\d{1,9}:\d{1,9})\)$/

/** A React component-stack line. React writes the component name itself, the location is dropped. */
const COMPONENT_FRAME_PATTERN = /^\s*at ([A-Za-z_$][A-Za-z0-9_$]*)(?:[\s(]|$)/

/** A coarse ceiling on how deep a stack is worth reading. The byte budget below is the real bound. */
const MAX_FRAMES = 60

/**
 * The byte budget for one log line.
 *
 * `assertString(message, "log message", 16_384)` in src/ipc/handlers/utilsHandlers.ts rejects
 * anything longer, and a rejected line is replaced by a generic warning: the whole event is lost,
 * which is worse than a short one. A recursion stack is tens of thousands of frames and a bundled
 * path is long, so an unbounded report crosses that limit easily. This sits at half of it, leaving
 * room for the tag and for redaction, which only ever makes a line longer.
 */
const MAX_REPORT_BYTES = 8_192

/** Runs `read` and returns `fallback` if it throws. Every field is read through this. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function asIdentifier(value: string | undefined): string {
  return value !== undefined && value.length <= IDENTIFIER_MAX_LENGTH && IDENTIFIER_PATTERN.test(value) ? value : UNKNOWN_IDENTIFIER
}

function classifyMessage(message: string): string {
  for (const { pattern, build } of MESSAGE_SHAPES) {
    const match = pattern.exec(message)
    if (match) return build(match)
  }

  return UNCLASSIFIED_MESSAGE
}

function safeFrames(stack: string, pattern: RegExp, render: (match: RegExpExecArray) => string): string[] {
  const frames: string[] = []

  for (const line of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break

    const match = pattern.exec(line)
    if (match) frames.push(render(match))
  }

  return frames
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function joinReport(header: string, frames: readonly string[], componentFrames: readonly string[]): string {
  const lines = [header, ...frames]
  if (componentFrames.length > 0) lines.push("Component stack:", ...componentFrames)

  return lines.join("\n")
}

/**
 * Turns whatever was thrown into a fixed payload: a known error name, a classified message, and
 * two lists of frames that matched a frame pattern. No value read off the error reaches the log
 * unless it survived one of those filters.
 *
 * Every read happens through `guarded`, field by field. A hostile getter or a `toString` that
 * throws is a real shape here (the global "error" listener sees whatever a page threw), and this
 * runs inside that listener, so a throw from here would be reported as another uncaught error and
 * handed straight back. Per field rather than around the whole thing, so one bad getter costs its
 * own field and not the stack that says where the bug is.
 */
function buildReport(source: string, error: unknown, componentStack?: string | null): string {
  const isError = guarded(() => error instanceof Error, false)

  const rawName = isError ? guarded(() => String((error as Error).name), "Error") : "Error"
  const name = SAFE_ERROR_NAMES.has(rawName) ? rawName : "Error"
  const message = isError ? classifyMessage(guarded(() => String((error as Error).message), "")) : `non-error-throw (${guarded(() => typeof error, "unknown")})`

  const frames = guarded(() => safeFrames(String((error as Error).stack ?? ""), STACK_FRAME_PATTERN, (match) => `    at ${match[1]} (${match[2]})`), [] as string[])
  const componentFrames = guarded(() => safeFrames(String(componentStack ?? ""), COMPONENT_FRAME_PATTERN, (match) => `    at ${match[1]}`), [] as string[])

  const header = `${LOG_TAG} [${source}] ${name}: ${message}`

  // Trim to the budget: the frame lists first, longest one at a time, then the header itself.
  let report = joinReport(header, frames, componentFrames)
  while (byteLength(report) > MAX_REPORT_BYTES && frames.length + componentFrames.length > 0) {
    if (componentFrames.length >= frames.length) componentFrames.pop()
    else frames.pop()

    report = joinReport(header, frames, componentFrames)
  }

  return byteLength(report) > MAX_REPORT_BYTES ? report.slice(0, MAX_REPORT_BYTES) : report
}

/**
 * Writes a renderer exception to the log file through the preload bridge.
 *
 * What goes in is built by `buildReport` and nothing else: no route, no props, no config, and no
 * string that came off the error without being matched first. `redactSensitiveText`
 * (src/utils/logManager.ts) still runs on the main-process side, but it only recognises marked
 * fields, known query keys and absolute paths, so it cannot un-log a bare value this function had
 * no business reading in the first place. This one does not read them.
 *
 * The write is guarded because this is the last thing standing when something has already gone
 * wrong. If the bridge itself is missing (a preload that failed to load), throwing from here would
 * be reported as another uncaught error, which the global listener below would hand straight back.
 */
export function logRenderError(source: string, error: unknown, componentStack?: string | null): void {
  try {
    window.api.utils.logMessage("error", buildReport(source, error, componentStack))
  } catch {
    // Nothing left to report it to.
  }
}

/**
 * Catches what an error boundary cannot: throws from event handlers, timers and async code, and
 * rejected promises nobody awaited. React only sees exceptions raised during render, commit and
 * lifecycle, so without these two listeners a player's error.log stays empty for a whole class of
 * failure. React also rethrows a render error no boundary caught, which reaches the "error"
 * listener, so a throw in the shell itself is logged too.
 *
 * Both handlers log and return. They do not preventDefault and they do not rethrow: swallowing an
 * error here would hide it from the devtools console during development for no gain in the field.
 *
 * Returns a disposer. The app never calls it (these live as long as the window does), tests do.
 */
export function installGlobalErrorLogging(): () => void {
  const onError = (event: ErrorEvent): void => logRenderError("window.error", event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent): void => logRenderError("window.unhandledrejection", event.reason)

  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onRejection)

  return (): void => {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onRejection)
  }
}
