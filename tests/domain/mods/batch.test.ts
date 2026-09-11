import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { removeMods, setModsEnabled } from "../../../src/domain/mods/batch"
import type { ModBatchPorts } from "../../../src/domain/mods/batch"

const A = "/games/a/Mods/alpha-1.0.0.zip"
const B = "/games/a/Mods/beta-2.0.0.zip"
const C = "/games/a/Mods/gamma-3.0.0.zip"

function ports(overrides: Partial<ModBatchPorts>): ModBatchPorts {
  return {
    setEnabled: async (): Promise<never> => {
      throw new Error("This case does not rename anything.")
    },
    remove: async (): Promise<never> => {
      throw new Error("This case does not delete anything.")
    },
    ...overrides
  }
}

function later<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

describe("setModsEnabled", () => {
  it("renames every archive it is given and reports each one in the order given", async () => {
    // The first one lands last, so a report built in completion order comes back reversed.
    const delays: Record<string, number> = { [A]: 30, [B]: 15, [C]: 0 }
    const calls: [string, boolean][] = []
    const results = await setModsEnabled(
      ports({
        setEnabled: (path, enabled) => {
          calls.push([path, enabled])
          return later(delays[path] ?? 0, { ok: true, path: `${path}.disabled` })
        }
      }),
      [
        { path: A, enabled: false },
        { path: B, enabled: true },
        { path: C, enabled: false }
      ]
    )

    assert.deepEqual(calls, [
      [A, false],
      [B, true],
      [C, false]
    ])
    assert.deepEqual(results, [
      { path: A, ok: true },
      { path: B, ok: true },
      { path: C, ok: true }
    ])
  })

  it("keeps going after one rename throws, and reports that one as refused", async () => {
    const called: string[] = []
    const results = await setModsEnabled(
      ports({
        setEnabled: async (path) => {
          called.push(path)
          if (path === B) throw new Error("locked")
          return { ok: true, path }
        }
      }),
      [A, B, C].map((path) => ({ path, enabled: false }))
    )

    assert.deepEqual(called, [A, B, C])
    assert.deepEqual(results, [
      { path: A, ok: true },
      { path: B, ok: false, reason: "refused" },
      { path: C, ok: true }
    ])
  })

  it("reports a name clash as name-taken and an archive already in the wanted state as done", async () => {
    const answers: Record<string, SetModEnabledResult> = {
      [A]: { ok: false, reason: "name-taken" },
      [B]: { ok: false, reason: "already-in-state" },
      [C]: { ok: false, reason: "refused" }
    }
    const results = await setModsEnabled(ports({ setEnabled: async (path) => answers[path] as SetModEnabledResult }), [
      { path: A, enabled: true },
      { path: B, enabled: true },
      { path: C, enabled: true }
    ])

    assert.deepEqual(results, [
      { path: A, ok: false, reason: "name-taken" },
      { path: B, ok: true },
      { path: C, ok: false, reason: "refused" }
    ])
  })

  it("never has more than four renames in flight", async () => {
    let inFlight = 0
    let peak = 0
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))

    const paths = Array.from({ length: 10 }, (_, index) => `/games/a/Mods/mod-${index}.zip`)
    const running = setModsEnabled(
      ports({
        setEnabled: async (path) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await gate
          inFlight--
          return { ok: true, path }
        }
      }),
      paths.map((path) => ({ path, enabled: false }))
    )

    // Everything that is going to start before a slot frees up has started by now.
    await later(10, undefined)
    assert.equal(peak, 4)
    assert.equal(inFlight, 4)

    open()
    const results = await running
    assert.equal(peak, 4)
    assert.deepEqual(
      results,
      paths.map((path) => ({ path, ok: true }))
    )
  })
})

describe("removeMods", () => {
  it("counts a false answer and a throw as failures and removes the rest", async () => {
    const called: string[] = []
    const results = await removeMods(
      ports({
        remove: async (path) => {
          called.push(path)
          if (path === B) throw new Error("locked")
          return path !== A
        }
      }),
      [A, B, C]
    )

    assert.deepEqual(called, [A, B, C])
    assert.deepEqual(results, [
      { path: A, ok: false, reason: "refused" },
      { path: B, ok: false, reason: "refused" },
      { path: C, ok: true }
    ])
  })

  it("never has more than four deletes in flight", async () => {
    let inFlight = 0
    let peak = 0
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))

    const paths = Array.from({ length: 6 }, (_, index) => `/games/a/Mods/mod-${index}.zip`)
    const running = removeMods(
      ports({
        remove: async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await gate
          inFlight--
          return true
        }
      }),
      paths
    )

    await later(10, undefined)
    assert.equal(peak, 4)

    open()
    assert.equal((await running).filter((result) => result.ok).length, 6)
  })
})
