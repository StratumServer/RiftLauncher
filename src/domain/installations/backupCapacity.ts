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
const TAR_BLOCK_BYTES = 512
const TAR_BLOCKS_PER_ENTRY = 4
const TAR_END_BLOCKS = 2
const GZIP_HEADROOM_RATIO = 0.01

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
 * A conservative upper bound for a gzipped tar backup.
 *
 * The tar allowance covers each entry's header, block padding and room for
 * portable metadata. The gzip allowance covers incompressible data and stream
 * framing, so the free-space check never assumes compression saves bytes.
 */
export function estimateBackupArchiveBytes(sourceBytes: number, entryCount: number): number {
  const tarBytes = sourceBytes + entryCount * TAR_BLOCK_BYTES * TAR_BLOCKS_PER_ENTRY + TAR_END_BLOCKS * TAR_BLOCK_BYTES
  return tarBytes + Math.ceil(tarBytes * GZIP_HEADROOM_RATIO)
}

/**
 * The refusal for a destination without room for the archive, or nothing when
 * there is room or no answer.
 *
 * The caller supplies a conservative archive estimate that includes tar
 * headers/padding, portable metadata and gzip headroom.
 *
 * An unknown free-space figure is not a refusal. A filesystem that cannot
 * answer the question is not evidence of a full disk, and turning every exotic
 * mount into a blocked backup would be a worse bug than the one this check
 * exists for. `undefined` and anything that is not a real number are all
 * "could not tell", so the backup goes ahead and fails on the write if the
 * disk really was full.
 *
 * @param requiredBytes Conservative size estimate for the archive.
 * @param freeBytes Free bytes on the destination, or undefined when unknown.
 * @returns The message to fail with, or undefined when there is room or no answer.
 */
export function describeBackupSpaceShortfall(requiredBytes: number, freeBytes: number | undefined): string | undefined {
  if (freeBytes === undefined || !Number.isFinite(freeBytes) || freeBytes < 0) return undefined
  if (freeBytes >= requiredBytes) return undefined
  return `Not enough free space for the backup: ${formatByteSize(requiredBytes - freeBytes)} more is needed`
}
