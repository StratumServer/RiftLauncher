import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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

  it("rejects a link pointing at an empty file elsewhere", () => {
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

  function localImportsOf(file: string): string[] {
    return sourceOf(file)
      .statements.filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
      .map((specifier) => {
        if (specifier.startsWith("@src/")) return join(srcDir, `${specifier.slice("@src/".length)}.ts`)
        if (specifier.startsWith(".")) return resolve(dirname(file), `${specifier}.ts`)
        return null
      })
      .filter((file): file is string => file !== null && existsSync(file))
  }

  /** Calls that run while the module is being evaluated, skipping anything inside a function. */
  function moduleScopeLogCalls(file: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) return
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name.text : null
        if (name === "logMessage" || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Logger")) {
          found.push(`${file}: ${node.getText(sourceOf(file)).split("\n")[0]}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceOf(file))
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
      queue.push(...localImportsOf(file))
    }

    assert.ok(seen.size > 3, `expected the boot graph to reach more than 3 local modules, reached ${seen.size}`)
    assert.deepEqual(offenders, [])
  })
})
