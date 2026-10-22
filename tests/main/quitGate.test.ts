import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, vi } from "vitest"

import { createBeforeQuitHandler } from "@src/main/quitGate"

interface Harness {
  quit: ReturnType<typeof vi.fn>
  preventDefault: ReturnType<typeof vi.fn>
  terminateWorkers: ReturnType<typeof vi.fn>
  flushConfigWrites: ReturnType<typeof vi.fn>
  fire: () => void
}

function setup(workers: Promise<void> | null, config: Promise<void> | null): Harness {
  const quit = vi.fn()
  const preventDefault = vi.fn()
  const terminateWorkers = vi.fn(() => workers)
  const flushConfigWrites = vi.fn(() => config)
  const handle = createBeforeQuitHandler({ terminateWorkers, flushConfigWrites, quit })
  return { quit, preventDefault, terminateWorkers, flushConfigWrites, fire: (): void => handle({ preventDefault }) }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("before-quit gate", () => {
  it("lets the quit through untouched when no worker and no config write is pending", async () => {
    const t = setup(null, null)
    t.fire()
    await flush()
    assert.equal(t.preventDefault.mock.calls.length, 0)
    assert.equal(t.quit.mock.calls.length, 0)
  })

  it("holds the quit while a cancellable worker is ending and quits again only once it settled", async () => {
    let finish!: () => void
    const t = setup(new Promise<void>((resolve) => (finish = resolve)), null)
    t.fire()
    await flush()
    assert.equal(t.preventDefault.mock.calls.length, 1)
    assert.equal(t.quit.mock.calls.length, 0)

    finish()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("holds the quit for a pending config write alone", async () => {
    let finish!: () => void
    const t = setup(null, new Promise<void>((resolve) => (finish = resolve)))
    t.fire()
    assert.equal(t.preventDefault.mock.calls.length, 1)
    finish()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("waits for the slower of the worker and the config write", async () => {
    let finishWorkers!: () => void
    const t = setup(new Promise<void>((resolve) => (finishWorkers = resolve)), Promise.resolve())
    t.fire()
    await flush()
    assert.equal(t.quit.mock.calls.length, 0)
    finishWorkers()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("still quits when the worker wait rejects", async () => {
    const t = setup(Promise.reject(new Error("terminate failed")), null)
    t.fire()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("asks the workers to end on the second quit as well, but does not hold or flush again", async () => {
    const t = setup(Promise.resolve(), Promise.resolve())
    t.fire()
    await flush()
    t.fire()
    assert.equal(t.terminateWorkers.mock.calls.length, 2)
    assert.equal(t.flushConfigWrites.mock.calls.length, 1)
    assert.equal(t.preventDefault.mock.calls.length, 1)
  })

  it("is wired to the pool's own terminateActiveWorkers, whose promise is what the quit waits on (#758)", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "src", "main", "index.ts"), "utf8")
    assert.match(source, /createBeforeQuitHandler\(\{\s*terminateWorkers: terminateActiveWorkers\b/)
  })
})
