import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it } from "vitest"
import * as ts from "typescript"

import { parseLegacyAccount, parseLoginAccount } from "../src/domain/account/credentials"
import { isAllowedRendererUrl, parseSafeEnvironment, validateGameInstallation, validateGameVersion } from "../src/ipc/validation"

describe("credential boundaries", () => {
  it("keeps session credentials out of the public account object", () => {
    const credentials = parseLoginAccount("player@example.test", {
      playername: "Player",
      uid: "uid-1",
      entitlements: "game",
      hasgameserver: 1,
      sessionkey: "session-key",
      sessionsignature: "session-signature",
      mptoken: "multiplayer-token"
    })

    assert.deepEqual(credentials.publicAccount, {
      email: "player@example.test",
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: true
    })
    assert.equal("sessionKey" in credentials.publicAccount, false)
    assert.equal("sessionSignature" in credentials.publicAccount, false)
    assert.equal("mptoken" in credentials.publicAccount, false)
  })

  it("can read legacy credentials only in the main-process migration shape", () => {
    const legacy = parseLegacyAccount({
      email: "player@example.test",
      playerName: "Player",
      playerUid: "uid-1",
      playerEntitlements: "game",
      hostGameServer: false,
      sessionKey: "session-key",
      sessionSignature: "session-signature",
      mptoken: null
    })

    assert.equal(legacy?.secrets.sessionKey, "session-key")
    assert.equal(legacy?.publicAccount.playerName, "Player")
  })
})

describe("process and navigation boundaries", () => {
  it("rejects dangerous environment overrides", () => {
    assert.deepEqual(parseSafeEnvironment("LANG=en_US,VS_LAUNCHER_TEST=1"), { LANG: "en_US", VS_LAUNCHER_TEST: "1" })
    assert.throws(() => parseSafeEnvironment("PATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("NODE_OPTIONS=--require=/tmp/payload"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("PYTHONPATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => parseSafeEnvironment("bad-entry"), /Invalid environment variable/)
  })

  it("validates game launch objects instead of trusting TypeScript casts", () => {
    assert.deepEqual(validateGameVersion({ version: "1.22.6", path: "/tmp/versions/1.22.6" }), { version: "1.22.6", path: "/tmp/versions/1.22.6" })
    assert.deepEqual(validateGameInstallation({ path: "/tmp/installations/main", startParams: "", mesaGlThread: false, envVars: "" }), {
      path: "/tmp/installations/main",
      startParams: "",
      mesaGlThread: false,
      envVars: "",
      launchWrapper: ""
    })
    assert.throws(() => validateGameVersion({ version: "1.22.6", path: "/" }), /Invalid game version path/)
    assert.throws(() => parseSafeEnvironment("PATH=/tmp"), /Invalid environment variable/)
    assert.throws(() => validateGameInstallation({ path: "/tmp/installations/main", startParams: "", mesaGlThread: false, envVars: "", launchWrapper: "x".repeat(4_097) }), /Invalid launch wrapper/)
  })

  it("accepts only the exact renderer document or development origin", () => {
    const packagedPath = resolve("/tmp/out/renderer/index.html")
    assert.equal(isAllowedRendererUrl(`${pathToFileURL(packagedPath).toString()}#/home`, undefined, packagedPath), true)
    assert.equal(isAllowedRendererUrl(`${pathToFileURL(`${packagedPath}.evil`).toString()}`, undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://renderer/index.html#/home", undefined, packagedPath), true)
    assert.equal(isAllowedRendererUrl("app://renderer/index.html?file=outside", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://renderer/other.html", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("app://evil/index.html", undefined, packagedPath), false)
    assert.equal(isAllowedRendererUrl("http://localhost:5173/#/home", "http://localhost:5173", "/tmp/out/renderer/index.html"), true)
    assert.equal(isAllowedRendererUrl("http://localhost:5173.evil/#/home", "http://localhost:5173", "/tmp/out/renderer/index.html"), false)
  })
})

/**
 * src/main/index.ts cannot be imported here: it is the Electron main process
 * bootstrap and runs app.whenReady() on load. The property worth guarding does
 * not need it running, so this reads the source, the same approach
 * tests/ipc/accountLoginFlow.test.ts takes with the login handler.
 *
 * The property: both session calls survive. setSpellCheckerLanguages([]) is the
 * one that keeps a fresh profile from downloading a multi-megabyte hunspell
 * dictionary from a third-party CDN (#129, #132), and setSpellCheckerEnabled(false)
 * sitting next to it makes the pair look redundant. Both assertions match on the
 * session.defaultSession. prefix so that a comment naming either method cannot
 * satisfy them.
 */
const MAIN_SOURCE = readFileSync(resolve(__dirname, "../src/main/index.ts"), "utf8")
const PRELOAD_SOURCE = readFileSync(resolve(__dirname, "../src/preload/index.ts"), "utf8")
const RENDERER_HTML = readFileSync(resolve(__dirname, "../src/renderer/index.html"), "utf8")
const MAIN_AST = ts.createSourceFile("src/main/index.ts", MAIN_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

describe("startup network boundaries", () => {
  it("keeps both session calls that stop the spellcheck dictionary download", () => {
    assert.equal(MAIN_SOURCE.includes("session.defaultSession.setSpellCheckerLanguages([])"), true, "src/main/index.ts stopped clearing the spellchecker language list")
    assert.equal(MAIN_SOURCE.includes("session.defaultSession.setSpellCheckerEnabled(false)"), true, "src/main/index.ts stopped disabling the session spellchecker")
  })

  it("keeps the mod icon cache lifecycle wiring in the main process", () => {
    assert.equal(MAIN_SOURCE.includes("ipcMain.on(IPC_CHANNELS.MODS_MANAGER.CLEAR_MOD_ICON_MEMORY_CACHE"), true, "src/main/index.ts stopped registering the trusted mod icon cache clear handler")

    const windowClosedStart = MAIN_SOURCE.indexOf('app.on("window-all-closed"')
    assert.notEqual(windowClosedStart, -1, "src/main/index.ts stopped registering the window-close handler")
    assert.equal(MAIN_SOURCE.slice(windowClosedStart).includes("clearModIconMemoryCache(modIconMemoryCache)"), true, "src/main/index.ts stopped clearing the mod icon cache when all windows close")
  })

  // An offline launch of a packaged build rejects the update check, and a
  // rejection nobody catches takes the main process down with it. The check
  // itself lives in autoUpdaterEvents.ts, which tests/main/autoUpdaterEvents.test.ts
  // exercises for real; this keeps index.ts from growing a second, uncaught one.
  it("leaves the startup update check to the module that catches its rejection", () => {
    assert.equal(MAIN_SOURCE.includes("scheduleUpdateCheck("), true, "src/main/index.ts stopped arming the startup update check")
    assert.equal(MAIN_SOURCE.includes("autoUpdater.checkForUpdates("), false, "src/main/index.ts calls checkForUpdates itself again, where nothing catches its rejection")
  })

  it("keeps the local app protocol CORS-aware and records non-renderer child exits", () => {
    assert.equal(MAIN_SOURCE.includes("corsEnabled: true"), true, "the app protocol lost its CORS enforcement for cross-origin renderer paths")
    assert.equal(MAIN_SOURCE.includes('app.on("child-process-gone"'), true, "non-renderer child process failures are no longer logged")
  })
})

/**
 * The renderer CSP is one long attribute, so a substring match on it is a poor
 * pin: "script-src 'self'" is still present after someone appends a host to the
 * source list. Parsing the attribute into directives means the assertion below
 * compares the value the browser will actually apply, and it survives a
 * reordering or a reflow of the attribute.
 */
function rendererCspDirectives(html = RENDERER_HTML): Map<string, string> {
  const activeMetaTags = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<meta\b[^>]*>/gi)
    ?.map((tag) => {
      const attributes = new Map<string, string>()
      for (const match of tag.matchAll(/\b([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)) {
        const rawName = match[1] ?? ""
        const value = match[3] ?? ""
        attributes.set(rawName.toLowerCase(), value)
      }
      return attributes
    })
    .filter((attributes) => attributes.get("http-equiv")?.toLowerCase() === "content-security-policy")
    .map((attributes) => attributes.get("content"))
    .filter((policy): policy is string => policy !== undefined)

  if (activeMetaTags?.length !== 1) {
    throw new Error(`Expected exactly one active Content-Security-Policy meta tag, found ${activeMetaTags?.length ?? 0}`)
  }

  const policy = activeMetaTags[0]
  if (policy === undefined) throw new Error("Content-Security-Policy meta tag has no content attribute")

  const directives = new Map<string, string>()
  for (const directive of policy
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const [rawName = "", ...sources] = directive.split(/\s+/)
    const name = rawName.toLowerCase()
    if (directives.has(name)) throw new Error(`Duplicate CSP directive: ${name}`)
    directives.set(name, sources.join(" "))
  }
  return directives
}

describe("renderer document boundaries", () => {
  it("keeps every renderer script source local", () => {
    const directives = rendererCspDirectives()

    assert.equal(directives.get("script-src"), "'self'", `renderer script-src is now ${JSON.stringify(directives.get("script-src"))}; the renderer must not run script from anywhere but the bundle`)
    assert.equal(directives.get("default-src"), "'self'", `renderer default-src is now ${JSON.stringify(directives.get("default-src"))}; it is the fallback every directive that goes missing lands on`)
    assert.equal(directives.get("object-src"), "'none'", "renderer object-src stopped blocking plugin content")
    assert.equal(directives.get("base-uri"), "'none'", "renderer base-uri stopped blocking a rewritten document base")
  })

  it("rejects duplicate CSP directives instead of hiding the first policy", () => {
    const duplicatePolicy = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'; script-src https://evil.example">'
    assert.throws(() => rendererCspDirectives(duplicatePolicy), /Duplicate CSP directive: script-src/)

    const caseVariantPolicy = '<meta http-equiv="Content-Security-Policy" content="SCRIPT-SRC https://evil.example; script-src \'self\'">'
    assert.throws(() => rendererCspDirectives(caseVariantPolicy), /Duplicate CSP directive: script-src/)
  })

  it("reads one active CSP meta tag and ignores comments", () => {
    const commentedPolicy = '<!-- <meta http-equiv="Content-Security-Policy" content="script-src https://evil.example"> --><meta http-equiv="Content-Security-Policy" content="script-src \'self\'">'
    assert.equal(rendererCspDirectives(commentedPolicy).get("script-src"), "'self'")

    const multiplePolicies = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><meta http-equiv="Content-Security-Policy" content="script-src https://evil.example">'
    assert.throws(() => rendererCspDirectives(multiplePolicies), /Expected exactly one active Content-Security-Policy meta tag, found 2/)
  })

  it("does not allow framed content in the renderer CSP", () => {
    assert.equal(rendererCspDirectives().get("frame-src"), "'none'")
  })

  it("exposes the preload bridge only in the main frame", () => {
    const guardStart = PRELOAD_SOURCE.lastIndexOf("if (process.isMainFrame)")
    const exposeStart = PRELOAD_SOURCE.indexOf('contextBridge.exposeInMainWorld("api", api)')

    assert.notEqual(guardStart, -1, "preload stopped checking process.isMainFrame")
    assert.notEqual(exposeStart, -1, "preload stopped exposing the launcher API")
    assert.ok(guardStart < exposeStart, "preload exposes the API before its main-frame guard")
    // Ensure the expose call sits inside the guarded block, not outside it
    // as a dead-statement hoist. The pattern is anchored so a dead guard
    // followed by a hoisted expose (or an empty guard block) breaks it.
    assert.match(PRELOAD_SOURCE.slice(guardStart, exposeStart), /^if \(process\.isMainFrame\) \{\s*(try \{\s*)?$/)
    // Exactly one exposeInMainWorld keeps a future duplicate from leaking
    // the bridge into every frame.
    const exposeCount = PRELOAD_SOURCE.split("contextBridge.exposeInMainWorld").length - 1
    assert.equal(exposeCount, 1, `preload has ${exposeCount} exposeInMainWorld calls; expected exactly 1`)
  })
})

function findNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const matches: T[] = []

  function visit(node: ts.Node): void {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }

  visit(root)
  return matches
}

function findCreateWindow(): ts.FunctionDeclaration {
  const functions = findNodes(MAIN_AST, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow")
  if (functions.length !== 1 || functions[0]?.body === undefined) throw new Error(`Expected one createWindow function with a body, found ${functions.length}`)
  return functions[0]
}

function sourceAst(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function uniqueProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const matches = object.properties.filter((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && propertyName(property.name) === name)
  if (matches.length !== 1 || matches[0] === undefined) throw new Error(`Expected exactly one ${name} property, found ${matches.length}`)
  return matches[0]
}

function functionHandler(call: ts.CallExpression, method: string): ts.ArrowFunction {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== method) throw new Error(`Expected a ${method} call`)
  const handler = call.arguments[0]
  if (handler === undefined || !ts.isArrowFunction(handler)) throw new Error(`${method} must receive an arrow-function handler`)
  return handler
}

function directCallStatements(body: ts.Block): ts.CallExpression[] {
  return body.statements
    .filter((statement): statement is ts.ExpressionStatement => ts.isExpressionStatement(statement))
    .map((statement) => statement.expression)
    .filter((expression): expression is ts.CallExpression => ts.isCallExpression(expression))
}

function isMainWindowWebContentsCall(call: ts.CallExpression, method: string): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== method) return false
  const receiver = call.expression.expression
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === "webContents" && ts.isIdentifier(receiver.expression) && receiver.expression.text === "mainWindow"
}

function webContentsHandler(ast: ts.SourceFile, method: string): ts.ArrowFunction {
  const createWindow = findNodes(ast, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow")[0]
  if (createWindow?.body === undefined) throw new Error("Expected a createWindow function with a body")

  const calls = directCallStatements(createWindow.body).filter((call) => isMainWindowWebContentsCall(call, method))

  if (calls.length !== 1 || calls[0] === undefined) throw new Error(`Expected exactly one direct mainWindow.webContents.${method} registration, found ${calls.length}`)
  return functionHandler(calls[0], method)
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrapParentheses(node.expression) : node
}

/**
 * Whether the statement can hand control out of the handler body on any path:
 * a return, a throw, or a break or continue, wherever it sits inside the
 * statement. Bodies of nested functions are skipped, because a return in there
 * leaves that function, not this handler.
 *
 * This is the conservative half of a choice. Deciding that `if (x) return` only
 * leaves on one path, and that the statements after it still run on the other,
 * needs a real control-flow walk where the denial has to dominate every exit.
 * The shipped handlers in src/main/index.ts do not need that: the only
 * statement any of them runs before its denial is the try/catch in the
 * window-open handler, which contains no return, throw, break or continue. So
 * anything that can leave early stops the scan, and a handler that grows a
 * genuine early exit has to reflow rather than argue with the pin.
 */
function canLeaveTheBody(statement: ts.Statement): boolean {
  let found = false

  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(statement)
  return found
}

/**
 * The direct statements of a handler body the runtime always reaches: the
 * statements of the block itself, stopping after the first one that can leave
 * it on any path. A statement nested in an if, a ternary, a try, a loop or
 * another function is not in this list, and neither is anything written after a
 * conditional return or throw. That is the whole point. findNodes walks the
 * entire subtree, so a defense pinned with it alone is satisfied by a call the
 * runtime can skip, which is what happened here: `if (false) callback(false)`
 * matched, and so did `if (x) return; callback(false)`.
 */
function reachableStatements(body: ts.ConciseBody): ts.Statement[] {
  if (!ts.isBlock(body)) return []
  const reachable: ts.Statement[] = []
  for (const statement of body.statements) {
    reachable.push(statement)
    if (canLeaveTheBody(statement)) break
  }
  return reachable
}

/**
 * An expression a handler evaluates directly, with the way it is written kept
 * alongside it: `x` in `() => x` and `return x` produce the handler's answer,
 * while `x;` on its own line evaluates and throws the value away. Telling those
 * apart is what stops a bare `false` expression statement from reading as a
 * denial.
 */
interface DirectExpression {
  expression: ts.Expression
  isAnswer: boolean
}

/**
 * The expressions a handler always evaluates: its expression body, or the
 * expressions of the reachable direct statements of its block body. Both shapes
 * matter because the real permission handlers are one-expression arrows.
 */
function directExpressions(body: ts.ConciseBody): DirectExpression[] {
  if (!ts.isBlock(body)) return [{ expression: unwrapParentheses(body), isAnswer: true }]
  const expressions: DirectExpression[] = []
  for (const statement of reachableStatements(body)) {
    if (ts.isExpressionStatement(statement)) expressions.push({ expression: unwrapParentheses(statement.expression), isAnswer: false })
    else if (ts.isReturnStatement(statement) && statement.expression !== undefined) expressions.push({ expression: unwrapParentheses(statement.expression), isAnswer: true })
  }
  return expressions
}

function isCallToPreventDefault(node: ts.Statement, parameter: string): boolean {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
  const call = node.expression
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "preventDefault" &&
    call.arguments.length === 0 &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === parameter
  )
}

function onlyStatement(consequent: ts.Statement): ts.Statement | undefined {
  if (ts.isBlock(consequent)) return consequent.statements.length === 1 ? consequent.statements[0] : undefined
  return consequent
}

function isRejectedUrlCondition(condition: ts.Expression, urlArgument: string): boolean {
  const expression = unwrapParentheses(condition)
  if (!ts.isPrefixUnaryExpression(expression) || expression.operator !== ts.SyntaxKind.ExclamationToken) return false
  const call = unwrapParentheses(expression.operand)
  return (
    ts.isCallExpression(call) && call.arguments.length === 1 && ts.isIdentifier(call.expression) && call.expression.text === "isAllowedMainFrameUrl" && call.arguments[0]?.getText() === urlArgument
  )
}

function assertNavigationHandler(source: string, eventName: string): void {
  const ast = sourceAst(source, `fixture-${eventName}.ts`)
  const createWindow = findNodes(ast, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow")[0]
  if (createWindow?.body === undefined) throw new Error("Expected a createWindow fixture")

  const registrations = directCallStatements(createWindow.body).filter((call) => {
    if (!isMainWindowWebContentsCall(call, "on")) return false
    return call.arguments[0]?.getText(ast) === JSON.stringify(eventName)
  })
  if (registrations.length !== 1 || registrations[0] === undefined) throw new Error(`Expected one direct ${eventName} registration`)

  const handler = registrations[0].arguments[1]
  if (handler === undefined || !ts.isArrowFunction(handler) || !ts.isBlock(handler.body)) throw new Error(`${eventName} must use a block-bodied arrow-function handler`)

  const guard = reachableStatements(handler.body).filter(ts.isIfStatement)
  if (guard.length !== 1 || guard[0] === undefined || guard[0].elseStatement !== undefined) throw new Error(`${eventName} must have exactly one direct guard without an alternate branch`)
  const ifStatement = guard[0]
  const consequent = onlyStatement(ifStatement.thenStatement)
  if (consequent === undefined) throw new Error(`${eventName} guard must have exactly one executable statement`)

  if (eventName === "will-frame-navigate") {
    const detailsParameter = handler.parameters[0]?.name
    if (detailsParameter === undefined || !ts.isIdentifier(detailsParameter)) throw new Error(`${eventName} must expose navigation details`)
    const details = detailsParameter.text
    const condition = unwrapParentheses(ifStatement.expression)
    if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) throw new Error(`${eventName} must check the main frame before the URL`)
    const left = unwrapParentheses(condition.left)
    const right = unwrapParentheses(condition.right)
    if (
      !ts.isPropertyAccessExpression(left) ||
      left.name.text !== "isMainFrame" ||
      !ts.isIdentifier(left.expression) ||
      left.expression.text !== details ||
      !isRejectedUrlCondition(right, `${details}.url`)
    )
      throw new Error(`${eventName} must reject unsafe main-frame URLs`)
    if (!isCallToPreventDefault(consequent, details)) throw new Error(`${eventName} must prevent the rejected navigation`)
    return
  }

  const eventParameter = handler.parameters[0]?.name
  const urlParameter = handler.parameters[1]?.name
  if (eventParameter === undefined || !ts.isIdentifier(eventParameter) || urlParameter === undefined || !ts.isIdentifier(urlParameter))
    throw new Error(`${eventName} must expose event and URL parameters`)
  if (!isRejectedUrlCondition(ifStatement.expression, urlParameter.text) || !isCallToPreventDefault(consequent, eventParameter.text)) throw new Error(`${eventName} must prevent a rejected URL`)
}

/**
 * Reads the boolean webPreferences the main window is built with as values
 * rather than as text. A substring pin on "sandbox: true" would also be
 * satisfied by a comment mentioning it, and it says nothing when the flag flips;
 * this fails with the flag that changed and its new value. Comment lines and
 * non-boolean options (preload, icon) do not match, so they are simply skipped.
 */
function mainWindowFlags(): Map<string, boolean> {
  const createWindow = findCreateWindow()
  if (createWindow.body === undefined) throw new Error("Expected createWindow to have a body")
  const windows = findNodes(createWindow.body, (node): node is ts.NewExpression => ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BrowserWindow")
  if (windows.length !== 1 || windows[0] === undefined) throw new Error(`Expected exactly one BrowserWindow construction, found ${windows.length}`)

  const window = windows[0]
  const options = window.arguments?.[0]
  if (options === undefined || !ts.isObjectLiteralExpression(options)) throw new Error("BrowserWindow must receive an options object")
  const preferences = uniqueProperty(options, "webPreferences").initializer
  if (!ts.isObjectLiteralExpression(preferences)) throw new Error("BrowserWindow webPreferences must be an object")

  const flags = new Map<string, boolean>()
  for (const name of ["sandbox", "nodeIntegration", "contextIsolation"]) {
    const value = uniqueProperty(preferences, name).initializer
    if (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword) throw new Error(`${name} must be a boolean literal`)
    flags.set(name, value.kind === ts.SyntaxKind.TrueKeyword)
  }
  return flags
}

function sessionHandler(ast: ts.SourceFile, method: string): ts.ArrowFunction {
  const calls = findNodes(ast, (node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== method) return false
    const session = node.expression.expression
    return ts.isPropertyAccessExpression(session) && session.name.text === "defaultSession" && ts.isIdentifier(session.expression) && session.expression.text === "session"
  })
  if (calls.length !== 1 || calls[0] === undefined) throw new Error(`Expected exactly one session.defaultSession.${method} call, found ${calls.length}`)
  return functionHandler(calls[0], method)
}

function assertPermissionRequestHandlerDenies(source: string): void {
  const ast = sourceAst(source, "permission-request-fixture.ts")
  const handler = sessionHandler(ast, "setPermissionRequestHandler")
  const callbackParameter = handler.parameters[2]?.name
  if (callbackParameter === undefined || !ts.isIdentifier(callbackParameter)) throw new Error("The permission request callback must be the third handler parameter")

  const name = callbackParameter.text
  const isDenial = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === name &&
    expression.arguments.length === 1 &&
    expression.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword

  const callbackCalls = findNodes(handler.body, (node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== name) return false
    return true
  })
  if (callbackCalls.length === 0) throw new Error(`setPermissionRequestHandler: permission request callback ${name} is not called`)
  for (const callbackCall of callbackCalls) {
    if (!isDenial(callbackCall)) throw new Error(`setPermissionRequestHandler: permission request callback ${name} must be called with false`)
  }
  // The denial here is the call itself, so only a call expression counts: a
  // bare `false`, or a mention of the callback that never calls it, answers
  // nothing.
  if (!directExpressions(handler.body).some((direct) => isDenial(direct.expression)))
    throw new Error(
      `setPermissionRequestHandler: permission request callback ${name} must be called with false as a reachable direct statement of the handler body, not from a branch, a ternary, a try, a loop, a nested function or after an earlier exit`
    )
}

function assertPermissionCheckHandlerDenies(source: string): void {
  const ast = sourceAst(source, "permission-check-fixture.ts")
  const handler = sessionHandler(ast, "setPermissionCheckHandler")
  const returns = findNodes(handler.body, ts.isReturnStatement)
  if (returns.length > 1) throw new Error(`setPermissionCheckHandler: permission check handler must return false and nothing else, found ${returns.length} return statements`)
  // Electron reads the value this handler produces, so only the expression body
  // of `() => false` or a reachable `return false` denies. `{ false }` returns
  // undefined and `{ false; return true }` grants, and both used to pass.
  if (!directExpressions(handler.body).some((direct) => direct.isAnswer && direct.expression.kind === ts.SyntaxKind.FalseKeyword))
    throw new Error(
      "setPermissionCheckHandler: permission check handler must return false, as the expression body of the handler or as a reachable direct statement of the handler body, not from a branch, a ternary, a try, a loop, a nested function, an expression statement that discards it or after an earlier exit"
    )
}

function assertWindowOpenHandlerDenies(source: string): void {
  const ast = sourceAst(source, "window-open-fixture.ts")
  const handler = webContentsHandler(ast, "setWindowOpenHandler")
  // One object return only, wherever it sits, so a second one cannot allow the
  // window before the denial the pin reads.
  const returns = findNodes(handler.body, ts.isReturnStatement)
  if (returns.length > 1) throw new Error(`setWindowOpenHandler: window open handler must have exactly one object return, found ${returns.length} return statements`)

  // The denial is the value the handler answers with, so a bare
  // `({ action: "deny" })` expression statement is not one.
  const directDenial = directExpressions(handler.body).find((direct) => direct.isAnswer && ts.isObjectLiteralExpression(direct.expression))
  const nestedReturn = returns[0]?.expression
  const object = directDenial?.expression ?? (nestedReturn !== undefined && ts.isObjectLiteralExpression(nestedReturn) ? nestedReturn : undefined)
  if (object === undefined || !ts.isObjectLiteralExpression(object)) throw new Error("setWindowOpenHandler: window open handler must have exactly one object return")

  const action = uniqueProperty(object, "action").initializer
  if (!ts.isStringLiteral(action) || action.text !== "deny") throw new Error("setWindowOpenHandler: window open handler must return action deny")
  if (directDenial === undefined)
    throw new Error(
      "setWindowOpenHandler: window open handler must return action deny, as the expression body of the handler or as a reachable direct statement of the handler body, not from a branch, a ternary, a try, a loop, a nested function or after an earlier exit"
    )
}

/**
 * The renderer defenses the main process holds on its own side of the bridge.
 * None of them can be exercised for real here: index.ts bootstraps Electron on
 * import, and the only harness that drives a rendered window is the packaged CDP
 * run under tests/e2e, which is started by hand from a workflow rather than by
 * vitest. The assertions therefore parse the TypeScript structure without
 * importing the Electron bootstrap. This ignores comments and dead text while
 * requiring the security calls to appear in the executable handler bodies.
 */
describe("main process renderer defenses", () => {
  it("builds the main window with the renderer locked out of node", () => {
    const flags = mainWindowFlags()

    assert.equal(flags.get("sandbox"), true, `the main window webPreferences set sandbox: ${flags.get("sandbox")}, which drops the renderer out of the OS sandbox`)
    assert.equal(flags.get("nodeIntegration"), false, `the main window webPreferences set nodeIntegration: ${flags.get("nodeIntegration")}, which hands the renderer require()`)
    assert.equal(flags.get("contextIsolation"), true, `the main window webPreferences set contextIsolation: ${flags.get("contextIsolation")}, which puts the preload bridge in the page's own world`)
  })

  it("blocks any main-frame navigation the renderer policy rejects", () => {
    // will-navigate alone is not the boundary: a redirect and a frame
    // navigation reach the same window through their own events, so all three
    // guards are pinned together.
    for (const event of ["will-navigate", "will-redirect"]) {
      assert.doesNotThrow(() => assertNavigationHandler(MAIN_SOURCE, event), `the ${event} guard no longer prevents a URL the renderer policy rejects`)
    }
  })

  it("requires will-frame-navigate to block an unsafe main-frame URL", () => {
    assert.doesNotThrow(() => assertNavigationHandler(MAIN_SOURCE, "will-frame-navigate"), "the will-frame-navigate guard no longer blocks unsafe main-frame URLs")
  })

  it("rejects navigation guards hidden in comments, dead branches, or weakened conditions", () => {
    const commentOnly = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { /* if (!isAllowedMainFrameUrl(url)) event.preventDefault() */ }) }`
    const deadBranch = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { if (false) { if (!isAllowedMainFrameUrl(url)) event.preventDefault() } }) }`
    const weakenedCondition = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { if (!isAllowedMainFrameUrl(url) && false) event.preventDefault() }) }`
    const frameWithoutMainFrameCheck = `function createWindow() { mainWindow.webContents.on("will-frame-navigate", (details) => { if (!isAllowedMainFrameUrl(details.url)) details.preventDefault() }) }`
    // The guard sits at the top level of the body, so a dead branch around it is
    // caught, but an early return in front of it left it unreachable and green.
    const unreachableGuard = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { return; if (!isAllowedMainFrameUrl(url)) event.preventDefault() }) }`
    const guardInsideTry = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { try { if (!isAllowedMainFrameUrl(url)) event.preventDefault() } catch {} }) }`

    assert.throws(() => assertNavigationHandler(commentOnly, "will-navigate"))
    assert.throws(() => assertNavigationHandler(deadBranch, "will-navigate"))
    assert.throws(() => assertNavigationHandler(weakenedCondition, "will-navigate"))
    assert.throws(() => assertNavigationHandler(frameWithoutMainFrameCheck, "will-frame-navigate"))
    assert.throws(() => assertNavigationHandler(unreachableGuard, "will-navigate"), /exactly one direct guard/)
    assert.throws(() => assertNavigationHandler(guardInsideTry, "will-navigate"), /exactly one direct guard/)
  })

  it("denies every window the renderer asks Electron to open", () => {
    assert.doesNotThrow(() => assertWindowOpenHandlerDenies(MAIN_SOURCE), "the window open handler stopped denying renderer-created windows")
  })

  it("rejects an early allow before the final window-open denial", () => {
    const weakenedSource = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { if (details.url) return { action: "allow" }; return { action: "deny" } }) }`

    assert.throws(() => assertWindowOpenHandlerDenies(weakenedSource), /exactly one object return/)
  })

  it("refuses every renderer permission request", () => {
    assertPermissionRequestHandlerDenies(MAIN_SOURCE)
    assertPermissionCheckHandlerDenies(MAIN_SOURCE)
  })

  it("binds permission denial to the third callback parameter", () => {
    const fourParameterHandler = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback, extra) => callback(false))"
    assert.doesNotThrow(() => assertPermissionRequestHandlerDenies(fourParameterHandler))
  })

  it("rejects permission callbacks hidden by comments, dead branches, or another false call", () => {
    const commentOnly = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { /* callback(false) */ })"
    const deadBranch = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { if (false) callback(true) })"
    const anotherFalseCall = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { log(false); callback(true) })"
    const weakCheck = "session.defaultSession.setPermissionCheckHandler(() => true)"

    assert.throws(() => assertPermissionRequestHandlerDenies(commentOnly), /is not called/)
    assert.throws(() => assertPermissionRequestHandlerDenies(deadBranch), /must be called with false/)
    assert.throws(() => assertPermissionRequestHandlerDenies(anotherFalseCall), /must be called with false/)
    assert.throws(() => assertPermissionCheckHandlerDenies(weakCheck), /must return false/)
  })

  // A denial the runtime can step over is not a denial. Everything below calls
  // the callback with false, or returns false, somewhere in the handler, and
  // every one of them leaves a permission request unanswered or answered later
  // by something else.
  it("rejects a permission request denial the handler can skip", () => {
    const deadBranch = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { if (false) callback(false) })"
    const insideTry = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { try { callback(false) } catch {} })"
    const ternaryWithAllow = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { granted ? callback(false) : callback(true) })"
    const ternaryDenial = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { granted ? callback(false) : callback(false) })"
    const nestedFunction = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { const deny = () => callback(false) })"
    const emptyBody = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {})"

    assert.throws(() => assertPermissionRequestHandlerDenies(deadBranch), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(insideTry), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(ternaryWithAllow), /must be called with false/)
    assert.throws(() => assertPermissionRequestHandlerDenies(ternaryDenial), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(nestedFunction), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(emptyBody), /is not called/)
  })

  it("rejects a permission check or window-open denial the handler can skip", () => {
    const checkInBranch = "session.defaultSession.setPermissionCheckHandler(() => { if (false) return false })"
    const checkInTry = "session.defaultSession.setPermissionCheckHandler(() => { try { return false } catch {} })"
    const checkTernary = "session.defaultSession.setPermissionCheckHandler(() => (granted ? false : false))"
    const checkNestedFunction = "session.defaultSession.setPermissionCheckHandler(() => { const deny = () => false })"
    const checkAfterAllow = "session.defaultSession.setPermissionCheckHandler(() => { if (granted) return true; return false })"
    const checkEmptyBody = "session.defaultSession.setPermissionCheckHandler(() => {})"
    const openInBranch = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { if (details.url) { return { action: "deny" } } }) }`
    const openInTry = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { try { return { action: "deny" } } catch {} }) }`
    const openUnreachable = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { throw new Error("unreachable"); return { action: "deny" } }) }`
    const openEmptyBody = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => {}) }`

    assert.throws(() => assertPermissionCheckHandlerDenies(checkInBranch), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkInTry), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkTernary), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkNestedFunction), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkAfterAllow), /found 2 return statements/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkEmptyBody), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openInBranch), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openInTry), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openUnreachable), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openEmptyBody), /exactly one object return/)
  })

  // Evaluating a value and throwing it away is not answering with it. Both of
  // these used to satisfy the contract: the first hands Electron undefined, the
  // second hands it true, and Electron reads what the handler returns.
  it("rejects a denial written as an expression statement that discards it", () => {
    const checkDiscarded = "session.defaultSession.setPermissionCheckHandler(() => { false })"
    const checkDiscardedThenAllow = "session.defaultSession.setPermissionCheckHandler(() => { false; return true })"
    const requestBareFalse = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { false })"
    const requestCallbackUnused = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback })"
    const openDiscarded = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { ({ action: "deny" }) }) }`

    assert.throws(() => assertPermissionCheckHandlerDenies(checkDiscarded), /must return false/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkDiscardedThenAllow), /must return false/)
    assert.throws(() => assertPermissionRequestHandlerDenies(requestBareFalse), /is not called/)
    assert.throws(() => assertPermissionRequestHandlerDenies(requestCallbackUnused), /is not called/)
    assert.throws(() => assertWindowOpenHandlerDenies(openDiscarded), /exactly one object return/)
  })

  // A denial written after something that can leave the handler runs on some
  // paths and not others. reachableStatements used to stop only at an exit
  // written directly in the block, so every shape below reached its denial in
  // the pin and skipped it at runtime.
  it("rejects a denial reached only when an earlier statement does not leave the handler", () => {
    const requestAfterConditionalReturn = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { if (granted) return; callback(false) })"
    const requestAfterConditionalThrow = 'session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { if (granted) throw new Error("no"); callback(false) })'
    const requestAfterTryExit = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { try { return } catch {} callback(false) })"
    const requestAfterLoopExit = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { for (const p of pending) { return } callback(false) })"

    const checkAfterConditionalThrow = 'session.defaultSession.setPermissionCheckHandler(() => { if (granted) throw new Error("no"); return false })'
    const checkAfterTryExit = 'session.defaultSession.setPermissionCheckHandler(() => { try { throw new Error("no") } catch {} return false })'
    const checkAfterLoopExit = "session.defaultSession.setPermissionCheckHandler(() => { for (const p of pending) { return true } return false })"

    const navAfterConditionalReturn = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { if (trusted) return; if (!isAllowedMainFrameUrl(url)) event.preventDefault() }) }`
    const navAfterConditionalThrow = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { if (trusted) throw new Error("no"); if (!isAllowedMainFrameUrl(url)) event.preventDefault() }) }`
    const navAfterTryExit = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { try { return } catch {} if (!isAllowedMainFrameUrl(url)) event.preventDefault() }) }`
    const navAfterLoopExit = `function createWindow() { mainWindow.webContents.on("will-navigate", (event, url) => { for (const frame of frames) { return } if (!isAllowedMainFrameUrl(url)) event.preventDefault() }) }`

    const openAfterConditionalThrow = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { if (details.url) throw new Error("no"); return { action: "deny" } }) }`
    const openAfterTryExit = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { try { throw new Error("no") } catch {} return { action: "deny" } }) }`
    const openAfterLoopExit = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { for (const feature of details.features) { throw new Error("no") } return { action: "deny" } }) }`
    // A conditional return before the denial puts a second return in the
    // handler, which the one-object-return rule rejects first.
    const openAfterConditionalReturn = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => { if (details.url) return; return { action: "deny" } }) }`

    assert.throws(() => assertPermissionRequestHandlerDenies(requestAfterConditionalReturn), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(requestAfterConditionalThrow), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(requestAfterTryExit), /direct statement of the handler body/)
    assert.throws(() => assertPermissionRequestHandlerDenies(requestAfterLoopExit), /direct statement of the handler body/)

    assert.throws(() => assertPermissionCheckHandlerDenies(checkAfterConditionalThrow), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkAfterTryExit), /direct statement of the handler body/)
    assert.throws(() => assertPermissionCheckHandlerDenies(checkAfterLoopExit), /found 2 return statements/)

    assert.throws(() => assertNavigationHandler(navAfterConditionalReturn, "will-navigate"), /must prevent a rejected URL/)
    assert.throws(() => assertNavigationHandler(navAfterConditionalThrow, "will-navigate"), /must prevent a rejected URL/)
    assert.throws(() => assertNavigationHandler(navAfterTryExit, "will-navigate"), /exactly one direct guard/)
    assert.throws(() => assertNavigationHandler(navAfterLoopExit, "will-navigate"), /exactly one direct guard/)

    assert.throws(() => assertWindowOpenHandlerDenies(openAfterConditionalThrow), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openAfterTryExit), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openAfterLoopExit), /direct statement of the handler body/)
    assert.throws(() => assertWindowOpenHandlerDenies(openAfterConditionalReturn), /exactly one object return/)
  })

  // The rule is about where the denial sits, not about how it is spelled, so a
  // rename and a reflow of the real shapes stay accepted.
  it("accepts the shipped denials after a rename and a reformat", () => {
    const renamedRequest = `session.defaultSession.setPermissionRequestHandler((contents, requested, respond) => {
      respond(false)
    })`
    const renamedCheck = `session.defaultSession.setPermissionCheckHandler(() => {
      return false
    })`
    const renamedOpen = `function createWindow() {
      mainWindow.webContents.setWindowOpenHandler((request) => {
        try {
          const safeUrl = assertAllowedBrowserUrl(request.url)
          void shell.openExternal(safeUrl.toString())
        } catch {
          logMessage("warn", "Blocked an unsafe external window URL.")
        }
        return { action: "deny" }
      })
    }`

    assert.doesNotThrow(() => assertPermissionRequestHandlerDenies(renamedRequest))
    assert.doesNotThrow(() => assertPermissionCheckHandlerDenies(renamedCheck))
    assert.doesNotThrow(() => assertWindowOpenHandlerDenies(renamedOpen))
  })

  // An expression body answers with its value, so it is the same denial written
  // shorter, and the check handler already ships that way.
  it("accepts an expression-bodied denial in each handler", () => {
    const expressionRequest = "session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))"
    const expressionCheck = "session.defaultSession.setPermissionCheckHandler(() => false)"
    const expressionOpen = `function createWindow() { mainWindow.webContents.setWindowOpenHandler((details) => ({ action: "deny" })) }`

    assert.doesNotThrow(() => assertPermissionRequestHandlerDenies(expressionRequest))
    assert.doesNotThrow(() => assertPermissionCheckHandlerDenies(expressionCheck))
    assert.doesNotThrow(() => assertWindowOpenHandlerDenies(expressionOpen))
  })
})

describe("main process protocol boundary wiring", () => {
  // index.ts bootstraps Electron on import, so keep this contract scoped to each inline handler.
  it("routes app and custom icon requests through containment before file checks", () => {
    const appSource = mainHandlerSource('protocol.handle("app", async (request) => {', "\n  // Handler for mod icons")
    const iconsSource = mainHandlerSource('protocol.handle("icons", async (req) => {', "\n  await ensureConfig()")
    const handlers: ReadonlyArray<readonly [string, string]> = [
      ["app", appSource],
      ["icons", iconsSource]
    ]

    for (const [name, source] of handlers) {
      const containmentCall = source.indexOf("const filePath = resolveContainedPath")
      assert.notEqual(containmentCall, -1, `${name}: handler stopped resolving a contained path`)

      const containmentReturn = source.indexOf("if (!filePath) return new Response(null, { status: 404 })", containmentCall)
      assert.notEqual(containmentReturn, -1, `${name}: handler stopped rejecting paths outside its root explicitly`)
      assert.equal(source.includes("if (!filePath ||"), false, `${name}: containment was folded into another gate`)

      const filesystemCheck = source.indexOf("if (!(await isSafeProtocolFile(filePath)))", containmentReturn)
      assert.notEqual(filesystemCheck, -1, `${name}: handler stopped checking the resolved filesystem object`)
      assert.ok(containmentReturn < filesystemCheck, `${name}: filesystem safety ran before containment`)
    }

    const containmentReturn = iconsSource.indexOf("if (!filePath) return new Response(null, { status: 404 })")
    const extensionCheck = iconsSource.indexOf('if (!filePath.toLowerCase().endsWith(".png"))', containmentReturn)
    const filesystemCheck = iconsSource.indexOf("if (!(await isSafeProtocolFile(filePath)))", extensionCheck)
    assert.ok(containmentReturn < extensionCheck, "icons: extension checking ran before containment")
    assert.ok(extensionCheck < filesystemCheck, "icons: filesystem safety ran before the extension check")
  })
})

function mainHandlerSource(startMarker: string, endMarker: string): string {
  const start = MAIN_SOURCE.indexOf(startMarker)
  if (start === -1) throw new Error(`Could not find main-process handler: ${startMarker}`)

  const end = MAIN_SOURCE.indexOf(endMarker, start + startMarker.length)
  if (end === -1) throw new Error(`Could not find end of main-process handler: ${startMarker}`)

  return MAIN_SOURCE.slice(start, end)
}

/**
 * Two renderer trees are held off the preload bridge. Shared components reach the host only
 * through a feature they were handed, and the mods feature keeps its bridge calls in
 * features/moddb/adapters, which is what the comment at the top of moddb.ts describes. Both rules
 * lived in comments alone, so anything could quietly walk back into either tree. Reading the
 * sources is the same approach the main-process assertions above take.
 */
function filesReachingTheBridge(tree: string): string[] {
  const root = resolve(__dirname, "..", tree)
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .filter((entry) => readFileSync(resolve(root, entry), "utf8").includes("window.api"))
}

describe("renderer preload bridge boundaries", () => {
  it("keeps the mods feature behind its adapters", () => {
    assert.deepEqual(filesReachingTheBridge("src/renderer/src/features/mods"), [], "a file under src/renderer/src/features/mods calls window.api instead of going through an adapter")
  })

  it("keeps the shared components behind the features they are handed", () => {
    assert.deepEqual(filesReachingTheBridge("src/renderer/src/components"), [], "a file under src/renderer/src/components calls window.api instead of going through a feature")
  })
})
