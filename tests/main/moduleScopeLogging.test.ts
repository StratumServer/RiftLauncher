import { readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * No main-process module may log at module scope.
 *
 * Imports are evaluated before the body of src/main/index.ts, and that body is where the user data
 * folder is chosen. A line logged while a module loads is therefore written under Electron's default
 * folder, `<appData>/riftlauncher`. On Windows that is the same folder as `<appData>/RiftLauncher`,
 * so it already exists when the launcher asks whether a RiftLauncher profile is there. The answer is
 * then always yes, and a first-time player's VS Launcher data is never carried over.
 *
 * "As a module loads" is wider than its top-level statements. A log behind an `if`, in an
 * initialiser (`const x = logMessage(...)`), in a block, a `try`, a loop, a class static block or a
 * function invoked on the spot runs just as early, so the walk goes into all of those. It stops at a
 * function body, which waits for a call, and at an instance field, which waits for the constructor.
 *
 * Folder by folder, everything under src/ is scanned except the two that run in the renderer's process:
 * - config, ipc, main, utils: imported by the entry.
 * - domain: imported by the entry as well. Its lint guard bans `electron` but not `electron-log`,
 *   so nothing else stops a domain module from logging as it loads.
 * - preload, renderer: another process, they never load in the main one.
 * A folder added later is scanned until it is named here as belonging to the renderer's process.
 *
 * The entry itself is left out: its body runs after the folder is chosen, and logging what was
 * chosen is its job.
 */
const ROOT = join(__dirname, "../..")
const ENTRY = "src/main/index.ts"
const RENDERER_PROCESS_FOLDERS = ["src/preload/", "src/renderer/"]

/** The sources to scan, as paths from the repository root with forward slashes: one listing, no file opened. */
function mainProcessSources(): string[] {
  return (
    readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
      .map((entry) => `src/${entry.split(sep).join("/")}`)
      .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts") && path !== ENTRY)
      .filter((path) => !RENDERER_PROCESS_FOLDERS.some((folder) => path.startsWith(folder)))
      // tests/config/lint-guards.test.ts keeps a seeded fixture in src/domain for the length of one
      // test, and a scan that lists it just before it is removed would fail on opening it.
      .filter((path) => !path.includes("__lint-guard-fixture"))
  )
}

/** `logMessage(...)`, or a call on the electron-log default export (`Logger.info(...)`, `log.warn(...)`). */
function isLogCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === "logMessage"
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ["Logger", "log"].includes(callee.expression.text)
}

/** Code that waits for a call: a function body (declaration, expression, arrow, method, accessor, constructor) or an instance field. */
function runsLater(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return true
  return ts.isPropertyDeclaration(node) && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
}

/**
 * The line of every log call a module makes as it loads, in one walk of one parse.
 *
 * ponytail: calls are not followed, so a helper that logs and is invoked at module scope (`init()`, or
 * a callback handed to `forEach`) is not seen, only a log written on the load path itself. Resolving a
 * call to the declaration it names would close that.
 */
function moduleScopeLogLines(fileName: string, source: string): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (isLogCall(node)) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression
      // `(() => { ... })()` runs where it stands, so its body is as early as the statement around it.
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
        ts.forEachChild(callee, visit)
        node.arguments.forEach(visit)
        return
      }
    }
    if (!runsLater(node)) ts.forEachChild(node, visit)
  }
  file.statements.forEach(visit)
  return lines
}

describe("module-scope logging in the main process", () => {
  it("scans every main-process folder, the domain included", () => {
    const folders = new Set(mainProcessSources().map((path) => path.split("/")[1]))
    expect([...folders]).toEqual(expect.arrayContaining(["config", "domain", "ipc", "main", "utils"]))
  })

  // The lines a module logs on as it loads. A row with none is code that waits for a call.
  it.each([
    ["a statement", [1], 'logMessage("debug", "x")'],
    ["a branch", [1], 'if (flag) logMessage("debug", "x")'],
    ["an initialiser", [1], 'const probed = logMessage("debug", "x")'],
    ["a block", [2], '{\n  Logger.info("x")\n}'],
    ["a try, a catch and a loop", [2, 4], 'try {\n  log.warn("x")\n} catch {\n  while (again) logMessage("info", "y")\n}'],
    ["a class static block", [3], 'class A {\n  static {\n    logMessage("debug", "x")\n  }\n}'],
    ["a static field", [2], 'class A {\n  static x = logMessage("debug", "x")\n}'],
    ["a function invoked on the spot", [2], '(() => {\n  logMessage("debug", "x")\n})()'],
    ["a function declaration", [], 'function later() {\n  logMessage("debug", "x")\n}'],
    ["an arrow in a const", [], 'const later = () => logMessage("debug", "x")'],
    ["a method", [], 'class A {\n  later() {\n    logMessage("debug", "x")\n  }\n}'],
    ["an instance field, a constructor and an accessor", [], 'class A {\n  x = log.info("x")\n  constructor() {\n    log.info("x")\n  }\n  get y() {\n    return log.info("x")\n  }\n}'],
    ["a statement after a function that logs", [4], 'function later() {\n  logMessage("debug", "x")\n}\nlogMessage("debug", "y")']
  ])("module scope of %s: lines %j", (_shape, lines, source) => {
    expect(moduleScopeLogLines("sample.ts", source)).toEqual(lines)
  })

  it("finds none outside the entry", () => {
    const found = mainProcessSources().flatMap((path) => moduleScopeLogLines(path, readFileSync(join(ROOT, path), "utf8")).map((line) => `${path}:${line}`))
    expect(found).toEqual([])
  })
})
