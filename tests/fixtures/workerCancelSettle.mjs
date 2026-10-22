// Child process for tests/ipc/nativeLzma2WorkerCancel.test.ts.
//
// Usage: node workerCancelSettle.mjs <cycles> <settleMs> <lzma2 file> <dictSize>
//
// A worker starts a native LZMA2 decode of a slowly fed stream, the parent lets it run for a few
// milliseconds, asks it to cancel the reader, waits `settleMs`, and terminates the thread. That is
// the order NativeLzma2Decoder.close and the worker pool's cancel follow. With @napi-rs/lzma 1.5.1
// (napi 3.10.5) on Node 22, ending the thread less than about 30 ms after the cancel makes napi
// panic while it drops a callback reference ("Call custom GC in FunctionRef::drop failed
// InvalidArg") and the process dies with SIGABRT (#758). The child runs apart so that shows up as
// a non-zero exit status instead of taking the test runner down.
import { once } from "node:events"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { Worker } from "node:worker_threads"

const [cyclesArg, settleArg, file, dictSizeArg] = process.argv.slice(2)
const cycles = Number(cyclesArg)
const settleMs = Number(settleArg)
const payload = readFileSync(file)
const require = createRequire(import.meta.url)

// Keep the addon loaded on the main thread, as pathsHandlers does in production. Node unloads an
// addon when the last worker that loaded it exits, and napi-rs before 3.12.1 then faults on
// Windows (0xC0000005, #756), which is not the #758 abort this fixture measures.
require("@napi-rs/lzma/lzma2")

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads")
const { decompressStream } = require(workerData.addon)
let reader
parentPort.on("message", async (message) => {
  if (message === "start") {
    let offset = 0
    const input = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (offset >= workerData.payload.length) return controller.close()
        controller.enqueue(new Uint8Array(workerData.payload.subarray(offset, offset + 4096)))
        offset += 4096
      }
    })
    reader = decompressStream(input, { dictSize: workerData.dictSize }).getReader()
    parentPort.postMessage("started")
    for (;;) {
      const result = await reader.read().catch(() => ({ done: true }))
      if (result.done) break
    }
  } else if (message === "cancel") {
    await reader.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, workerData.settleMs))
    parentPort.postMessage("settled")
  }
})
parentPort.postMessage("ready")
`

for (let cycle = 0; cycle < cycles; cycle++) {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { addon: require.resolve("@napi-rs/lzma/lzma2"), payload, dictSize: Number(dictSizeArg), settleMs }
  })
  await once(worker, "message")
  worker.postMessage("start")
  await once(worker, "message")
  await new Promise((resolve) => setTimeout(resolve, cycle % 8))
  worker.postMessage("cancel")
  await once(worker, "message")
  await worker.terminate()
}
console.log(`survived ${cycles} cycles`)
