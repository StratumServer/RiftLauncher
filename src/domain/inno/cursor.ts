/**
 * A buffered sequential cursor over the installer file.
 *
 * The LZMA2 driver asks for one byte, then four, then a chunk of at most 64 KiB,
 * and it does that tens of thousands of times for one installer. Going to the
 * host for each of those reads would turn a linear pass over six hundred
 * megabytes into a few hundred thousand round trips, so the cursor pulls in a
 * window at a time and serves the small reads out of it.
 */
import { InnoFormatError } from "./errors"
import type { InnoInstallerFile } from "./ports"

/** How much is pulled in per host read. Comfortably above the 64 KiB an LZMA2 chunk can ask for. */
const WINDOW_BYTES = 1 << 20

export class InstallerCursor {
  private buffer: Uint8Array = new Uint8Array(0)
  /** Offset in the file the buffer starts at. */
  private bufferStart = 0
  /** Offset in the file the next read comes from. */
  private at = 0

  constructor(private readonly file: InnoInstallerFile) {}

  /** Where the next read starts. */
  get position(): number {
    return this.at
  }

  /** Moves the cursor. The buffer is kept when the new position still falls inside it. */
  seek(offset: number): void {
    this.at = offset
  }

  /**
   * Reads exactly `length` bytes and advances.
   *
   * The result is a view onto the window and stays valid until the next read, so
   * a caller that keeps the bytes copies them.
   *
   * @throws When the file ends first, which for this format always means the
   * read started somewhere it should not have.
   */
  async readExactly(length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0)

    if (this.at < this.bufferStart || this.at + length > this.bufferStart + this.buffer.length) await this.refill(length)

    const start = this.at - this.bufferStart
    const slice = this.buffer.subarray(start, start + length)
    if (slice.length !== length) throw InnoFormatError.corrupt("the file ended in the middle of a record")
    this.at += length
    return slice
  }

  private async refill(length: number): Promise<void> {
    const want = Math.max(WINDOW_BYTES, length)
    this.buffer = await this.file.read(this.at, want)
    this.bufferStart = this.at
    if (this.buffer.length < length) throw InnoFormatError.corrupt("the file ended in the middle of a record")
  }
}
