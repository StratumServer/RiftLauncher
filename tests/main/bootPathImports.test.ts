import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { describe, it } from "vitest"
import * as ts from "typescript"

/**
 * The boot path is a graph, not a file: the entry pulls in `@src/ipc`, which pulls in the handlers,
 * which pull in everything those handlers import at module scope. A chunk moved behind `await
 * import(...)` leaves that graph, and nothing in a unit test notices when it comes back, because
 * the handler still works when its chunk is loaded eagerly.
 *
 * So this walks the static imports from `src/main/index.ts` and fails if a module that is supposed
 * to load on demand is reachable again. Type-only imports are not edges (they erase at build time),
 * a bundler query suffix is not followed, and a bare `import()` is the deferral itself rather than
 * an edge, so it is skipped by construction: only `ImportDeclaration` and `ExportDeclaration` nodes
 * with a module specifier are followed.
 *
 * The four below are the chunks this branch deferred. `tar` rides along with `compression.ts` and
 * `extraction.ts`, the two worker runtimes with their own files, and `yauzl` with
 * `archiveValidation.ts`.
 */
const MUST_STAY_OFF_THE_BOOT_PATH = ["src/ipc/workers/compression.ts", "src/ipc/workers/extraction.ts", "src/ipc/workers/download.ts", "src/ipc/archiveValidation.ts"]

/** Modules that are on the boot path today, so a walk that silently resolves nothing fails loudly. */
const MUST_BE_ON_THE_BOOT_PATH = ["src/main/index.ts", "src/ipc/validation.ts", "src/config/configManager.ts", "src/ipc/optimumInstall.ts"]

const PROJECT_ROOT = resolve(__dirname, "../..")
const ENTRY = resolve(PROJECT_ROOT, "src/main/index.ts")
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx", ".json", ".css"]

interface Edge {
  specifier: string
  line: number
}

/** The static edges out of one file. Type-only declarations and dynamic imports are not edges. */
function staticEdges(file: string): Edge[] {
  const source = readFileSync(file, "utf8")
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edges: Edge[] = []
  const record = (specifier: ts.Expression | undefined, node: ts.Node): void => {
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return
    edges.push({ specifier: specifier.text, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
  }
  const visit = (node: ts.Node): void => {
    // `import "x"` has no import clause, `import type x from "y"` is type-only, and a mixed
    // `import { type A, b } from "y"` is a value import because it has one.
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) record(node.moduleSpecifier, node)
    else if (ts.isExportDeclaration(node) && node.isTypeOnly !== true) record(node.moduleSpecifier, node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return edges
}

/**
 * Where a specifier lands, as a path relative to the repository root, or null for anything that is
 * not this repository's source (a node builtin, a package, or a bundler query).
 *
 * A `?modulePath` import is the worker-entry convention: it hands Vite a path to a file it builds as
 * its own bundle, so the importer never loads that file's graph and neither does this walk. A
 * `?asset` import is the same idea for a binary.
 *
 * A specifier this repository owns but that resolves to no file throws rather than returning null:
 * a new alias would otherwise look external and quietly hide a module from the walk.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.includes("?")) return null
  let base: string
  if (specifier.startsWith("@src/")) base = resolve(PROJECT_ROOT, "src", specifier.slice("@src/".length))
  else if (specifier.startsWith("@domain/")) base = resolve(PROJECT_ROOT, "src/domain", specifier.slice("@domain/".length))
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier)
  else return null
  // Extensions first so a directory specifier lands on its index, then the bare path, which is how
  // an extensionless asset would be written.
  const candidates = [...EXTENSIONS.map((extension) => `${base}${extension}`), base]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(PROJECT_ROOT, candidate)
  }
  throw new Error(`${relative(PROJECT_ROOT, fromFile)} imports "${specifier}", which resolves to no file. Teach this walk the new alias or extension.`)
}

/** Every module the boot path reaches, each mapped to the import chain that reached it. */
function bootPath(): Map<string, string[]> {
  const entry = relative(PROJECT_ROOT, ENTRY)
  const chains = new Map<string, string[]>([[entry, []]])
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [] }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (!current.file.endsWith(".ts") && !current.file.endsWith(".tsx")) continue
    const absolute = resolve(PROJECT_ROOT, current.file)
    for (const edge of staticEdges(absolute)) {
      const target = resolveSpecifier(absolute, edge.specifier)
      if (target === null) continue
      // First discovery wins, which both keeps the shortest chain and cuts import cycles.
      if (chains.has(target)) continue
      const chain = [...current.chain, `${target}:${edge.line}`]
      chains.set(target, chain)
      queue.push({ file: target, chain })
    }
  }
  return chains
}

const BOOT_PATH = bootPath()

describe("boot path static imports", () => {
  it("reaches the modules that are on the boot path today", () => {
    // Without this the four assertions below pass on an empty graph, which is how a walk like this
    // rots: a rename in the entry and it resolves nothing while staying green.
    for (const module of MUST_BE_ON_THE_BOOT_PATH) {
      assert.notEqual(BOOT_PATH.get(module), undefined, `${module} is no longer reachable from src/main/index.ts`)
    }
    assert.ok(BOOT_PATH.size > 50, `Expected the boot path to reach more than 50 modules, reached ${BOOT_PATH.size}`)
  })

  for (const module of MUST_STAY_OFF_THE_BOOT_PATH) {
    it(`leaves ${module} to the call site that needs it`, () => {
      const chain = BOOT_PATH.get(module)
      assert.equal(chain, undefined, chain === undefined ? "" : `${module} is required at startup again, reached through ${["src/main/index.ts", ...chain].join(" -> ")}`)
    })
  }
})
