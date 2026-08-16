/**
 * What reading an installer needs from the host.
 *
 * Kept in this folder rather than in `src/domain/ports.ts` because nothing
 * outside the Inno reader speaks these three: they exist so the reader can open
 * bytes, hash bytes and write files without any part of it touching Node.
 */

/** Random access over the downloaded installer. */
export interface InnoInstallerFile {
  /** Total size in bytes. */
  readonly size: number
  /**
   * Reads at most `length` bytes at `offset`. Resolves fewer only at the end of
   * the file, and the returned buffer belongs to the caller.
   */
  read(offset: number, length: number): Promise<Uint8Array>
}

/** SHA-256, which every file in an installer carries and every file is checked against. */
export interface InnoDigest {
  hash(bytes: Uint8Array): Uint8Array
}

/** Where extracted files land. */
export interface InnoExtractionSink {
  /**
   * Writes one file, creating parent folders as needed.
   *
   * `relativePath` is always a forward slash path that has already been checked
   * against escaping the destination, so a sink joins it to its root without
   * having to re-derive that rule.
   */
  writeFile(relativePath: string, contents: Uint8Array): Promise<void>
}

/** Everything the extraction runs on. */
export interface InnoExtractionPorts {
  installer: InnoInstallerFile
  digest: InnoDigest
  sink: InnoExtractionSink
}
