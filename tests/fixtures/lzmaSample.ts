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
