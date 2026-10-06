#!/usr/bin/env node

// Standalone Node ESM smoke script.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const TIMEOUT_MS = Number(process.env.RIFTLAUNCHER_SERVER_SMOKE_TIMEOUT_MS ?? 120_000)
const STOP_TIMEOUT_MS = 10_000
const RUN_GAME = /Entering runphase RunGame/
const OPTIMUM_FAILURE = /(?:FileNotFoundException|Could not load file or assembly).*Optimum\./i

function usage() {
  return "Usage: node scripts/smoke/optimum-dedicated-server.mjs <freshly-patched-game-directory>\nSet VINTAGESTORY_SERVER to select a server executable when the folder has more than one."
}

function capture(child) {
  let output = ""
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8")
    stream?.on("data", (chunk) => {
      output = (output + chunk).slice(-32_000)
    })
  }
  const closed = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal }))
  })
  return { closed, output: () => output }
}

async function start(executable, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const captured = capture(child)
    child.once("error", reject)
    child.once("spawn", () => resolvePromise({ child, ...captured }))
  })
}

async function stop(child, closed) {
  if (child.exitCode !== null || child.signalCode !== null) return closed
  child.kill("SIGTERM")
  const stopped = await Promise.race([closed, delay(STOP_TIMEOUT_MS).then(() => undefined)])
  if (stopped) return stopped
  child.kill("SIGKILL")
  return closed
}

async function waitForClose(handle, timeoutMs) {
  const result = await Promise.race([handle.closed, delay(timeoutMs).then(() => undefined)])
  if (result) return result
  await stop(handle.child, handle.closed)
  throw new Error(`The server process did not exit within ${timeoutMs} ms.\n${handle.output()}`)
}

async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port")
  await new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())))
  return address.port
}

async function findServer(gameDirectory) {
  const selected = process.env.VINTAGESTORY_SERVER
  const candidates = selected
    ? [resolve(selected)]
    : process.platform === "win32"
      ? [join(gameDirectory, "VintagestoryServer.exe")]
      : [join(gameDirectory, "VintagestoryServer"), join(gameDirectory, "VintagestoryServer.dll")]

  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" || candidate.endsWith(".dll") ? constants.R_OK : constants.X_OK)
      return candidate.endsWith(".dll") ? { executable: "dotnet", args: [candidate] } : { executable: candidate, args: [] }
    } catch {
      // Try the next platform-specific server apphost.
    }
  }
  throw new Error(`No runnable Vintage Story dedicated server was found in ${gameDirectory}.\nSet VINTAGESTORY_SERVER to its full path.`)
}

async function readServerLog(path) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

function lastLines(value, count = 50) {
  return value.split(/\r?\n/).slice(-count).join("\n")
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const gameDirectory = process.argv[2] ? resolve(process.argv[2]) : ""
  if (!gameDirectory || !Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 1_000) {
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 2
    return
  }

  const patchManifestPath = join(gameDirectory, ".optimum", "manifest.json")
  let patchManifest
  try {
    patchManifest = JSON.parse(await readFile(patchManifestPath, "utf8"))
  } catch {
    throw new Error("The game directory has no readable .optimum/manifest.json. Patch an isolated copy with RiftLauncher first.")
  }
  if (typeof patchManifest?.optimumVersion !== "string" || !Array.isArray(patchManifest.targets)) {
    throw new Error("The game's .optimum/manifest.json does not describe a completed Optimum patch.")
  }
  try {
    await access(join(gameDirectory, "Optimum.GameContent.dll"), constants.R_OK)
  } catch {
    throw new Error(`Optimum ${patchManifest.optimumVersion} did not install Optimum.GameContent.dll. The server smoke cannot pass without it.`)
  }

  const server = await findServer(gameDirectory)
  const dataDirectory = await mkdtemp(join(tmpdir(), "riftlauncher-optimum-server-smoke-"))
  let processHandle
  try {
    const configResult = await start(server.executable, [...server.args, "--genconfig", `--dataPath=${dataDirectory}`], gameDirectory)
    const configExit = await waitForClose(configResult, 30_000)
    if (configExit.code !== 0) throw new Error(`Could not create an isolated server configuration.\n${configResult.output()}`)

    const configPath = join(dataDirectory, "serverconfig.json")
    const config = JSON.parse(await readFile(configPath, "utf8"))
    const port = await freeLoopbackPort()
    config.AdvertiseServer = false
    config.Ip = "127.0.0.1"
    config.Port = port
    config.Upnp = false
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

    processHandle = await start(server.executable, [...server.args, `--dataPath=${dataDirectory}`, "--ip=127.0.0.1", `--port=${port}`], gameDirectory)
    const logPath = join(dataDirectory, "Logs", "server-main.log")
    const deadline = Date.now() + TIMEOUT_MS
    let serverLog = ""
    let reachedRunGameAt = null
    const SETTLE_MS = 5_000
    while (Date.now() < deadline) {
      serverLog = await readServerLog(logPath)
      if (OPTIMUM_FAILURE.test(serverLog)) {
        throw new Error(`The dedicated server reported an Optimum assembly load failure.\n${lastLines(serverLog)}`)
      }
      if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
        const result = await processHandle.closed
        throw new Error(`The dedicated server exited before or during startup (code ${result.code}, signal ${result.signal}).\n${lastLines(serverLog || processHandle.output())}`)
      }
      if (RUN_GAME.test(serverLog)) {
        if (reachedRunGameAt === null) {
          reachedRunGameAt = Date.now()
        } else if (Date.now() - reachedRunGameAt >= SETTLE_MS) {
          process.stdout.write(`PASS: The dedicated server with Optimum ${patchManifest.optimumVersion} reached RunGame on a loopback-only server.\n`)
          return
        }
      }
      await delay(250)
    }
    throw new Error(`The dedicated server did not reach RunGame within ${TIMEOUT_MS} ms.\n${lastLines(serverLog || processHandle.output())}`)
  } finally {
    if (processHandle) await stop(processHandle.child, processHandle.closed)
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
