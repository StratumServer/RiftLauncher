import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
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
 * The entry itself is left out: its body runs after the folder is chosen, and logging what was
 * chosen is its job.
 */
const ROOT = join(__dirname, "../..")
const MAIN_PROCESS_FOLDERS = ["src/ipc", "src/main", "src/config", "src/utils"]
const ENTRY = "src/main/index.ts"

function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : []
  })
}

/** `logMessage(...)`, or a call on the electron-log default export (`Logger.info(...)`, `log.warn(...)`). */
function isLogCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false
  const callee = expression.expression
  if (ts.isIdentifier(callee)) return callee.text === "logMessage"
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ["Logger", "log"].includes(callee.expression.text)
}

/** Every log call a module makes as it loads: top-level statements only, function bodies left alone. */
function moduleScopeLogCalls(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  const display = relative(ROOT, path).split(sep).join("/")
  return file.statements
    .filter((statement) => ts.isExpressionStatement(statement) && isLogCall(statement.expression))
    .map((statement) => `${display}:${file.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`)
}

describe("module-scope logging in the main process", () => {
  const files = MAIN_PROCESS_FOLDERS.flatMap((folder) => sourceFiles(join(ROOT, folder)))

  it("scans the main process sources", () => {
    expect(files.length).toBeGreaterThan(40)
    expect(files.map((path) => relative(ROOT, path).split(sep).join("/"))).toContain("src/ipc/handlers/worldsHandlers.ts")
  })

  it("recognises a log call made while a module loads", () => {
    const sample = ts.createSourceFile("sample.ts", 'logMessage("debug", "x")\nLogger.info("y")\nfunction later() { logMessage("info", "z") }\n', ts.ScriptTarget.Latest, true)
    expect(sample.statements.filter((statement) => ts.isExpressionStatement(statement) && isLogCall(statement.expression))).toHaveLength(2)
  })

  it("finds none outside the entry", () => {
    const found = files.filter((path) => relative(ROOT, path).split(sep).join("/") !== ENTRY).flatMap(moduleScopeLogCalls)
    expect(found).toEqual([])
  })
})
