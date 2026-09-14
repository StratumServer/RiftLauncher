import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { createOptimumOutputReader, type OptimumRunResult } from "@domain/optimum/ndjson"

/** Feeds a whole stream in one go and reports what the reader made of it. */
function read(lines: string[], onProgress?: (progress: number) => void): OptimumRunResult {
  const reader = createOptimumOutputReader(onProgress)
  reader.push(lines.join("\n"))
  return reader.finish()
}

const OK = '{"type":"result","ok":true,"runtimePath":"/home/player/versions/1.22.7"}'

describe("createOptimumOutputReader", () => {
  it("reads a clean run and reports every forward tick", () => {
    const progress: number[] = []

    const result = read(
      [
        '{"type":"progress","phase":"patch","progress":10,"detail":"/home/player/versions/1.22.7/VintagestoryLib.dll"}',
        '{"type":"progress","phase":"patch","progress":90,"detail":"x"}',
        '{"type":"progress","phase":"verify","progress":99,"detail":"x"}',
        OK,
        ""
      ],
      (value) => progress.push(value)
    )

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(progress, [10, 90, 99])
  })

  it("drops log lines and anything it cannot read", () => {
    const progress: number[] = []

    const result = read(
      ['{"type":"log","level":"info","message":"Copying /home/player/.optimum/vanilla"}', "not json at all", "[]", "7", '{"type":"progress","phase":"patch","progress":40}', '{"type":"unknown"}', OK],
      (value) => progress.push(value)
    )

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(progress, [40])
  })

  it("holds a partial line until the rest of it arrives", () => {
    const progress: number[] = []
    const reader = createOptimumOutputReader((value) => progress.push(value))

    reader.push('{"type":"progress","phase":"pat')
    assert.deepEqual(progress, [])
    reader.push('ch","progress":65}\n')
    assert.deepEqual(progress, [65])
    reader.push(OK)

    assert.deepEqual(reader.finish(), { ok: true })
  })

  it("reports no-result when the process said nothing terminal", () => {
    assert.deepEqual(read(['{"type":"progress","phase":"patch","progress":10}', '{"type":"log","level":"warn","message":"x"}']), { ok: false, reason: "no-result" })
  })

  it("reports no-result when the last line was cut off mid-object", () => {
    assert.deepEqual(read(['{"type":"result","ok":tr']), { ok: false, reason: "no-result" })
  })

  it("keeps the first terminal result and ignores a second one", () => {
    assert.deepEqual(read(['{"type":"result","ok":false,"reason":"patch-conflict","message":"/home/player/x.dll"}', OK]), { ok: false, reason: "patch-conflict" })
    assert.deepEqual(read([OK, '{"type":"result","ok":false,"reason":"cancelled"}']), { ok: true })
  })

  for (const reason of [
    "bad-input",
    "unsupported-version",
    "patch-conflict",
    "decompile-failed",
    "assemble-failed",
    "verification-failed",
    "output-exists",
    "source-unavailable",
    "cancelled",
    "engine-internal"
  ] as const) {
    it(`carries the wire reason ${reason} through`, () => {
      assert.deepEqual(read([`{"type":"result","ok":false,"reason":"${reason}"}`]), { ok: false, reason })
    })
  }

  for (const [label, reason] of [
    ["a token outside the closed set", '"something-new"'],
    ["a token the launcher owns rather than the CLI", '"timed-out"'],
    ["a missing reason", "null"],
    ["a reason that is not a string", "7"]
  ] as const) {
    it(`reads ${label} as engine-internal`, () => {
      assert.deepEqual(read([`{"type":"result","ok":false,"reason":${reason}}`]), { ok: false, reason: "engine-internal" })
    })
  }

  it("never reports progress going backwards, and never reaches 100", () => {
    const progress: number[] = []

    read(
      [
        '{"type":"progress","phase":"patch","progress":80}',
        '{"type":"progress","phase":"patch","progress":40}',
        '{"type":"progress","phase":"patch","progress":80}',
        '{"type":"progress","phase":"verify","progress":140}',
        '{"type":"progress","phase":"verify","progress":-5}',
        OK
      ],
      (value) => progress.push(value)
    )

    assert.deepEqual(progress, [80, 99])
  })

  it("drops an unterminated line past the buffer ceiling and recovers on the next newline", () => {
    const progress: number[] = []
    const reader = createOptimumOutputReader((value) => progress.push(value))

    reader.push("x".repeat(70_000))
    reader.push(`}\n${OK}\n`)

    assert.deepEqual(reader.finish(), { ok: true })
    assert.deepEqual(progress, [])
  })

  it("never hands the caller anything the child process wrote", () => {
    const result = read(['{"type":"result","ok":false,"reason":"patch-conflict","message":"/home/player/versions/1.22.7","detail":"secret"}'])

    assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"])
  })
})
