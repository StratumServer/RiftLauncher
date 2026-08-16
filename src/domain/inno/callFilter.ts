/**
 * Undoes the transform the Inno Setup compiler applies to executables before
 * compressing them.
 *
 * In an x86 binary, `CALL` (`0xE8`) and `JMP` (`0xE9`) carry an address RELATIVE
 * to the instruction that follows. Two calls to the same function from two
 * different places therefore produce two different byte runs, which the
 * compressor cannot share. Inno Setup turns those addresses into ABSOLUTE ones
 * before compressing, which makes the patterns identical and buys several points
 * of ratio; reading has to return the favour in the other direction.
 *
 * Three details are what make this correct, and all three are checked against the
 * SHA-256 of the entries. The four address bytes are NEVER re-examined looking
 * for another `0xE8`: the scan resumes after them, otherwise an address byte
 * taken for an instruction would shift everything after it. An instruction
 * straddling a 64 KiB block boundary is left alone, because the compiler left it
 * alone too. And the high byte is inverted when bit 23 of the result is set, an
 * optimisation Inno Setup 5.3.9 added so that forward and backward jumps produce
 * the same high byte.
 */

/** The block size the compiler reasons in. */
const BLOCK_BYTES = 0x10000

/** Restores the relative addresses, in place. */
export function undoCallInstructionFilter(data: Uint8Array): void {
  let i = 0

  while (i + 5 <= data.length) {
    const opcode = data[i]!
    if (opcode !== 0xe8 && opcode !== 0xe9) {
      i++
      continue
    }

    if (BLOCK_BYTES - (i % BLOCK_BYTES) < 5) {
      i++
      continue
    }

    // The compiler only transformed addresses whose high byte was 0x00 or 0xFF,
    // that is the sign extension of a 24 bit displacement. The rest are unlikely
    // to be instructions and were left as they were.
    const high = data[i + 4]!
    if (high === 0x00 || high === 0xff) {
      const address = (i + 5) & 0xffffff
      const stored = (data[i + 1]! | (data[i + 2]! << 8) | (data[i + 3]! << 16)) >>> 0
      const relative = (stored - address) & 0xffffff

      data[i + 1] = relative & 0xff
      data[i + 2] = (relative >>> 8) & 0xff
      data[i + 3] = (relative >>> 16) & 0xff

      if ((relative & 0x800000) !== 0) data[i + 4] = ~high & 0xff
    }

    i += 5
  }
}
