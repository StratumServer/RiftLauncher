import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "vitest"

import { createProcessSampler, parseStatCpuTicks, parseStatmResidentBytes, parseTasklistWorkingSetBytes } from "@src/ipc/adapters/processSampler"
import type { ProcessProbe, ProcessProbeOutcome, ProcessProbeRequest } from "@domain/ports"

const PAGE = 4_096

let procRoot: string

/** Writes the two files the Linux sampler reads for one pid. `comm` defaults to a name with spaces and a paren in it. */
function writeProcEntry(pid: number, options: { residentPages: number; utime?: number; stime?: number; comm?: string } = { residentPages: 0 }): void {
  const folder = join(procRoot, String(pid))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "statm"), `1000 ${options.residentPages} 200 30 0 400 0\n`, "utf-8")

  const comm = options.comm ?? "Vintagestory (mono)"
  // proc(5) field order from `state` onwards, with utime at 14 and stime at 15.
  // state, then ppid through cmajflt (proc(5) fields 4 to 13), then utime at 14 and stime at 15.
  const afterComm = ["S", "1", "1", "0", "-1", "4194304", "100", "0", "0", "0", "0", String(options.utime ?? 0), String(options.stime ?? 0), "0", "0"]
  writeFileSync(join(folder, "stat"), `${pid} (${comm}) ${afterComm.join(" ")}\n`, "utf-8")
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), "proc-sampler-"))
})

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true })
})

describe("the Linux sampler", () => {
  it("reads resident memory off a fixture proc tree", async () => {
    writeProcEntry(7, { residentPages: 512 })
    const sampler = createProcessSampler("linux", { procRoot })

    assert.deepEqual(await sampler.sample(7), { rssBytes: 512 * PAGE })
  })

  it("carries no CPU on the first reading and a share of wall time on the next", async () => {
    let clock = 1_000
    writeProcEntry(7, { residentPages: 100, utime: 0, stime: 0 })
    const sampler = createProcessSampler("linux", { procRoot, now: () => clock })

    assert.equal((await sampler.sample(7))?.cpuPercent, undefined)

    // 250 ticks of CPU (2.5 s at 100 Hz) over 5 s of wall time is half a core.
    clock = 6_000
    writeProcEntry(7, { residentPages: 100, utime: 200, stime: 50 })
    assert.equal((await sampler.sample(7))?.cpuPercent, 50)
  })

  it("answers nothing for a pid that disappears mid-run, and starts over if it comes back", async () => {
    let clock = 1_000
    writeProcEntry(7, { residentPages: 100, utime: 0, stime: 0 })
    const sampler = createProcessSampler("linux", { procRoot, now: () => clock })
    await sampler.sample(7)

    rmSync(join(procRoot, "7"), { recursive: true, force: true })
    assert.equal(await sampler.sample(7), undefined)

    // The mark for the gone pid is dropped with it, so a pid the kernel reuses cannot be handed a
    // CPU figure worked out against a process that is not the same one.
    clock = 60_000
    writeProcEntry(7, { residentPages: 100, utime: 900, stime: 0 })
    assert.equal((await sampler.sample(7))?.cpuPercent, undefined)
  })

  it("answers memory alone when the stat file is unreadable", async () => {
    mkdirSync(join(procRoot, "9"), { recursive: true })
    writeFileSync(join(procRoot, "9", "statm"), "1000 64 0 0 0 0 0\n", "utf-8")

    const sampler = createProcessSampler("linux", { procRoot })
    assert.deepEqual(await sampler.sample(9), { rssBytes: 64 * PAGE })
  })

  it("answers nothing for a statm file that holds no page count", async () => {
    mkdirSync(join(procRoot, "11"), { recursive: true })
    writeFileSync(join(procRoot, "11", "statm"), "not a page count\n", "utf-8")

    assert.equal(await createProcessSampler("linux", { procRoot }).sample(11), undefined)
  })
})

describe("reading /proc by hand", () => {
  it("counts stat fields from the last closing paren, so a name with spaces and parens still parses", () => {
    assert.equal(parseStatCpuTicks("42 (Vintage Story (x64)) S 1 1 0 -1 4194304 100 0 0 0 0 700 300 0 0"), 1_000)
  })

  it("answers nothing for a stat line with no fields after the name", () => {
    assert.equal(parseStatCpuTicks("42 (game)"), undefined)
    assert.equal(parseStatCpuTicks("42 (game) S 1 1"), undefined)
  })

  it("answers nothing for a statm file with a negative or unreadable resident count", () => {
    assert.equal(parseStatmResidentBytes("1000 -5 0"), undefined)
    assert.equal(parseStatmResidentBytes(""), undefined)
  })
})

describe("the Windows sampler", () => {
  function probeAnswering(outcome: ProcessProbeOutcome): { probe: ProcessProbe; calls: ProcessProbeRequest[] } {
    const calls: ProcessProbeRequest[] = []
    return {
      calls,
      probe: {
        run: async (request: ProcessProbeRequest): Promise<ProcessProbeOutcome> => {
          calls.push(request)
          return outcome
        }
      }
    }
  }

  it("reads the working set out of a tasklist row and asks for that pid alone", async () => {
    const { probe, calls } = probeAnswering({ ok: true, stdout: '"Vintagestory.exe","4242","Console","1","1,234,567 K"\r\n' })

    assert.deepEqual(await createProcessSampler("win32", { processProbe: probe }).sample(4242), { rssBytes: 1_234_567 * 1024 })
    assert.deepEqual(calls[0], { command: "tasklist", args: ["/FI", "PID eq 4242", "/NH", "/FO", "CSV"] })
  })

  it("reads a localized memory column with its own separators", () => {
    assert.equal(parseTasklistWorkingSetBytes('"Vintagestory.exe","1","Console","1","1 234 567 Ko"'), 1_234_567 * 1024)
  })

  it("answers nothing when tasklist found no such process", async () => {
    const { probe } = probeAnswering({ ok: true, stdout: "INFO: No tasks are running which match the specified criteria.\r\n" })
    assert.equal(await createProcessSampler("win32", { processProbe: probe }).sample(4242), undefined)
  })

  it("answers nothing when tasklist could not be run at all", async () => {
    const { probe } = probeAnswering({ ok: false, stdout: "", error: "spawn ENOENT" })
    assert.equal(await createProcessSampler("win32", { processProbe: probe }).sample(4242), undefined)
  })

  it("uses the fixed tasklist command for the Windows sampler", async () => {
    const { probe, calls } = probeAnswering({ ok: true, stdout: '"Vintagestory.exe","4242","Console","1","64 K"' })

    assert.deepEqual(await createProcessSampler("win32", { processProbe: probe }).sample(4242), { rssBytes: 64 * 1024 })
    assert.equal(calls[0]?.command, "tasklist")
  })
})

describe("a platform with no mechanism", () => {
  it("answers nothing rather than failing", async () => {
    assert.equal(await createProcessSampler("darwin").sample(1), undefined)
    assert.equal(await createProcessSampler("win32").sample(1), undefined)
  })
})
