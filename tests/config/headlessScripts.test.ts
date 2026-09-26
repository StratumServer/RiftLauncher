import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { resolve } from "node:path"
import { afterEach, describe, it } from "vitest"

/**
 * scripts/headless/stop.sh and scripts/headless/cdp.mjs against real child processes, the same
 * way tests/config/headlessSeed.test.ts runs seed.mjs: these are dependency-free scripts meant to
 * run out of process, so this never reimplements what they do.
 *
 * stop.sh's own argument and process-identity checks are what #535 closed: a bad argument must
 * never reach a real `kill`. Every refused-argument case below runs inside its own `setsid`
 * session alongside a witness `sleep`, the isolation docs/contribute/headless-checks.md also asks
 * a person testing this by hand to use, so a regression that still signals a whole process group
 * only reaches that throwaway session, never this test runner's own.
 *
 * cdp.mjs needs a live packaged build and a real page to click something (#536's core coverage,
 * the fold/overlay/off-screen refusals), which is covered by the headless live check
 * (docs/contribute/headless-checks.md), not here. What runs without a browser: argument parsing,
 * and the rpc() timeout, against a local WebSocket server that never answers.
 */

const repoRoot = resolve(__dirname, "../..")
const stopScript = resolve(repoRoot, "scripts/headless/stop.sh")
const cdpScript = resolve(repoRoot, "scripts/headless/cdp.mjs")

const liveSleeps: number[] = []

afterEach(() => {
  while (liveSleeps.length > 0) {
    const pid = liveSleeps.pop()
    if (pid === undefined) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
})

function spawnSleep(seconds = 30): number {
  const child = spawn("sleep", [String(seconds)], { stdio: "ignore" })
  assert.ok(child.pid, "sleep did not get a pid")
  liveSleeps.push(child.pid)
  return child.pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Runs `stop.sh <arg>` inside its own setsid session, alongside a witness sleep started in that
 * same session/group. If stop.sh still signalled the group instead of refusing (the #535 bug),
 * the witness dies with it; this only reports that, it never depends on it.
 */
function runStopWithWitness(arg: string): { status: number; witnessAlive: boolean; raw: string } {
  const script = `
    set -e
    sleep 30 &
    witness=$!
    set +e
    "$0" "$1"
    rc=$?
    if kill -0 "$witness" 2>/dev/null; then alive=1; else alive=0; fi
    kill "$witness" 2>/dev/null || true
    wait "$witness" 2>/dev/null
    printf 'RC=%s ALIVE=%s\n' "$rc" "$alive" >&2
    exit 0
  `
  const result = spawnSync("setsid", ["--wait", "bash", "-c", script, stopScript, arg], {
    encoding: "utf-8",
    timeout: 15_000
  })
  const match = /RC=(-?\d+) ALIVE=(\d)/.exec(result.stderr)
  assert.ok(match, `expected an RC/ALIVE marker in stderr, got:\n${result.stderr}`)
  return { status: Number(match[1]), witnessAlive: match[2] === "1", raw: result.stderr }
}

// stop.sh is a bash script signalling real pids: setsid, /proc and POSIX kill semantics are all
// Linux-specific (setsid does not exist on macOS either, and Windows cannot exec a shebang script
// through spawnSync at all), matching launch.sh's own scope (a Linux packaged build). The CI
// matrix's windows-latest leg has nothing here to run.
describe.skipIf(process.platform !== "linux")("scripts/headless/stop.sh", () => {
  const refused = ["0", "00", "1", "-1", "1e3", " 12", "", "abc", "12x", "9999999999999999999"]

  it.each(refused)("refuses %j before signalling anything, leaving the witness alive", (arg) => {
    const { status, witnessAlive, raw } = runStopWithWitness(arg)
    assert.equal(status, 1, raw)
    assert.ok(witnessAlive, `witness sleep was killed: stop.sh signalled more than "${arg}" alone`)
  })

  it("refuses more than one argument", () => {
    const result = spawnSync(stopScript, ["123", "456"], { encoding: "utf-8" })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /usage:/)
  })

  it("refuses a live pid that is not a headless launcher, leaving it alive", () => {
    const pid = spawnSleep()
    const result = spawnSync(stopScript, [String(pid)], { encoding: "utf-8" })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(isAlive(pid), "stop.sh killed a process whose /proc cmdline never mentions the launcher")
  })

  it("refuses that same live, non-launcher pid written with leading whitespace", () => {
    const pid = spawnSleep()
    const result = spawnSync(stopScript, [` ${pid}`], { encoding: "utf-8" })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(isAlive(pid))
  })

  it("refuses a pid that has already exited", () => {
    const finished = spawnSync("true", [])
    assert.ok(finished.pid, "the throwaway process did not get a pid")
    const result = spawnSync(stopScript, [String(finished.pid)], { encoding: "utf-8" })
    assert.equal(result.status, 1, result.stderr)
  })

  it("stops a live pid whose /proc cmdline names the packaged binary", async () => {
    // Fakes argv[0] the way launch.sh's real `dist/linux-unpacked/riftlauncher` would read on
    // /proc/<pid>/cmdline, without an actual packaged build: the live check covers the real one.
    const child = spawn("bash", ["-c", "exec -a dist/linux-unpacked/riftlauncher sleep 30"], { stdio: "ignore" })
    assert.ok(child.pid)
    const pid = child.pid
    liveSleeps.push(pid)

    const cmdlinePath = `/proc/${pid}/cmdline`
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        if (readFileSync(cmdlinePath, "utf-8").includes("riftlauncher")) break
      } catch {
        // not execed yet
      }
      await new Promise((r) => setTimeout(r, 20))
    }

    // Not spawnSync: this process is `pid`'s real OS parent (it spawned it above), so it alone can
    // reap it once stop.sh's SIGTERM lands. spawnSync would block this event loop for the entire
    // call, stop.sh's own `kill -0` wait loop would keep seeing a zombie for all 10s of it, and
    // stop.sh would fall through to its SIGKILL fallback instead of the quick SIGTERM path this
    // test means to exercise. An async run keeps this process free to reap it as it happens.
    const exitedPromise = new Promise<void>((res) => child.once("exit", res))
    const result = await new Promise<{ status: number | null; stderr: string }>((resolvePromise) => {
      const stopChild = spawn(stopScript, [String(pid)])
      let stderr = ""
      stopChild.stderr.on("data", (chunk: Buffer) => (stderr += chunk))
      stopChild.on("close", (status) => resolvePromise({ status, stderr }))
    })
    assert.equal(result.status, 0, result.stderr)

    const exited = await Promise.race([exitedPromise.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 2000))])
    assert.ok(exited, "stop.sh reported success but the launcher-like process never exited")
  })
})

function computeAcceptKey(key: string): string {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64")
}

function writeUpgradeResponse(req: IncomingMessage, socket: Socket): boolean {
  const key = req.headers["sec-websocket-key"]
  if (typeof key !== "string") {
    socket.destroy()
    return false
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`)
  return true
}

function pageListResponse(res: ServerResponse, port: number): void {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/test` }]))
}

/** A CDP endpoint that serves one page target and completes the WebSocket handshake, then never answers a single message: what a hung renderer or a dropped socket looks like from cdp.mjs's side. */
async function startSilentCdpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  let upgraded: Socket | undefined
  const server: Server = createServer((req, res) => {
    if (req.url === "/json/list") return pageListResponse(res, (server.address() as { port: number }).port)
    res.writeHead(404)
    res.end()
  })
  server.on("upgrade", (req, socket: Socket) => {
    upgraded = socket
    writeUpgradeResponse(req, socket)
    // No frame is ever read or written back from here on.
  })
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res))
  const { port } = server.address() as { port: number }
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        upgraded?.destroy()
        server.close(() => res())
      })
  }
}

/** Reads one WebSocket frame off the front of `buf` (client frames are always masked). Only handles payloads under 64KiB: everything this driver's own calls ever send. Returns null if `buf` does not yet hold a whole frame. */
function readClientFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let len = buf[1]! & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    return null // not needed for what this driver sends in these tests
  }
  if (masked) offset += 4
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (masked) {
    const maskKey = buf.subarray(offset - 4, offset)
    const unmasked = Buffer.alloc(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ maskKey[i % 4]!
    payload = unmasked
  }
  return { opcode, payload, consumed: offset + len }
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8")
  const len = payload.length
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.alloc(4)
  if (len >= 126) {
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  }
  return Buffer.concat([header, payload])
}

/** A CDP endpoint that answers every call with an empty result, so a real check (Page.enable, Runtime.enable) succeeds and a command's own argument validation is reached, without a browser behind it. */
async function startEchoCdpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  let upgraded: Socket | undefined
  const server: Server = createServer((req, res) => {
    if (req.url === "/json/list") return pageListResponse(res, (server.address() as { port: number }).port)
    res.writeHead(404)
    res.end()
  })
  server.on("upgrade", (req, socket: Socket) => {
    if (!writeUpgradeResponse(req, socket)) return
    upgraded = socket
    let buf = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const frame = readClientFrame(buf)
        if (!frame) break
        buf = buf.subarray(frame.consumed)
        if (frame.opcode !== 0x1) continue
        const msg = JSON.parse(frame.payload.toString("utf-8")) as { id: number }
        socket.write(encodeServerTextFrame(JSON.stringify({ id: msg.id, result: {} })))
      }
    })
  })
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res))
  const { port } = server.address() as { port: number }
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        upgraded?.destroy()
        server.close(() => res())
      })
  }
}

/**
 * Runs cdp.mjs as a real child process without blocking this process's own event loop: the fake
 * CDP servers above live in this same process, so a synchronous spawnSync here would freeze the
 * only thing able to accept their connections while it waits for the child to exit.
 */
function runCdp(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cdpScript, ...args], { env })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk))
    child.stdout.resume()
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (status) => {
      clearTimeout(timer)
      resolvePromise({ status, stderr })
    })
  })
}

describe("scripts/headless/cdp.mjs", () => {
  it("fails with usage when no command is given", async () => {
    const result = await runCdp([], { ...process.env, CDP_PORT: "1" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /usage:/)
  })

  it("fails when CDP_PORT is not set", async () => {
    const env = { ...process.env }
    delete env.CDP_PORT
    const result = await runCdp(["text"], env)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /CDP_PORT/)
  })

  it("fails when CDP_TIMEOUT_MS is not a positive number", async () => {
    const result = await runCdp(["text"], { ...process.env, CDP_PORT: "1", CDP_TIMEOUT_MS: "0" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /CDP_TIMEOUT_MS/)
  })

  it.each(["click", "clickText"])("fails %s with too few arguments", async (command) => {
    const { port, close } = await startEchoCdpServer()
    try {
      const result = await runCdp([command], { ...process.env, CDP_PORT: String(port) })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /usage:/)
    } finally {
      await close()
    }
  })

  it("times out and names the stuck method instead of hanging forever", async () => {
    const { port, close } = await startSilentCdpServer()
    try {
      const result = await runCdp(["text"], { ...process.env, CDP_PORT: String(port), CDP_TIMEOUT_MS: "200" })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /Page\.enable timed out after 200ms/)
    } finally {
      await close()
    }
  })
})
