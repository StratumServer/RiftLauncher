import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

const FILE_LOAD = "FileNotFoundException: Could not load file or assembly Optimum.Other\\n"
const TYPE_LOAD = "TypeLoadException: Could not load type 'Optimum.ModContracts.Blocks.IBlock' from assembly 'Optimum.GameContent.dll'\\n"
// A healthy startup line that happens to mention both an exception word and an
// `Optimum.` type. The failure pattern must not read it as a failure.
const BENIGN = "Startup check: no exceptions found in Optimum.GameContent\\n"

/**
 * One fake server per failure mode Optimum can produce on a dedicated server,
 * and the answer the smoke script has to give for it.
 *
 * `then` is code spliced into the fixture, where `log` is the server-main.log
 * path, and runs 750 ms in — late enough for the script to be watching by then.
 *
 * `runGameAfter` delays the RunGame line so the settle window can be tested
 * against a startup limit that is nearly spent: the window is proof the server
 * stays up, not part of the startup being measured, so a server that reaches
 * RunGame just inside the limit still has to pass. `runGameTo` sends that line to
 * the console instead of the log file, which is the other place it can appear.
 */
const MODES = {
  fatal: { timeout: 9000, runGameAfter: 0, then: () => `fs.appendFileSync(log, ${JSON.stringify(FILE_LOAD)})`, code: 1, output: /Optimum load failure/ },
  // A type that cannot be resolved throws a TypeLoadException, not a
  // FileNotFoundException, and the server keeps running after it. Matching only
  // the two file-load messages let this through as a pass.
  typeload: { timeout: 9000, runGameAfter: 0, then: () => `fs.appendFileSync(log, ${JSON.stringify(TYPE_LOAD)})`, code: 1, output: /Optimum load failure/ },
  // The same line on stdout instead of in the log file. Reading only
  // server-main.log left the console output unsearched, so this passed too.
  console: { timeout: 9000, runGameAfter: 0, then: () => `console.log(${JSON.stringify(TYPE_LOAD.trimEnd())})`, code: 1, output: /Optimum load failure/ },
  // The same line on stderr. capture() merges both streams, so searching the
  // console output has to cover stderr as well as stdout.
  stderr: { timeout: 9000, runGameAfter: 0, then: () => `console.error(${JSON.stringify(TYPE_LOAD.trimEnd())})`, code: 1, output: /Optimum load failure/ },
  exit: { timeout: 9000, runGameAfter: 0, then: () => "process.exit(0)", code: 1, output: /exited before or during startup/ },
  late: { timeout: 2000, runGameAfter: 1500, then: () => "", code: 0, output: /PASS:/ },
  // The server is up and the log stops carrying the RunGame line. Settling is
  // judged on when RunGame was seen, not on the line surviving in the log, so
  // this still settles instead of waiting for a line that never comes back.
  vanishing: { timeout: 2000, runGameAfter: 0, then: () => `fs.writeFileSync(log, "Still running\\n")`, code: 0, output: /PASS:/ },
  // A healthy server whose log mentions exceptions and an `Optimum.` type without
  // reporting one. Reading any "Exception" substring as a failure would fail this
  // server, so this mode is what keeps the pattern honest.
  benign: { timeout: 9000, runGameAfter: 0, then: () => `fs.appendFileSync(log, ${JSON.stringify(BENIGN)})`, code: 0, output: /PASS:/ },
  // RunGame reaches the console and never the log file. Readiness has to be looked
  // for in the console output too, or this healthy server is failed for not having
  // started.
  runGameOnConsole: { timeout: 2000, runGameAfter: 0, runGameTo: "console", then: () => "", code: 0, output: /PASS:/ },
  stable: { timeout: 9000, runGameAfter: 0, then: () => "", code: 0, output: /PASS:/ }
} as const

/** Linux executable fixtures exercise the shipped script, including its child lifetime. */
describe.skipIf(process.platform === "win32")("Optimum dedicated server smoke", () => {
  it.each(Object.entries(MODES))(
    "reports %s",
    async (_name, mode) => {
      const folder = mkdtempSync(join(tmpdir(), "rift-smoke-regression-"))
      const server = join(folder, "fake-server")
      mkdirSync(join(folder, ".optimum"))
      writeFileSync(join(folder, ".optimum", "manifest.json"), JSON.stringify({ optimumVersion: "fixture", targets: [] }))
      const runGameTo = "runGameTo" in mode ? mode.runGameTo : "log"
      writeFileSync(
        server,
        `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const data = process.argv.find(arg => arg.startsWith("--dataPath=")).slice(11)
if (process.argv.includes("--genconfig")) {
  fs.writeFileSync(path.join(data, "serverconfig.json"), "{}")
  process.exit(0)
}
fs.mkdirSync(path.join(data, "Logs"), { recursive: true })
const log = path.join(data, "Logs", "server-main.log")
setTimeout(() => {
  if (${JSON.stringify(runGameTo)} === "console") console.log("Entering runphase RunGame")
  else fs.writeFileSync(log, "Entering runphase RunGame\\n")
}, ${mode.runGameAfter})
setTimeout(() => { ${mode.then()} }, 750)
setInterval(() => {}, 1000)
`,
        { mode: 0o755 }
      )
      try {
        const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
          const child = spawn(process.execPath, [resolve("scripts/smoke/optimum-dedicated-server.mjs"), folder], {
            env: { ...process.env, VINTAGESTORY_SERVER: server, RIFTLAUNCHER_SERVER_SMOKE_TIMEOUT_MS: String(mode.timeout) }
          })
          let output = ""
          child.stdout.on("data", (chunk) => {
            output += chunk
          })
          child.stderr.on("data", (chunk) => {
            output += chunk
          })
          child.on("error", reject)
          child.on("close", (code) => resolveResult({ code, output }))
        })
        assert.equal(result.code, mode.code, result.output)
        if (mode.code === 0) assert.match(result.output, mode.output)
        else {
          assert.doesNotMatch(result.output, /PASS:/)
          assert.match(result.output, mode.output)
        }
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
    20000
  )
})
