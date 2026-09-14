import fse from "fs-extra"

import type { ProcessProbe, ProcessReading, ProcessSampler } from "@domain/ports"

/**
 * Reads memory and CPU off a running game process, once per call (#461).
 *
 * Linux reads `/proc`, which costs two small file reads and no process at all. Windows goes
 * through `tasklist`, which is a spawn but a cheap one. Everything else, macOS included, answers
 * nothing: the feature is simply absent there rather than an error a player has to dismiss.
 */

/**
 * Bytes per page, for turning `/proc/<pid>/statm`'s page counts into bytes.
 *
 * ponytail: hard-coded 4 KiB, which is what x86-64 and the usual arm64 kernels use. A kernel built
 * with 16 KiB or 64 KiB pages under-reports by that factor. Node exposes no `getpagesize`, so the
 * upgrade path is reading it out of `getconf PAGESIZE` once at startup, which costs a spawn to fix
 * a number that is wrong on almost no desktop.
 */
const PAGE_SIZE_BYTES = 4_096

/** Kernel clock ticks per second (USER_HZ), which `/proc/<pid>/stat` counts CPU time in. */
const CLOCK_TICKS_PER_SECOND = 100

/** `/proc/<pid>/stat` fields, one-indexed as proc(5) numbers them, counted after the comm field. */
const UTIME_FIELD = 14
const STIME_FIELD = 15

/** What was read last for one pid, so the next reading can turn CPU time into a share of wall time. */
interface CpuMark {
  ticks: number
  at: number
}

/** Resident bytes out of `/proc/<pid>/statm`, whose second field is the resident page count. */
export function parseStatmResidentBytes(statm: string): number | undefined {
  const resident = Number(statm.trim().split(/\s+/)[1])
  return Number.isFinite(resident) && resident >= 0 ? resident * PAGE_SIZE_BYTES : undefined
}

/**
 * Total CPU ticks (user plus system) out of `/proc/<pid>/stat`.
 *
 * The second field is the executable name in parentheses and may itself hold spaces and
 * parentheses, so the fields are counted from the last `)` rather than by splitting the whole line.
 */
export function parseStatCpuTicks(stat: string): number | undefined {
  const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim()
  if (!afterComm) return undefined

  // The first field after comm is `state`, which proc(5) numbers 3, so field N sits at index N - 3.
  const fields = afterComm.split(/\s+/)
  const utime = Number(fields[UTIME_FIELD - 3])
  const stime = Number(fields[STIME_FIELD - 3])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined
  return utime + stime
}

/**
 * The working set out of one `tasklist /NH /FO CSV` row, in bytes.
 *
 * The memory column is a localized string ("1 234 567 K", "1,234,567 K", "1.234.567 Ko"), so every
 * non-digit is dropped rather than any one separator being guessed at. The unit is kilobytes on
 * every locale Windows ships.
 */
export function parseTasklistWorkingSetBytes(csv: string): number | undefined {
  const row = csv.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (!row) return undefined

  const columns = row.split('","')
  const memory = columns[4]?.replace(/\D/g, "")
  if (!memory) return undefined

  const kilobytes = Number(memory)
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined
}

/** Reads a `/proc` file, answering undefined for a pid that has gone or a file that will not open. */
async function readProcFile(path: string): Promise<string | undefined> {
  try {
    return await fse.readFile(path, "utf-8")
  } catch {
    return undefined
  }
}

function createLinuxSampler(procRoot: string, now: () => number): ProcessSampler {
  const marks = new Map<number, CpuMark>()

  return {
    sample: async (pid: number): Promise<ProcessReading | undefined> => {
      const statm = await readProcFile(`${procRoot}/${pid}/statm`)
      if (statm === undefined) {
        marks.delete(pid)
        return undefined
      }

      const rssBytes = parseStatmResidentBytes(statm)
      if (rssBytes === undefined) return undefined

      const stat = await readProcFile(`${procRoot}/${pid}/stat`)
      const ticks = stat === undefined ? undefined : parseStatCpuTicks(stat)
      if (ticks === undefined) return { rssBytes }

      const at = now()
      const previous = marks.get(pid)
      marks.set(pid, { ticks, at })
      // The first reading of a session has nothing to subtract from, so it carries memory only.
      if (!previous || at <= previous.at) return { rssBytes }

      const cpuPercent = ((ticks - previous.ticks) / CLOCK_TICKS_PER_SECOND / ((at - previous.at) / 1_000)) * 100
      return cpuPercent >= 0 ? { rssBytes, cpuPercent } : { rssBytes }
    }
  }
}

/**
 * ponytail: `tasklist` with no CPU column, so a Windows session records memory alone.
 *
 * It is in System32 on every Windows the launcher supports and answers in milliseconds, which
 * `Get-Process` does not: starting PowerShell every five seconds to read one number would cost
 * more than the measurement is worth. The upgrade path, if CPU is ever wanted there, is
 * `GetProcessTimes` through a native binding, which is a dependency this feature does not justify
 * on its own.
 */
function createWindowsSampler(processProbe: ProcessProbe): ProcessSampler {
  return {
    sample: async (pid: number): Promise<ProcessReading | undefined> => {
      const probed = await processProbe.run({ command: "tasklist", args: ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"] })
      if (!probed.ok) return undefined

      const rssBytes = parseTasklistWorkingSetBytes(probed.stdout)
      return rssBytes === undefined ? undefined : { rssBytes }
    }
  }
}

/** A sampler that never answers, for a platform with no mechanism the launcher can use. */
const ABSENT_SAMPLER: ProcessSampler = { sample: async (): Promise<undefined> => undefined }

/**
 * The sampler for one host.
 *
 * @param options.procRoot Where `/proc` is mounted. A parameter so a test can point it at a fixture
 *   tree instead of the running kernel's.
 */
export function createProcessSampler(platform: NodeJS.Platform, options: { procRoot?: string; processProbe?: ProcessProbe; now?: () => number } = {}): ProcessSampler {
  if (platform === "linux") return createLinuxSampler(options.procRoot ?? "/proc", options.now ?? Date.now)
  if (platform === "win32") return options.processProbe ? createWindowsSampler(options.processProbe) : ABSENT_SAMPLER
  return ABSENT_SAMPLER
}
