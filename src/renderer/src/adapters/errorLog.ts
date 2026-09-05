const LOG_TAG = "[front] [app] [adapters/errorLog.ts]"

/**
 * Error names that may be repeated as they are. Everything else logs as "Error".
 *
 * A custom error class can be named after whatever built it, and nothing stops that name from
 * carrying a value, so only the built-in names React and the DOM actually raise get through.
 */
const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "DOMException"])

/** What goes in the place of a message that matched no known shape. */
const UNCLASSIFIED_MESSAGE = "unclassified-message"

/**
 * The runtime-error messages worth telling apart, reduced to a fixed token each.
 *
 * An error message is an arbitrary string: `new Error(token)` puts a credential in it, and so does
 * a rejected fetch quoting a signed URL. Forwarding it and hoping the main-process redactor
 * recognises the value is the mistake #368 closed everywhere else.
 *
 * A first attempt kept the identifier V8 interpolates into these messages, on the grounds that a
 * property name is identifier-shaped and therefore harmless. That is wrong, and it is the same
 * mistake twice: identifier syntax proves formatting, not provenance. `new TypeError("PASSWORD123
 * is not a function")` is a message any code can build, and `PASSWORD123` is a perfectly good
 * identifier. So nothing captured out of a message is forwarded now. A message either matches one
 * of the shapes below, in which case its fixed token is emitted and nothing else, or it becomes
 * UNCLASSIFIED_MESSAGE.
 *
 * The token says what kind of failure it was: a null dereference, a bad assignment, a bad call, a
 * bad spread, a runaway recursion, a bad array size. Which property or callee it was is not here
 * on purpose. The stack frames below say which file and line to open, which is where a maintainer
 * reads the name off our own source.
 */
const MESSAGE_TOKENS: readonly { readonly pattern: RegExp; readonly token: string }[] = [
  { pattern: /^Cannot read properties of null \(reading '[^']*'\)$/, token: "null-property-read" },
  { pattern: /^Cannot read properties of undefined \(reading '[^']*'\)$/, token: "undefined-property-read" },
  { pattern: /^Cannot set properties of null \(setting '[^']*'\)$/, token: "null-property-write" },
  { pattern: /^Cannot set properties of undefined \(setting '[^']*'\)$/, token: "undefined-property-write" },
  { pattern: / is not a function$/, token: "not-a-function" },
  { pattern: / is not iterable$/, token: "not-iterable" },
  { pattern: /^Maximum call stack size exceeded$/, token: "stack-overflow" },
  { pattern: /^Invalid array length$/, token: "invalid-array-length" }
]

/**
 * A JS stack frame, in either shape V8 writes: `at name (location)` and the bare `at location`.
 *
 * Only the location is captured. A function name is a capture like any other, and a stack is not
 * a trusted document: `error.stack` is a writable property, and a string thrown instead of an
 * Error lands there verbatim. `at PASSWORD123 (app://renderer/assets/index-abc123.js:1:1)` is a
 * frame anything can write, so the name goes and the location is checked separately.
 */
const STACK_FRAME_PATTERN = /^\s*at (?:[^()]*\(([^\s()]{1,400})\)|([^\s()]{1,400}))\s*$/

/**
 * The only source locations the renderer is allowed to name, and the file name lifted out of one.
 *
 * The two prefixes are where our own renderer code actually runs, taken from src/main/index.ts:
 * the packaged window loads `app://renderer/index.html` and the app protocol serves it out of the
 * bundle directory, so every compiled chunk is `app://renderer/assets/<name>-<hash>.js`; the dev
 * window loads `process.env.ELECTRON_RENDERER_URL`, the vite server on localhost, which serves
 * modules under `/src/`. `isAllowedRendererUrl` in src/ipc/validation.ts is the main-process side
 * of the same two shapes.
 *
 * Anything else is dropped whole, which is what closes the second finding: the old pattern took
 * any non-whitespace text, so `app://renderer/PASSWORD123:12:9` was a valid location and the
 * secret went to the log. A path is not under one of these two prefixes unless our own build put
 * it there.
 *
 * Only the last segment is emitted, and only when it is a plain file name. Directory segments are
 * dropped: they are noise once the file name is known, and a shorter surface is a cheaper one to
 * argue about. Residual: a hand-written `stack` naming a file that does not exist in the bundle,
 * `app://renderer/assets/PASSWORD123.js:1:1`, still yields `PASSWORD123.js`. That is one path
 * segment with no separators and a source-file extension. Real frames come from files the build
 * produced, so tightening past this would cost more than the residual is worth.
 */
const TRUSTED_LOCATION_PATTERN =
  /^(?:app:\/\/renderer\/assets\/|https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}\/src\/)(?:[A-Za-z0-9_.-]{1,64}\/)*([A-Za-z0-9_.-]{1,64}\.(?:js|mjs|ts|tsx))(?:\?[^\s:]{0,128})?:(\d{1,9}):(\d{1,9})$/

/**
 * A React component-stack line, reduced to the component name.
 *
 * These names are treated as provenance-safe where message identifiers are not, and the reason is
 * where they come from rather than what they look like. React builds a component stack out of the
 * function names of the components it rendered, so every name in it was written in our own source
 * and shipped in our own bundle. A message identifier is the opposite: it is whatever value was in
 * scope when the error was built, which is exactly where a credential lives.
 *
 * The shape check is here anyway, because that argument is about the normal path and this code
 * runs on the abnormal one. A component stack arrives as a plain string on React's error info and
 * on a manually thrown value, so the name must still be a short PascalCase word, and the count is
 * capped. Residual, tested and accepted: an uppercase credential-shaped word such as `PASSWORD123`
 * passes the shape check. Closing it would need an allowlist of every component we ship, which is
 * a build-time list to keep in sync for a value React does not put there.
 */
const COMPONENT_FRAME_PATTERN = /^\s*at ([A-Z][A-Za-z0-9]{0,40})(?:[\s(]|$)/

/** How many frames of either kind are worth forwarding. The byte budget below is the other bound. */
const MAX_FRAMES = 60

/**
 * The byte budget for one log line.
 *
 * `assertString(message, "log message", 16_384)` in src/ipc/handlers/utilsHandlers.ts rejects
 * anything longer, and a rejected line is replaced by a generic warning: the whole event is lost,
 * which is worse than a short one. A recursion stack is tens of thousands of frames, so an
 * unbounded report crosses that limit easily. This sits at half of it, leaving room for the tag
 * and for redaction, which only ever makes a line longer.
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

function classifyMessage(message: string): string {
  return MESSAGE_TOKENS.find(({ pattern }) => pattern.test(message))?.token ?? UNCLASSIFIED_MESSAGE
}

/** The sanitised `file.js:12:9` for a stack line, or undefined when the line is not ours to keep. */
function safeStackFrame(line: string): string | undefined {
  const frame = STACK_FRAME_PATTERN.exec(line)
  if (!frame) return undefined

  const location = TRUSTED_LOCATION_PATTERN.exec(frame[1] ?? frame[2] ?? "")
  return location ? `    at ${location[1]}:${Number(location[2])}:${Number(location[3])}` : undefined
}

function safeComponentFrame(line: string): string | undefined {
  const match = COMPONENT_FRAME_PATTERN.exec(line)
  return match ? `    at ${match[1]}` : undefined
}

function safeFrames(stack: string, render: (line: string) => string | undefined): string[] {
  const frames: string[] = []

  for (const line of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break

    const frame = render(line)
    if (frame !== undefined) frames.push(frame)
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
 * Turns whatever was thrown into a fixed payload: a known error name, a message token, file names
 * from our own bundle with a line and a column, and component names. Nothing else. No text read
 * off the error is forwarded as it was written.
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

  const frames = guarded(() => safeFrames(String((error as Error).stack ?? ""), safeStackFrame), [] as string[])
  const componentFrames = guarded(() => safeFrames(String(componentStack ?? ""), safeComponentFrame), [] as string[])

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
