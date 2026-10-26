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
  hold: (value: boolean) => void
  fire: () => void
}

function setup(workers: Promise<void> | null, config: Promise<void> | null): Harness {
  const state = { holdsQuit: false }
  const quit = vi.fn()
  const preventDefault = vi.fn()
  const terminateWorkers = vi.fn(() => workers)
  const flushConfigWrites = vi.fn(() => config)
  const closeGuardHoldsQuit = (): boolean => state.holdsQuit
  const handle = createBeforeQuitHandler({ terminateWorkers, flushConfigWrites, closeGuardHoldsQuit, quit })
  return {
    quit,
    preventDefault,
    terminateWorkers,
    flushConfigWrites,
    hold: (value: boolean): void => {
      state.holdsQuit = value
    },
    fire: (): void => handle({ preventDefault })
  }
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

  it("cancels nothing while a close guard is going to veto the quit (#758)", async () => {
    const t = setup(new Promise<void>(() => undefined), new Promise<void>(() => undefined))
    t.hold(true)

    t.fire()
    await flush()

    // The window's close handler vetoes this quit after this event runs (#702), so the launcher
    // keeps running: ending the worker or shutting the lanes here would leave it alive with an
    // install cancelled and every later archive call refused.
    assert.equal(t.terminateWorkers.mock.calls.length, 0)
    assert.equal(t.flushConfigWrites.mock.calls.length, 0)
    assert.equal(t.preventDefault.mock.calls.length, 0)
    assert.equal(t.quit.mock.calls.length, 0)
  })

  it("does the whole gate again on a later quit, after a held one was vetoed", async () => {
    let finishWorkers!: () => void
    const t = setup(new Promise<void>((resolve) => (finishWorkers = resolve)), null)

    t.hold(true)
    t.fire()
    await flush()
    assert.equal(t.preventDefault.mock.calls.length, 0)

    t.hold(false)
    t.fire()
    await flush()
    assert.equal(t.preventDefault.mock.calls.length, 1)
    assert.equal(t.terminateWorkers.mock.calls.length, 1)

    finishWorkers()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("re-arms once the quit it fired is over, so a vetoed quit does not skip the next flush", async () => {
    const t = setup(Promise.resolve(), Promise.resolve())
    t.fire()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
    assert.equal(t.flushConfigWrites.mock.calls.length, 1)

    t.fire()
    await flush()

    // Nothing to hold this time either, but the gate has to look again rather than stay latched.
    assert.equal(t.flushConfigWrites.mock.calls.length, 2)
    assert.equal(t.terminateWorkers.mock.calls.length, 2)
    assert.equal(t.quit.mock.calls.length, 2)
  })

  it("does not hold or flush twice when the quit it fires runs this handler again", async () => {
    let handleSecondQuit = false
    const t = setup(Promise.resolve(), Promise.resolve())
    const fireAgain = t.fire
    t.quit.mockImplementation(() => {
      if (handleSecondQuit) fireAgain()
    })

    handleSecondQuit = true
    t.fire()
    await flush()

    // The second-quit pass still ends the workers (the pool's terminateAll is idempotent), but a
    // second preventDefault would re-arm the gate against a quit that is already under way.
    assert.equal(t.terminateWorkers.mock.calls.length, 2)
    assert.equal(t.flushConfigWrites.mock.calls.length, 1)
    assert.equal(t.preventDefault.mock.calls.length, 1)
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("is wired to the pool's own terminateActiveWorkers, whose promise is what the quit waits on (#758)", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "src", "main", "index.ts"), "utf8")
    assert.match(source, /createBeforeQuitHandler\(\{\s*terminateWorkers: terminateActiveWorkers\b/)
  })

  it("holds a second quit of the user's while the first is still waiting, instead of letting it end the app under the cancel", async () => {
    let finish!: () => void
    const t = setup(new Promise<void>((resolve) => (finish = resolve)), null)
    t.fire()
    t.fire()

    assert.equal(t.preventDefault.mock.calls.length, 2)
    assert.equal(t.quit.mock.calls.length, 0)

    finish()
    await flush()
    assert.equal(t.quit.mock.calls.length, 1)
  })

  it("uses the one shared veto predicate, so the lanes and this gate always agree (#758)", () => {
    const source = readFileSync(resolve(__dirname, "..", "..", "src", "main", "index.ts"), "utf8")
    assert.match(source, /closeGuardHoldsQuit: isQuitGoingToBeVetoed\b/)
    assert.match(source, /setCloseVetoWindowProbe\(\(\) => Boolean\(mainWindow\) && !mainWindow\.isDestroyed\(\)\)/)
    for (const listener of ["handlers/pathsHandlers", "handlers/netHandlers", "workerManager"]) {
      const listenerSource = readFileSync(resolve(__dirname, "..", "..", "src", "ipc", `${listener}.ts`), "utf8")
      assert.match(listenerSource, /if \(isQuitGoingToBeVetoed\(\)\) return/, listener)
    }
  })
})
