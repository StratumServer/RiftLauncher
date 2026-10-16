import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = join(__dirname, "../fixtures/workerAddonUnload.mjs")
const PAYLOAD = join(__dirname, "../fixtures/inno/sample-large.lzma2")
const DICT_SIZE = "8388608"
const CYCLES = "100"

function run(mode: "pin" | "nopin"): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, CYCLES, mode, PAYLOAD, DICT_SIZE], {
    encoding: "utf8",
    timeout: 120_000,
    cwd: join(__dirname, "../..")
  })
  return { status, stdout, stderr }
}

/**
 * Ending a worker that loaded @napi-rs/lzma must not kill the process.
 *
 * The launcher terminates its RUN_INSTALLER worker right after an extraction. With
 * @napi-rs/lzma 1.5.1 (napi 3.10.5), Windows unloads the DLL while the addon's tokio
 * threads still run in it and the process dies with 0xC0000005
 * (napi-rs/napi-rs#3443). Loading the addon on the main thread keeps it mapped. Linux
 * never unloads the library, so only the Windows legs of CI can fail this test; the
 * child process turns a crash into a failed assertion instead of a dead runner.
 */
describe("native LZMA2 addon across worker teardown", () => {
  it("survives 100 worker load, decode and terminate cycles when the main thread holds the addon", () => {
    const { status, stdout, stderr } = run("pin")

    expect(status, stderr).toBe(0)
    expect(stdout).toContain("survived 100 cycles")
  }, 150_000)

  // Detector for the upstream bug itself: it should crash within 100 cycles on Windows
  // (20 of 20 runs upstream, about 1 in 4 per install in the field). Remove it once an
  // @napi-rs/lzma built with napi 3.12.1 or later ships, since it would then fail by passing.
  it.skipIf(process.platform !== "win32")(
    "crashes without the main-thread load, which is why the launcher keeps one",
    () => {
      const { status } = run("nopin")

      expect(status).not.toBe(0)
    },
    150_000
  )
})
