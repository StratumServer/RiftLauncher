import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import * as ts from "typescript"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import { describePortableDecision, isTrustedPortableMarker, portablePathsForCurrentInstall, selectUserDataFolder } from "@src/main/profileChoice"
import { PORTABLE_MARKER_FILE, PORTABLE_USER_DATA_FOLDER, RIFT_USER_DATA_FOLDER } from "@src/main/userDataMigration"

/**
 * Which profile folder the launcher opens, against a real folder layout in a temp directory.
 *
 * The functions here are the whole of the decision, and they are kept free of Electron so that the
 * question "which folder did this install choose, and why" can be answered without starting a
 * process. Nothing is mocked except the user id, which no fixture can own.
 */

let workDir = ""
let installPath = ""

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "riftlauncher-profile-choice-"))
  installPath = join(workDir, "RiftLauncher")
  mkdirSync(installPath, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("isTrustedPortableMarker", () => {
  it("accepts the empty file it expects", () => {
    writeFileSync(join(installPath, PORTABLE_MARKER_FILE), "")

    assert.equal(isTrustedPortableMarker(join(installPath, PORTABLE_MARKER_FILE)), true)
  })

  it("rejects a file with something in it, a folder, and nothing at all", () => {
    const data = join(installPath, "data")
    writeFileSync(data, "not a marker")
    mkdirSync(join(installPath, "folder"), { recursive: true })

    assert.equal(isTrustedPortableMarker(data), false)
    assert.equal(isTrustedPortableMarker(join(installPath, "folder")), false)
    assert.equal(isTrustedPortableMarker(join(installPath, PORTABLE_MARKER_FILE)), false)
  })

  it.skipIf(process.platform === "win32")("rejects a link pointing at an empty file elsewhere", () => {
    const target = join(workDir, "target")
    writeFileSync(target, "")
    symlinkSync(target, join(installPath, PORTABLE_MARKER_FILE))

    assert.equal(lstatSync(join(installPath, PORTABLE_MARKER_FILE)).isSymbolicLink(), true)
    assert.equal(isTrustedPortableMarker(join(installPath, PORTABLE_MARKER_FILE)), false)
  })

  it.skipIf(process.platform === "win32")("rejects a marker another account owns", () => {
    writeFileSync(join(installPath, PORTABLE_MARKER_FILE), "")
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1)

    assert.equal(isTrustedPortableMarker(join(installPath, PORTABLE_MARKER_FILE)), false)
  })
})

describe("portablePathsForCurrentInstall", () => {
  it("places the marker and the profile outside an NSIS install folder", () => {
    const paths = portablePathsForCurrentInstall("win32", "D:\\Games\\RiftLauncher\\RiftLauncher.exe", undefined, undefined)

    assert.deepEqual(paths, {
      markerPath: `D:\\Games\\${PORTABLE_MARKER_FILE}`,
      dataPath: `D:\\Games\\${PORTABLE_USER_DATA_FOLDER}`,
      installPath: "D:\\Games\\RiftLauncher"
    })
  })

  it("places them beside the AppImage", () => {
    assert.deepEqual(portablePathsForCurrentInstall("linux", "/usr/bin/riftlauncher", "/mnt/games/riftlauncher.AppImage", undefined), {
      markerPath: `/mnt/games/${PORTABLE_MARKER_FILE}`,
      dataPath: `/mnt/games/${PORTABLE_USER_DATA_FOLDER}`
    })
  })

  it("refuses a Linux package install, whose folder belongs to the system", () => {
    // A profile written into /usr or /opt would be created as root, shared by every account on
    // the machine, and removed by the next package upgrade.
    for (const packageType of ["deb", "rpm", "pacman"]) {
      assert.equal(portablePathsForCurrentInstall("linux", "/usr/bin/riftlauncher", "/mnt/games/riftlauncher.AppImage", packageType), null)
    }
  })

  it("has nowhere to put it without an AppImage, or on a platform with no portable layout", () => {
    assert.equal(portablePathsForCurrentInstall("linux", "/usr/bin/riftlauncher", undefined, undefined), null)
    assert.equal(portablePathsForCurrentInstall("linux", "/usr/bin/riftlauncher", "relative.AppImage", undefined), null)
    assert.equal(portablePathsForCurrentInstall("darwin", "/Applications/RiftLauncher.app", undefined, undefined), null)
  })
})

describe("selectUserDataFolder", () => {
  // A sibling of the install folder, which is where both layouts put it: an NSIS install keeps the
  // profile one folder up, and an AppImage keeps it beside the image.
  const dataPath = (): string => join(workDir, PORTABLE_USER_DATA_FOLDER)

  it("opens the portable profile when the marker beside the install folder is trusted", () => {
    writeFileSync(join(installPath, PORTABLE_MARKER_FILE), "")
    const appDataPath = join(workDir, "appData")

    const selection = selectUserDataFolder(appDataPath, { markerPath: join(installPath, PORTABLE_MARKER_FILE), dataPath: dataPath(), installPath })

    assert.equal(selection.portableMode, true)
    assert.equal(selection.rejectedMarker, false)
    assert.equal(selection.setup.path, dataPath())
    assert.equal(existsSync(join(appDataPath, RIFT_USER_DATA_FOLDER)), false)
  })

  it("falls back to the default profile and says so when the marker is not one it trusts", () => {
    writeFileSync(join(installPath, PORTABLE_MARKER_FILE), "not empty")
    const appDataPath = join(workDir, "appData")

    const selection = selectUserDataFolder(appDataPath, { markerPath: join(installPath, PORTABLE_MARKER_FILE), dataPath: dataPath(), installPath })

    assert.equal(selection.portableMode, false)
    assert.equal(selection.rejectedMarker, true)
    assert.equal(selection.setup.path, join(appDataPath, RIFT_USER_DATA_FOLDER))
    assert.equal(existsSync(dataPath()), false)
  })

  it("opens the default profile when there is no marker to read", () => {
    const appDataPath = join(workDir, "appData")

    const selection = selectUserDataFolder(appDataPath, { markerPath: join(installPath, PORTABLE_MARKER_FILE), dataPath: dataPath(), installPath })

    assert.equal(selection.portableMode, false)
    assert.equal(selection.rejectedMarker, false)
    assert.equal(selection.setup.path, join(appDataPath, RIFT_USER_DATA_FOLDER))
  })
})

describe("describePortableDecision", () => {
  const setup = { path: "/tmp/profile", outcome: "fresh" as const, copied: [], cleanedStaleMigration: false }

  it("names the portable profile, the refused marker, or nothing at all", () => {
    assert.match(describePortableDecision({ setup, portableMode: true, rejectedMarker: false }), /portable profile folder/)
    assert.match(describePortableDecision({ setup, portableMode: false, rejectedMarker: true }), /Ignored the portable marker/)
    assert.equal(describePortableDecision({ setup, portableMode: false, rejectedMarker: false }), "")
  })
})

/**
 * The ordering the whole thing rests on: `src/main/index.ts` chooses the profile while its first
 * import is being evaluated, so every other import of the entry runs afterwards. A log call at
 * module scope anywhere in between is what fixed electron-log to the default profile in the first
 * place (#581), and it is the kind of line that comes back without anyone noticing.
 */
describe("the entry decides the profile before anything else runs", () => {
  const root = resolve(__dirname, "../..")
  const srcDir = join(root, "src")

  function sourceOf(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  }

  /** The path map the build itself uses, so `@src/*` and `@domain/*` resolve the way they compile. */
  const compilerOptions = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, "tsconfig.node.json"), ts.sys.readFile).config, ts.sys, root).options

  const isOurs = (file: string): boolean => resolve(file).startsWith(`${resolve(srcDir)}${sep}`)

  /** A specifier that names our own code, which the walk is expected to be able to follow. */
  const claimsOurs = (specifier: string): boolean => specifier.startsWith("@src/") || specifier.startsWith("@domain/") || specifier.startsWith(".")

  /**
   * Every module of ours that `file` reaches. Resolution goes through the compiler rather than a
   * hand-kept list of prefixes, and a specifier that names our own code but does not resolve is an
   * error here: dropping it would leave the walk quietly blind to exactly the edge it cannot see.
   */
  function localModulesOf(file: string): string[] {
    return sourceOf(file)
      .statements.filter((statement): statement is ts.ImportDeclaration | ts.ExportDeclaration => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral | undefined)?.text)
      .filter((specifier): specifier is string => specifier !== undefined)
      .map((specifier) => {
        const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName
        const target = resolved === undefined ? undefined : resolve(resolved)
        const reachable = target !== undefined && isOurs(target)
        assert.ok(!claimsOurs(specifier) || reachable, `${file} imports ${specifier}, which this walk cannot resolve`)
        return reachable ? target : null
      })
      .filter((target): target is string => target !== null)
  }

  const unwrap = (node: ts.Node): ts.Node => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node)

  /** A body that runs later than its module is evaluated, unless the module calls it on the spot. */
  const defersUntilCalled = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    // A static field initializer and a static block run while the class is defined; an instance
    // field runs when an object is built, which can be long after this module was evaluated.
    (ts.isPropertyDeclaration(node) && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))

  /**
   * Calls that run while the module is being evaluated. A local function called at module scope is
   * followed, because an `init()` helper that logs is the same hazard as logging directly.
   */
  function moduleScopeLogCalls(file: string): string[] {
    const source = sourceOf(file)
    const found: string[] = []
    const localFunctions = new Map(
      source.statements
        .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name !== undefined)
        .map((statement) => [statement.name?.text as string, statement])
    )
    const followed = new Set<string>()

    // `import { logMessage as say }` is the same call under another name.
    const loggerNames = new Set(["logMessage"])
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.propertyName?.text === "logMessage" || element.name.text === "logMessage") loggerNames.add(element.name.text)
      }
    }

    const isLoggerCall = (node: ts.CallExpression): boolean => {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name.text : null
      return name !== null && (loggerNames.has(name) || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Logger"))
    }

    const visit = (node: ts.Node, deferred: boolean): void => {
      if (!deferred && ts.isCallExpression(node) && isLoggerCall(node)) {
        found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
      }

      ts.forEachChild(node, (rawChild) => {
        // Parentheses are not a scope: `(function () {})()` and `(() => {})()` run on the spot.
        const child = unwrap(rawChild)
        const calledHere = ts.isCallExpression(node) && unwrap(node.expression) === child
        if (!deferred && calledHere && ts.isIdentifier(child) && localFunctions.has(child.text) && !followed.has(child.text)) {
          followed.add(child.text)
          const declaration = localFunctions.get(child.text)
          if (declaration) ts.forEachChild(declaration, (inner) => visit(inner, false))
        }
        visit(child, deferred || (!calledHere && defersUntilCalled(child)))
      })
    }

    visit(source, false)
    return found
  }

  it("imports the boot module first, before any other module of the entry", () => {
    const entry = sourceOf(join(srcDir, "main", "index.ts"))
    const firstImport = entry.statements.find(ts.isImportDeclaration)

    assert.ok(firstImport, "src/main/index.ts should import the boot module")
    assert.equal((firstImport.moduleSpecifier as ts.StringLiteral).text, "@src/main/bootUserData")
  })

  it("keeps every module the boot module reaches free of module-scope logging", () => {
    const queue = [join(srcDir, "main", "bootUserData.ts")]
    const seen = new Set<string>()
    const offenders: string[] = []

    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      offenders.push(...moduleScopeLogCalls(file))
      queue.push(...localModulesOf(file))
    }

    assert.ok(seen.size > 3, `expected the boot graph to reach more than 3 local modules, reached ${seen.size}`)
    assert.ok(
      [...seen].some((file) => file.startsWith(join(srcDir, "domain"))),
      `expected the boot graph to reach src/domain, reached ${[...seen].join(", ")}`
    )
    assert.deepEqual(offenders, [])
  })
})
