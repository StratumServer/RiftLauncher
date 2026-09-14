import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

import "./helpers/electronMock"
import { setElectronPath, setElectronUserDataPath } from "./helpers/electronMock"

import { CURRENT_CONFIG_SCHEMA } from "@domain/config/migrations"
import { MAX_SESSIONS_PER_INSTALLATION, PLAY_SESSIONS_FORMAT, SAMPLE_INTERVAL_MS } from "@domain/sessions/sampling"
import type { ProcessReading, ProcessSampler } from "@domain/ports"

const MIB = 1024 * 1024

let temporaryRoot: string
let userDataFolder: string
let sessionsFolder: string

type Store = typeof import("@src/ipc/playSessionsStore")

async function store(): Promise<Store> {
  return import("@src/ipc/playSessionsStore")
}

function session(overrides: Partial<PlaySession> = {}): PlaySession {
  return { id: "abc-1", startedAt: 1_000, endedAt: 2_000, intervalMs: SAMPLE_INTERVAL_MS, partial: false, samples: [{ t: 0, rssBytes: 100 * MIB }], ...overrides }
}

function writeConfig(): void {
  writeFileSync(
    join(userDataFolder, "config.json"),
    JSON.stringify({
      schemaVersion: CURRENT_CONFIG_SCHEMA,
      defaultInstallationsFolder: join(temporaryRoot, "Installations"),
      defaultVersionsFolder: join(temporaryRoot, "Versions"),
      backupsFolder: join(temporaryRoot, "Backups"),
      accounts: [],
      installations: [],
      gameVersions: [],
      favMods: [],
      customIcons: []
    }),
    "utf-8"
  )
}

beforeEach(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "play-sessions-"))
  userDataFolder = join(temporaryRoot, "userData")
  sessionsFolder = join(userDataFolder, "Sessions")
  mkdirSync(userDataFolder, { recursive: true })

  setElectronUserDataPath(userDataFolder)
  setElectronPath("appData", join(temporaryRoot, "appData"))
  setElectronPath("home", temporaryRoot)
  setElectronPath("appRoot", join(temporaryRoot, "app"))
  writeConfig()

  vi.resetModules()
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("the play sessions store", () => {
  it("reads a file that is not there as no sessions", async () => {
    assert.deepEqual(await (await store()).readPlaySessions("main"), { ok: true, sessions: [] })
  })

  it("round-trips a session through the file", async () => {
    const { recordPlaySession, readPlaySessions } = await store()

    assert.equal(await recordPlaySession("main", session()), true)
    assert.deepEqual(await readPlaySessions("main"), { ok: true, sessions: [session()] })
    assert.deepEqual(JSON.parse(readFileSync(join(sessionsFolder, "main.json"), "utf-8")).format, PLAY_SESSIONS_FORMAT)
  })

  it("keeps the newest first and drops the oldest past the cap", async () => {
    const { recordPlaySession, readPlaySessions } = await store()

    for (let index = 0; index <= MAX_SESSIONS_PER_INSTALLATION; index++) await recordPlaySession("main", session({ id: `s-${index}` }))

    const read = await readPlaySessions("main")
    assert.equal(read.ok && read.sessions.length, MAX_SESSIONS_PER_INSTALLATION)
    assert.equal(read.ok && read.sessions[0]?.id, `s-${MAX_SESSIONS_PER_INSTALLATION}`)
    assert.equal(read.ok && read.sessions.some((kept) => kept.id === "s-0"), false)
  })

  it("refuses a file a newer build wrote and never overwrites it", async () => {
    const { recordPlaySession, readPlaySessions } = await store()
    mkdirSync(sessionsFolder, { recursive: true })
    const newer = JSON.stringify({ format: PLAY_SESSIONS_FORMAT + 1, sessions: [] })
    writeFileSync(join(sessionsFolder, "main.json"), newer, "utf-8")

    assert.deepEqual(await readPlaySessions("main"), { ok: false, reason: "newer-format" })
    assert.equal(await recordPlaySession("main", session()), false)
    assert.equal(readFileSync(join(sessionsFolder, "main.json"), "utf-8"), newer)
  })

  it("refuses a file that holds no readable document", async () => {
    mkdirSync(sessionsFolder, { recursive: true })
    writeFileSync(join(sessionsFolder, "main.json"), "not json", "utf-8")

    assert.deepEqual(await (await store()).readPlaySessions("main"), { ok: false, reason: "unreadable" })
  })

  it("refuses an installation id that is not one the config could have written", async () => {
    const { readPlaySessions, recordPlaySession, forgetPlaySessions } = await store()

    for (const id of ["../escape", "main/../..", "", "a".repeat(65), 42, null]) {
      assert.deepEqual(await readPlaySessions(id), { ok: false, reason: "refused" }, `${String(id)} was not refused`)
      assert.equal(await recordPlaySession(id, session()), false, `${String(id)} was not refused`)
      assert.equal(await forgetPlaySessions(id), false, `${String(id)} was not refused`)
    }
  })

  it("forgets a file, and answers ok for one that was never there", async () => {
    const { recordPlaySession, readPlaySessions, forgetPlaySessions } = await store()
    await recordPlaySession("main", session())

    assert.equal(await forgetPlaySessions("main"), true)
    assert.deepEqual(await readPlaySessions("main"), { ok: true, sessions: [] })
    assert.equal(await forgetPlaySessions("main"), true)
  })
})

describe("the play session recorder", () => {
  /** A sampler answering `readings` in order, then nothing for good. */
  function samplerAnswering(readings: readonly (ProcessReading | undefined)[]): { sampler: ProcessSampler; pids: number[] } {
    const pids: number[] = []
    let index = 0
    return {
      pids,
      sampler: {
        sample: async (pid: number): Promise<ProcessReading | undefined> => {
          pids.push(pid)
          return readings[index++]
        }
      }
    }
  }

  it("takes a reading as soon as the process exists, then one every interval", async () => {
    vi.useFakeTimers()
    const { createPlaySessionRecorder } = await store()
    const { sampler, pids } = samplerAnswering([{ rssBytes: MIB }, { rssBytes: 2 * MIB }, { rssBytes: 3 * MIB }])

    const recorder = createPlaySessionRecorder(sampler, { intervalMs: 1_000, newId: () => "fixed" })
    recorder.onStarted(4242)
    await vi.advanceTimersByTimeAsync(2_000)

    const recorded = await recorder.finish()
    assert.deepEqual(
      recorded?.samples.map((sample) => sample.rssBytes),
      [MIB, 2 * MIB, 3 * MIB]
    )
    assert.deepEqual(pids, [4242, 4242, 4242])
    assert.equal(recorded?.partial, false)
    assert.equal(recorded?.id, "fixed")
  })

  it("gives up on a pid after three readings in a row answer nothing, and calls that session partial", async () => {
    vi.useFakeTimers()
    const { createPlaySessionRecorder } = await store()
    const { sampler, pids } = samplerAnswering([{ rssBytes: MIB }, undefined, { rssBytes: 2 * MIB }, undefined, undefined, undefined])

    const recorder = createPlaySessionRecorder(sampler, { intervalMs: 1_000 })
    recorder.onStarted(7)
    await vi.advanceTimersByTimeAsync(10_000)

    const recorded = await recorder.finish()
    assert.equal(recorded?.partial, true)
    // One immediate reading plus five ticks, then the timer is gone: a tenth tick reads nothing.
    assert.equal(pids.length, 6)
    assert.deepEqual(
      recorded?.samples.map((sample) => sample.rssBytes),
      [MIB, 2 * MIB]
    )
  })

  it("leaves no timer behind once the session is finished", async () => {
    vi.useFakeTimers()
    const { createPlaySessionRecorder } = await store()
    const { sampler } = samplerAnswering([{ rssBytes: MIB }, { rssBytes: MIB }])

    const recorder = createPlaySessionRecorder(sampler, { intervalMs: 1_000 })
    recorder.onStarted(7)
    await vi.advanceTimersByTimeAsync(1_000)
    assert.equal(vi.getTimerCount(), 1)

    await recorder.finish()
    assert.equal(vi.getTimerCount(), 0)
  })

  it("answers nothing for a session it never got a reading out of", async () => {
    const { createPlaySessionRecorder } = await store()
    const { sampler } = samplerAnswering([undefined])

    const recorder = createPlaySessionRecorder(sampler, { intervalMs: 60_000 })
    recorder.onStarted(7)
    assert.equal(await recorder.finish(), undefined)
  })

  it("arms once, whatever a second start says", async () => {
    vi.useFakeTimers()
    const { createPlaySessionRecorder } = await store()
    const { sampler, pids } = samplerAnswering([{ rssBytes: MIB }, { rssBytes: MIB }, { rssBytes: MIB }])

    const recorder = createPlaySessionRecorder(sampler, { intervalMs: 1_000 })
    recorder.onStarted(7)
    recorder.onStarted(9)
    await vi.advanceTimersByTimeAsync(1_000)
    await recorder.finish()

    assert.equal(pids.includes(9), false)
    assert.equal(vi.getTimerCount(), 0)
  })
})
