import { app } from "electron"
import fse from "fs-extra"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { appendSample, emptyPlaySessionsDocument, normalizePlaySessionsDocument, retainSessions, SAMPLE_INTERVAL_MS } from "@domain/sessions/sampling"
import type { ProcessSampler } from "@domain/ports"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"
import { assertManagedPath } from "@src/ipc/pathPolicy"
import { assertSafeInstallationId } from "@src/ipc/validation"

/**
 * Where a play session's series is kept, and the loop that collects one (#461).
 *
 * Not config.json: that file is written whole on every renderer change and read on startup, and a
 * few hundred samples per session on top of it is exactly the growth that turns a config save into
 * a stutter. One file per Installation, under the launcher's own user data, written through the
 * same atomic path the account store and the profiles file use.
 */

/** The launcher's own folder for these files, granted by getLauncherFolders in pathPolicy.ts. */
export const PLAY_SESSIONS_FOLDER_NAME = "Sessions"

/**
 * The largest sessions file this build will read, and so the largest it will write. Twenty
 * sessions of 720 samples come to well under a megabyte, so anything past this is not a file the
 * launcher wrote.
 */
export const MAX_PLAY_SESSIONS_FILE_BYTES = 4 * 1024 * 1024

/**
 * Consecutive readings that answer nothing before the launcher gives up on the pid.
 *
 * That is the wrapper case resolveLaunchWrapper already documents: a wrapper that forks leaves a
 * pid that dies while the game plays on. The session is recorded partial, which is what it is, and
 * never as a crash.
 */
export const MISSES_BEFORE_PARTIAL = 3

/** Where one Installation's sessions file is, or the reason there is none to touch. */
type PlaySessionsLocation = { ok: true; path: string } | { ok: false; reason: "refused" }

/**
 * Derives the sessions file from an installation id, which is checked against a fixed alphabet
 * before it is ever joined to anything, and the built path still goes through the path policy. The
 * renderer names the Installation and never the file, so neither channel can be pointed elsewhere.
 */
async function locatePlaySessions(installationId: unknown, options: { create?: boolean } = {}): Promise<PlaySessionsLocation> {
  try {
    const id = assertSafeInstallationId(installationId)
    const folder = join(app.getPath("userData"), PLAY_SESSIONS_FOLDER_NAME)
    if (options.create) await fse.ensureDir(folder)
    return { ok: true, path: await assertManagedPath(join(folder, `${id}.json`), "play sessions path", { allowMissing: true }) }
  } catch {
    return { ok: false, reason: "refused" }
  }
}

/** Reads one Installation's sessions. A missing file is no sessions; anything unreadable is refused, never overwritten. */
export async function readPlaySessions(installationId: unknown): Promise<PlaySessionsReadResult> {
  const location = await locatePlaySessions(installationId)
  if (!location.ok) return { ok: false, reason: location.reason }

  const stats = await fse.lstat(location.path).catch((err: NodeJS.ErrnoException) => err)
  if (stats instanceof Error) return stats.code === "ENOENT" ? { ok: true, sessions: [] } : { ok: false, reason: "unreadable" }
  if (!stats.isFile() || stats.size > MAX_PLAY_SESSIONS_FILE_BYTES) return { ok: false, reason: "unreadable" }

  try {
    const read = normalizePlaySessionsDocument(JSON.parse(await fse.readFile(location.path, "utf-8")))
    return read.ok ? { ok: true, sessions: read.document.sessions } : { ok: false, reason: read.problem }
  } catch {
    return { ok: false, reason: "unreadable" }
  }
}

/**
 * Adds one session to the file, dropping whatever falls past the retention cap.
 *
 * What is on disk decides whether it may be replaced at all: a file this build cannot read, or one
 * a newer build wrote, is left exactly as it is and the session is dropped instead.
 */
export async function recordPlaySession(installationId: unknown, session: PlaySession): Promise<boolean> {
  const location = await locatePlaySessions(installationId, { create: true })
  if (!location.ok) return false

  const onDisk = await readPlaySessions(installationId)
  if (!onDisk.ok) return false

  try {
    await writeJsonAtomic(location.path, retainSessions({ ...emptyPlaySessionsDocument(), sessions: onDisk.sessions }, session))
    return true
  } catch {
    return false
  }
}

/** Clears one Installation's sessions. A file that was never there is already forgotten. */
export async function forgetPlaySessions(installationId: unknown): Promise<boolean> {
  const location = await locatePlaySessions(installationId)
  if (!location.ok) return false

  try {
    await fse.remove(location.path)
    return true
  } catch {
    return false
  }
}

/** Collects one session's series while the game runs. Nothing here writes anything. */
export interface PlaySessionRecorder {
  /** Armed once, with the pid of the process that was actually spawned. */
  onStarted(pid: number): void
  /** Stops sampling and answers the session, or nothing when there was never a reading to keep. */
  finish(): Promise<PlaySession | undefined>
}

/**
 * The sampling loop: one reading as soon as the process exists, then one every interval.
 *
 * The immediate reading is the session's baseline, and it is also what makes a short session worth
 * anything at all. Readings are chained rather than overlapped, so a slow one can never leave two
 * in flight at once.
 *
 * The timer is unref'd and cleared by `finish`, which the caller runs on the same path the launch
 * outcome settles on, so it can neither outlive the handler nor hold the application open.
 */
export function createPlaySessionRecorder(sampler: ProcessSampler, options: { intervalMs?: number; now?: () => number; newId?: () => string } = {}): PlaySessionRecorder {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID

  const startedAt = now()
  let samples: PlaySample[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let misses = 0
  let partial = false
  let inFlight: Promise<void> = Promise.resolve()

  function stop(): void {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  async function take(pid: number): Promise<void> {
    // The port says it never rejects, and a sampler that breaks that promise would otherwise leave
    // `inFlight` rejected: every later reading chains off it and is skipped, and `finish` rethrows
    // into EXECUTE_GAME, so one bad reading would cost the player the launch result as well as the
    // session. A throw counts as the miss it is instead.
    const reading = await sampler.sample(pid).catch(() => undefined)
    if (!reading) {
      misses += 1
      if (misses >= MISSES_BEFORE_PARTIAL) {
        partial = true
        stop()
      }
      return
    }

    misses = 0
    samples = appendSample(samples, { t: now() - startedAt, rssBytes: reading.rssBytes, ...(reading.cpuPercent === undefined ? {} : { cpuPercent: reading.cpuPercent }) })
  }

  function track(pid: number): void {
    inFlight = inFlight.then(() => take(pid))
  }

  return {
    onStarted: (pid: number): void => {
      if (timer !== undefined) return
      track(pid)
      timer = setInterval(() => track(pid), intervalMs)
      timer.unref?.()
    },
    finish: async (): Promise<PlaySession | undefined> => {
      stop()
      await inFlight
      if (samples.length === 0) return undefined
      return { id: newId(), startedAt, endedAt: now(), intervalMs, partial, samples }
    }
  }
}
