import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "vitest"
import * as ts from "typescript"

const ENTRY = resolve(__dirname, "../../src/main/index.ts")

function isBootFailureGuard(node: ts.Node): boolean {
  if (!ts.isIfStatement(node) || !ts.isReturnStatement(node.thenStatement)) return false

  let checksBootFailure = false
  const visit = (condition: ts.Node): void => {
    if (ts.isCallExpression(condition) && ts.isIdentifier(condition.expression) && condition.expression.text === "reportBootFailure") {
      checksBootFailure = condition.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "bootFailure")
    }
    ts.forEachChild(condition, visit)
  }
  visit(node.expression)
  return checksBootFailure
}

describe("the main entry boot-failure guard", () => {
  it("reports the failure and returns before normal startup continues", () => {
    const ast = ts.createSourceFile(ENTRY, readFileSync(ENTRY, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let foundGuard = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then" &&
        ts.isCallExpression(node.expression.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression.expression) &&
        node.expression.expression.expression.name.text === "whenReady"
      ) {
        const callback = node.arguments[0]
        if (callback !== undefined) {
          const findGuard = (candidate: ts.Node): void => {
            if (isBootFailureGuard(candidate)) foundGuard = true
            ts.forEachChild(candidate, findGuard)
          }
          findGuard(callback)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)

    assert.equal(foundGuard, true, "src/main/index.ts must stop its whenReady callback after reporting bootFailure")
  })
})
