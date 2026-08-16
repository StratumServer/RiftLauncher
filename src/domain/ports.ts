/**
 * Ports the domain layer talks through.
 *
 * Implementations live outside `src/domain`: the renderer wires them over the
 * preload API, the main process can wire them straight onto Node. Nothing in
 * this folder may reach for Electron, Node, React or the DOM.
 */

/** Storage the host exposes to the domain. */
export interface FileSystem {
  /** Resolves true when `path` points at something that exists. */
  exists(path: string): Promise<boolean>
  /** Deletes `path`. Resolves false when the deletion did not happen. */
  remove(path: string): Promise<boolean>
  /**
   * Renames `from` to `to`. Resolves false when the move did not happen, which
   * includes the host refusing to overwrite an existing `to`.
   */
  move(from: string, to: string): Promise<boolean>
}

/** Everything the host needs to produce one archive. */
export interface CompressRequest {
  /** File or folder to compress. */
  sourcePath: string
  /** Folder the archive is written into. */
  outputFolder: string
  /** Archive file name, extension included. */
  fileName: string
  /** Host specific compression level, passed through untouched. */
  compressionLevel?: number
}

/** How a compression attempt ended. */
export interface CompressOutcome {
  ok: boolean
  error?: string
}

/** Produces archives. Progress reporting and task UI stay on the host side. */
export interface Archiver {
  /**
   * Compresses `request` and reports the result through `onComplete`, which the
   * host calls once before the returned promise settles. The callback shape
   * mirrors the renderer task flow: it never rejects, it signals failure through
   * its completion callback.
   */
  compress(request: CompressRequest, onComplete: (outcome: CompressOutcome) => void): Promise<void>
}

/** Everything the host needs to unpack one archive. */
export interface ExtractRequest {
  /** Archive to unpack. */
  archivePath: string
  /** Folder the contents are written into. The host creates it when missing. */
  outputFolder: string
}

/** How an extraction attempt ended. */
export interface ExtractOutcome {
  ok: boolean
  error?: string
}

/**
 * Unpacks archives. Kept apart from {@link Archiver} because no service does
 * both: a backup only ever compresses, a restore only ever extracts.
 */
export interface Extractor {
  /**
   * Unpacks `request` and reports the result through `onComplete`, which the
   * host calls once before the returned promise settles. Like the archiver it
   * never rejects, it signals failure through its completion callback.
   */
  extract(request: ExtractRequest, onComplete: (outcome: ExtractOutcome) => void): Promise<void>
}

/** Everything the host needs to fetch one file. */
export interface DownloadRequest {
  /** Where the file is fetched from. */
  url: string
  /** Folder the file is written into. The host creates it when missing. */
  outputFolder: string
  /** Name the downloaded file is saved under, extension included. The host adds nothing to it. */
  fileName: string
}

/** How a download attempt ended. */
export interface DownloadOutcome {
  ok: boolean
  /** Where the file landed. Only meaningful when `ok` is true. */
  filePath?: string
  error?: string
}

/** Fetches files. Progress reporting and task UI stay on the host side. */
export interface Downloader {
  /**
   * Downloads `request` and reports the result through `onComplete`, which the
   * host calls once before the returned promise settles. Like the archiver it
   * never rejects, it signals failure through its completion callback.
   */
  download(request: DownloadRequest, onComplete: (outcome: DownloadOutcome) => void): Promise<void>
}

/** Everything the host needs to turn one downloaded file into a game folder. */
export interface UnpackRequest {
  /** The downloaded archive or installer. */
  sourcePath: string
  /** Folder the game ends up in. The host creates it when missing. */
  outputFolder: string
}

/** How an unpacking attempt ended. */
export interface UnpackOutcome {
  ok: boolean
  error?: string
}

/**
 * The two ways a downloaded game build becomes an installed folder.
 *
 * Both live on one port because one service picks between them: which mechanism
 * a platform needs is a domain decision, running it is not. {@link Extractor}
 * stays separate because a restore only ever unpacks a backup archive and never
 * runs an installer.
 */
export interface Unpacker {
  /** Unpacks a portable archive. Consumes the source file. */
  extractArchive(request: UnpackRequest, onComplete: (outcome: UnpackOutcome) => void): Promise<void>
  /** Runs a platform installer against the output folder. Consumes the source file. */
  runInstaller(request: UnpackRequest, onComplete: (outcome: UnpackOutcome) => void): Promise<void>
}

/**
 * Lists what sits directly inside a folder.
 *
 * Kept apart from {@link FileSystem} because listing is a main process
 * capability today: the preload surface the renderer wires {@link FileSystem}
 * onto has no equivalent, so widening that port would leave the renderer
 * adapter with a member it cannot honour.
 */
export interface DirectoryReader {
  /**
   * Entry names directly inside `path`, without their folder. Resolves empty
   * when `path` is not a readable folder, so a service never has to ask whether
   * a folder exists before listing it.
   *
   * The host is free to drop entries it will not let the domain touch, symlinks
   * and unsafe names among them: what comes back is what may be opened.
   */
  listFileNames(path: string): Promise<string[]>
}

/** What one mod archive gave up. */
export interface ModArchiveContent {
  /** Text of the archive's `modinfo.json`, absent when it carries none. */
  modinfo?: string
  /** Bytes of the archive's mod icon, absent when it carries none. */
  icon?: Uint8Array
}

/**
 * Why an archive gave up nothing usable.
 *
 * The two size problems are the host's call: how many bytes are too many is a
 * reading policy, not a domain rule, but the domain still has to name the
 * outcome to report it.
 */
export type ModArchiveProblem = "unreadable-archive" | "modinfo-too-large" | "icon-too-large"

export type ModArchiveResult = { ok: true; content: ModArchiveContent } | { ok: false; problem: ModArchiveProblem }

/**
 * Pulls the two entries the launcher cares about out of one mod archive.
 *
 * The whole read happens inside a single call: the host opens the archive,
 * takes what it needs and closes it before resolving. That is deliberate. The
 * archive handle never escapes the adapter, so no caller can hold one open by
 * forgetting to close it, and a service can count how many archives are being
 * read at once by counting calls in flight.
 */
export interface ModArchiveReader {
  /** Never rejects: an archive that cannot be read resolves to a problem. */
  read(archivePath: string): Promise<ModArchiveResult>
}

/** Keeps mod icons somewhere the UI can load them from, and names them. */
export interface IconStore {
  /**
   * Stores `bytes` and resolves the name the icon can be found under, or
   * undefined when it could not be stored. A missing icon never costs a mod its
   * place in the list, so this never rejects.
   */
  store(bytes: Uint8Array): Promise<string | undefined>
}

/** Wall clock, so services never read the ambient time. */
export interface Clock {
  now(): number
}

/** Unique identifiers, so services never generate their own randomness. */
export interface IdGenerator {
  newId(): string
}

/** Joins path segments with the host platform separator. */
export interface PathBuilder {
  /** Asynchronous because the renderer crosses IPC to reach the real platform. */
  join(parts: string[]): Promise<string>
}

/** One command to run and read the stdout of. */
export interface ProcessProbeRequest {
  /** Executable to run, already resolved to a real path or a name the host can find on its own. */
  command: string
  /** Arguments passed to the command, in order. */
  args: string[]
}

/** How a probed process ended. */
export interface ProcessProbeOutcome {
  /** True when the process was spawned and produced an outcome, timeout included. */
  ok: boolean
  /** Everything the process wrote to stdout. Empty when nothing was captured. */
  stdout: string
  error?: string
}

/**
 * Runs a short-lived command and hands back what it printed, so the domain
 * can read the answer without any part of the domain touching child_process.
 */
export interface ProcessProbe {
  /**
   * Spawns `request` and resolves once it closes, never rejecting: a spawn
   * failure is reported through `ok: false` instead. The host is expected to
   * bound how long it waits, since the command being probed is a game binary
   * that answers to nothing forcing it to exit.
   */
  run(request: ProcessProbeRequest): Promise<ProcessProbeOutcome>
}

/** Releases a close guard acquired earlier. Safe to call once. */
export type ReleaseCloseGuard = () => void

/** Keeps the application from quitting while work is in flight. */
export interface CloseGuard {
  acquire(reason: string): ReleaseCloseGuard
}
