import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, it } from "vitest"

import { describeLauncherExit, explainSocketClose, readLauncherExit, readLogTails } from "../e2e/launcher-death"

/**
 * What the packaged Windows conformance run keeps of a launcher that dies on it (#614).
 *
 * tests/e2e/packaged-windows-install.ts exits on import anywhere but a Windows CI runner, so the
 * parts of it that need nothing from Windows live in tests/e2e/launcher-death.ts and are tested
 * here, with the one workflow step that reads what a crashed launcher cannot log for itself. What
 * only a Windows run shows: a real exit code off a real crash, and the events Windows records.
 */

/** Stands in for the ChildProcess the run spawned: Node sets exitCode or signalCode, then emits "exit". */
class FakeLauncher extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  exitWith(code: number): void {
    this.exitCode = code
    this.emit("exit", code, null)
  }
}

describe("the launcher's exit", () => {
  it("is nothing while the launcher runs", () => {
    assert.equal(readLauncherExit(new FakeLauncher()), null)
  })

  it("keeps the code of a launcher that exited, 0 included, and the signal of one that was ended", () => {
    const exited = new FakeLauncher()
    exited.exitCode = 0
    const ended = new FakeLauncher()
    ended.signalCode = "SIGKILL"

    assert.deepEqual(readLauncherExit(exited), { code: 0, signal: null })
    assert.deepEqual(readLauncherExit(ended), { code: null, signal: "SIGKILL" })
  })

  it("says a plain exit code as it is and a Windows crash status in hex as well", () => {
    assert.equal(describeLauncherExit({ code: 1, signal: null }), "exited with code 1")
    assert.equal(describeLauncherExit({ code: 3221225477, signal: null }), "exited with code 3221225477 (0xC0000005)")
  })

  it("names the signal that ended it", () => {
    assert.equal(describeLauncherExit({ code: null, signal: "SIGSEGV" }), "was ended by signal SIGSEGV")
  })
})

describe("explaining a closed DevTools socket", () => {
  it("names the exit of a launcher that is already gone", async () => {
    const launcher = new FakeLauncher()
    launcher.exitWith(3221225477)

    assert.equal(await explainSocketClose(launcher, 1_000), "the launcher process exited with code 3221225477 (0xC0000005)")
  })

  it("waits for an exit that follows the close", async () => {
    const launcher = new FakeLauncher()
    setTimeout(() => launcher.exitWith(1), 10)

    assert.equal(await explainSocketClose(launcher, 5_000), "the launcher process exited with code 1")
  })

  it("calls the launcher still running when no exit follows within the grace", async () => {
    assert.equal(await explainSocketClose(new FakeLauncher(), 20), "the launcher process was still running 20ms later")
  })
})

describe("the tail of the launcher's own logs", () => {
  const folders: string[] = []

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  /** A user data folder whose Logs folder holds the given files. */
  function userDataWith(logs: Record<string, string>): string {
    const userData = mkdtempSync(join(tmpdir(), "riftlauncher-logtails-"))
    folders.push(userData)
    mkdirSync(join(userData, "Logs"))
    for (const [name, content] of Object.entries(logs)) writeFileSync(join(userData, "Logs", name), content)
    return userData
  }

  const numbered = (count: number): string => `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`

  it("keeps the last lines of each log", () => {
    const tails = readLogTails(userDataWith({ "info.log": numbered(100), "error.log": numbered(2) }), 60)

    assert.equal(tails["info.log"]?.length, 60)
    assert.equal(tails["info.log"]?.[0], "line 41")
    assert.equal(tails["info.log"]?.at(-1), "line 100")
    assert.deepEqual(tails["error.log"], ["line 1", "line 2"])
  })

  it("reads Windows line endings without a carriage return or a blank line left over", () => {
    assert.deepEqual(readLogTails(userDataWith({ "info.log": "first\r\nsecond\r\n" }), 60), { "info.log": ["first", "second"] })
  })

  it("leaves out files that are not logs and logs with nothing in them", () => {
    assert.deepEqual(readLogTails(userDataWith({ "info.log": "one\n", "empty.log": "", "config.json": "{}" }), 60), { "info.log": ["one"] })
  })

  it("does not throw over what it cannot read", () => {
    const userData = userDataWith({ "info.log": "one\n" })
    // A folder named like a log cannot be read as one, and must not hide the log beside it.
    mkdirSync(join(userData, "Logs", "folder.log"))

    assert.deepEqual(readLogTails(userData, 60), { "info.log": ["one"] })
    assert.deepEqual(readLogTails(join(userData, "missing"), 60), {})
  })
})

describe("the packaged conformance workflow", () => {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/packaged-windows-conformance.yml"), "utf8")
  // The steps sit six spaces in, so each one starts at "      - ".
  const crashEventsStep = workflow.split(/^ {6}- /m).find((step) => step.includes("Windows Error Reporting"))

  it("prints the launcher's Windows crash events, and only when the run failed", () => {
    assert.ok(crashEventsStep, "no step reads the Windows Error Reporting events")
    assert.match(crashEventsStep, /^ {8}if: failure\(\)$/m)
    assert.match(crashEventsStep, /ProviderName = 'Application Error', 'Windows Error Reporting'/)
    assert.match(crashEventsStep, /RiftLauncher\.exe/)
  })
})
