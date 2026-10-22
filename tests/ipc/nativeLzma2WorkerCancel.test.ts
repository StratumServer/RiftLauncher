import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { NATIVE_SETTLE_MS } from "@src/ipc/workers/nativeLzma2"

const SCRIPT = join(__dirname, "../fixtures/workerCancelSettle.mjs")
const PAYLOAD = join(__dirname, "../fixtures/inno/sample-large.lzma2")
const DICT_SIZE = "8388608"
const CYCLES = "30"

/**
 * Ending a worker right after it cancelled the native LZMA2 reader must not kill the process (#758).
 *
 * @napi-rs/lzma 1.5.1 (napi 3.10.5) panics while dropping a callback reference when its thread ends
 * before the addon's own task has let go of it, and the process dies with SIGABRT (an access
 * violation on Windows). Other Node lines did not reproduce it, so only the Node 22 legs of CI can
 * fail this test; the child process turns a crash into a failed assertion instead of a dead runner.
 *
 * The test guards the production shape: the input is errored at the cancel, as the abort signal does,
 * and the fixture's pump (pulling every 16 ms) must be idle before the worker is terminated. It
 * compares NATIVE_SETTLE_MS with that pull interval, so a settle of 10 ms or less fails here. The
 * 100 ms figure itself comes from the older measurements with continuous input (see
 * NATIVE_SETTLE_MS).
 */
describe("native LZMA2 reader across a cancel and a worker teardown", () => {
  it(`survives 30 mid-stream cancels followed by the ${NATIVE_SETTLE_MS} ms settle and a worker terminate`, () => {
    const { status, signal, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, CYCLES, String(NATIVE_SETTLE_MS), PAYLOAD, DICT_SIZE], {
      encoding: "utf8",
      timeout: 120_000,
      cwd: join(__dirname, "../..")
    })

    expect({ status, signal }, stderr).toEqual({ status: 0, signal: null })
    expect(stdout).toContain("survived 30 cycles")
  }, 150_000)
})
