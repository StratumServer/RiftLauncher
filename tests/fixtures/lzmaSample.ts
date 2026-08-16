/**
 * The plaintext behind the LZMA fixtures, generated rather than committed.
 *
 * Shared by build-lzma-fixtures.ts, which compresses it, and by
 * tests/domain/inno/lzma.test.ts, which expects the decoder to give it back. A
 * shared generator is what makes the two impossible to drift apart, and it keeps
 * a forty kilobyte plaintext out of the repository for a fixture that is a few
 * hundred bytes compressed.
 *
 * The mix is deliberate: repeated words give the decoder long matches to
 * resolve, and the running counter gives it literals it cannot predict, so both
 * halves of the coder are exercised.
 */
import { createHash } from "node:crypto"

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "the", "quick", "brown", "fox"]

export function lzmaSampleText(): string {
  const parts: string[] = []
  let seed = 12345

  for (let i = 0; i < 6000; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    parts.push(WORDS[seed % WORDS.length]!)
    if (i % 7 === 0) parts.push(String(i))
  }

  return parts.join(" ")
}

/**
 * A bigger relative of {@link lzmaSampleText}, past 2 MiB decompressed: the
 * one thing the small sample cannot exercise is a header block's dictionary
 * growing past its first allocation (GrowingDictionary starts at 64 KiB and
 * doubles from there), or a raw LZMA2 stream's roughly 1 MiB per-chunk output
 * limit (`xz`'s own choice, under the format's 2 MiB cap) forcing more than
 * one chunk, which is what lets a later chunk land on the "no reset at all"
 * continuation the decoder's own comments describe. Same generator shape,
 * more iterations, so it stays exactly as reproducible as the small one.
 */
export function lzmaLargeSampleText(): string {
  const parts: string[] = []
  let seed = 987654321

  for (let i = 0; i < 320_000; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    parts.push(WORDS[seed % WORDS.length]!)
    if (i % 7 === 0) parts.push(String(i))
  }

  return parts.join(" ")
}

/**
 * `length` bytes with nothing an LZMA coder can find a match in: SHA-256 over
 * an incrementing counter, seeded, so two calls with the same `seed` always
 * agree without either one persisting the bytes. build-lzma-fixtures.ts uses
 * this to force `xz` into emitting an LZMA2 stream with genuine uncompressed
 * chunks (compressible data on either side of a block this incompressible),
 * and lzma.test.ts regenerates the same bytes to check the decoder's own
 * output against them.
 */
export function pseudoRandomBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length)
  let at = 0
  let counter = 0
  while (at < length) {
    const digest = createHash("sha256").update(`${seed}:${counter}`).digest()
    const take = Math.min(digest.length, length - at)
    digest.copy(out, at, 0, take)
    at += take
    counter++
  }
  return out
}
