// Child process for tests/ipc/nativeLzma2WorkerUnload.test.ts.
//
// Usage: node workerAddonUnload.mjs <cycles> <pin|nopin> <lzma2 file> <dictSize>
//
// Mirrors how the launcher ends a RUN_INSTALLER worker: a worker loads
// @napi-rs/lzma/lzma2, decodes a payload to the end, posts "finished", and the
// parent calls worker.terminate(). Node closes an addon loaded only by a worker when
// that worker's environment goes away; on Windows, @napi-rs/lzma 1.5.1 (napi 3.10.5)
// leaves its tokio threads running in the unloaded DLL and the process dies with
// 0xC0000005 (napi-rs/napi-rs#3443). "pin" loads the addon on this main thread
// first, which keeps it mapped and its runtime alive, as the launcher does.
//
// It runs in a child process so an access violation shows up as a non-zero exit
// status instead of taking the test runner down.
import { once } from "node:events"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { Worker } from "node:worker_threads"

const [cyclesArg, mode, file, dictSizeArg] = process.argv.slice(2)
const cycles = Number(cyclesArg)
const dictSize = Number(dictSizeArg)
const payload = readFileSync(file)
const require = createRequire(import.meta.url)

if (mode === "pin") require("@napi-rs/lzma/lzma2")

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads")
const { decompressStream } = require(workerData.addon)
parentPort.once("message", async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(workerData.payload))
      controller.close()
    }
  })
  const reader = decompressStream(input, { dictSize: workerData.dictSize }).getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
  }
  parentPort.postMessage({ type: "finished", total })
})
parentPort.postMessage({ type: "ready" })
`

let expectedTotal
for (let cycle = 0; cycle < cycles; cycle++) {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { addon: require.resolve("@napi-rs/lzma/lzma2"), payload, dictSize }
  })
  await once(worker, "message")
  worker.postMessage({ type: "start" })
  const [done] = await once(worker, "message")
  if (done.type !== "finished" || done.total === 0) throw new Error(`cycle ${cycle}: unexpected message ${JSON.stringify(done)}`)
  expectedTotal ??= done.total
  if (done.total !== expectedTotal) throw new Error(`cycle ${cycle}: decoded ${done.total} bytes, expected ${expectedTotal}`)
  await worker.terminate()
}
console.log(`survived ${cycles} cycles`)
