import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

/** Linux executable fixtures exercise the shipped script, including its child lifetime. */
describe.skipIf(process.platform === "win32")("Optimum dedicated server smoke", () => {
  it.each(["fatal", "exit", "stable"])(
    "settles RunGame before reporting success: %s",
    async (mode) => {
      const folder = mkdtempSync(join(tmpdir(), "rift-smoke-regression-"))
      const server = join(folder, "fake-server")
      mkdirSync(join(folder, ".optimum"))
      writeFileSync(join(folder, ".optimum", "manifest.json"), JSON.stringify({ optimumVersion: "fixture", targets: [] }))
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
fs.writeFileSync(log, "Entering runphase RunGame\\n")
if (${JSON.stringify(mode)} === "fatal") setTimeout(() => fs.appendFileSync(log, "FileNotFoundException: Could not load file or assembly Optimum.Other\\n"), 750)
if (${JSON.stringify(mode)} === "exit") setTimeout(() => process.exit(0), 750)
setInterval(() => {}, 1000)
`,
        { mode: 0o755 }
      )
      try {
        const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
          const child = spawn(process.execPath, [resolve("scripts/smoke/optimum-dedicated-server.mjs"), folder], {
            env: { ...process.env, VINTAGESTORY_SERVER: server, RIFTLAUNCHER_SERVER_SMOKE_TIMEOUT_MS: "9000" }
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
        assert.equal(result.code, mode === "stable" ? 0 : 1, result.output)
        if (mode === "stable") assert.match(result.output, /PASS:/)
        else {
          assert.doesNotMatch(result.output, /PASS:/)
          assert.match(result.output, mode === "fatal" ? /Optimum assembly load failure/ : /exited before or during startup/)
        }
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
    15000
  )
})
