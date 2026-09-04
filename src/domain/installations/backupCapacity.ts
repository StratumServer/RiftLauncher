/**
 * The two size questions a backup has to answer before anything is written.
 *
 * Both are decidable from plain numbers, so they live here rather than in the
 * compression worker: the worker supplies the totals it measured and the free
 * space it read off the disk, and this module says whether the backup can go
 * ahead and, when it cannot, in what sentence.
 *
 * The sentences are the ones the player ends up reading (#345), so they name
 * the sizes and nothing else. No paths: redactSensitiveText strips those from
 * the log anyway, and a size is the part that tells someone what to do next.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/**
 * A byte count in the largest unit that keeps it readable, e.g. "2.6 GB".
 *
 * Units step by 1024, which is what the launcher's own limits are written in
 * and what the existing "2 GB backup size limit" sentence already meant. One
 * decimal below ten so 2.6 GB does not round to 3 GB, none above it, where the
 * decimal is noise.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }

  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unit]}`
}

/**
 * The refusal for a source tree past the backup ceiling, or nothing when it fits.
 *
 * The wording keeps "is too large" because that is the fragment the renderer
 * matches on to pick its sentence (COMPRESS_FAILURE_NOTIFICATION in
 * features/installations/adapters/backupFailure.ts).
 *
 * @param totalBytes Size of the source tree, as walked.
 * @param limitBytes The ceiling it is held to.
 * @returns The message to fail with, or undefined when the source fits.
 */
export function describeOversizedBackupSource(totalBytes: number, limitBytes: number): string | undefined {
  if (!(totalBytes > limitBytes)) return undefined
  return `Compression source is too large: ${formatByteSize(totalBytes)}, over the ${formatByteSize(limitBytes)} backup limit`
}

/**
 * The refusal for a destination without room for the archive, or nothing when
 * there is room or no answer.
 *
 * gzip output is never larger than what went in, so the source total is a safe
 * upper bound on what the archive will take and no compression ratio has to be
 * guessed at.
 *
 * An unknown free-space figure is not a refusal. A filesystem that cannot
 * answer the question is not evidence of a full disk, and turning every exotic
 * mount into a blocked backup would be a worse bug than the one this check
 * exists for. `undefined` and anything that is not a real number are all
 * "could not tell", so the backup goes ahead and fails on the write if the
 * disk really was full.
 *
 * @param totalBytes Size of the source tree, the upper bound on the archive.
 * @param freeBytes Free bytes on the destination, or undefined when unknown.
 * @returns The message to fail with, or undefined when there is room or no answer.
 */
export function describeBackupSpaceShortfall(totalBytes: number, freeBytes: number | undefined): string | undefined {
  if (freeBytes === undefined || !Number.isFinite(freeBytes) || freeBytes < 0) return undefined
  if (freeBytes >= totalBytes) return undefined
  return `Not enough free space for the backup: ${formatByteSize(totalBytes - freeBytes)} more is needed`
}
