/**
 * Builds the two small LZMA streams under tests/fixtures/inno/ that
 * tests/domain/inno/lzma.test.ts decodes, so the decoder in
 * src/domain/inno/lzma.ts is checked against bytes a real compressor produced
 * rather than against itself.
 *
 * This script is not run by the test suite, and it is the one fixture builder
 * that needs a tool on the machine: `xz`, to do the compressing. Run it by hand
 * after changing it, `npx tsx tests/fixtures/build-lzma-fixtures.ts`, and commit
 * the streams it writes.
 *
 * The plaintext is not committed. It is generated from a fixed seed by
 * `lzmaSampleText`, which the test calls too, so the fixture is a few hundred
 * bytes instead of forty kilobytes and the expected output cannot drift away
 * from what was compressed.
 *
 * Two shapes are built because the installer holds both: a raw LZMA1 stream with
 * no stored length and no end marker, which is how the header blocks are
 * compressed, and a raw LZMA2 stream, which is how the payload is.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { lzmaLargeSampleText, lzmaSampleText, pseudoRandomBytes } from "./lzmaSample"

const FIXTURES_DIR = join(__dirname, "inno")
const MAX_BUFFER = 1 << 28

mkdirSync(FIXTURES_DIR, { recursive: true })

function xz(args: string[], input: Buffer): Buffer {
  return execFileSync("xz", args, { input, maxBuffer: MAX_BUFFER })
}

function write(name: string, contents: Buffer): void {
  writeFileSync(join(FIXTURES_DIR, name), contents)
  console.log(`${name}: ${contents.length} bytes`)
}

const sample = Buffer.from(lzmaSampleText(), "utf8")
console.log(`sample: ${sample.length} bytes`)

// The .lzma "alone" container is five property bytes, an eight byte size, then
// the raw stream. The test feeds the properties and the stream to the decoder
// and drops the size, which is exactly what a header block does not carry.
write("sample.lzma1", xz(["--format=lzma", "-6", "-c"], sample))

// A raw LZMA2 stream carries no dictionary size byte of its own, so the test
// names one. Preset 6 asks for an 8 MiB dictionary, which is property byte 22.
write("sample.lzma2", xz(["--format=raw", "--lzma2=preset=6", "-c"], sample))

// Past 64 KiB decompressed, the one size a header block's GrowingDictionary
// never reaches from the small sample: this is what makes it grow its buffer
// at least once instead of staying at its first allocation.
const large = Buffer.from(lzmaLargeSampleText(), "utf8")
console.log(`large sample: ${large.length} bytes`)
write("sample-large.lzma1", xz(["--format=lzma", "-6", "-c"], large))

// The same text, but as a raw LZMA2 stream: past what one chunk can hold, so
// `xz` itself splits it in two. The second chunk it emits carries reset=0,
// the "dictionary, model and machine state all survive untouched" case
// Lzma2Decoder.decodeUncompressedChunk's own comment describes, here landing
// on a COMPRESSED chunk instead, which the state-continuation logic treats no
// differently.
write("sample-large.lzma2", xz(["--format=raw", "--lzma2=preset=6", "-c"], large))

// The same text again, this time asking for a dictionary far smaller than the
// text itself (4 KiB, property byte 0). The ring the payload's dictionary is
// built on (RingDictionary) has to wrap around it dozens of times, rather
// than the small dictionaries every other fixture here stays well inside of.
write("sample-small-dict.lzma2", xz(["--format=raw", "--lzma2=dict=4096", "-c"], large))

// Compressible text, then a block with nothing an LZMA coder can match
// against, then compressible text again: this is what pushes `xz`'s own
// encoder into emitting genuine LZMA2 UNCOMPRESSED chunks around the middle
// block, and a compressed chunk with reset=1 (state reset, dictionary kept)
// resuming after them.
const compressibleHalf = Buffer.from(lzmaSampleText(), "utf8")
const incompressible = pseudoRandomBytes(150_000, 7)
const mixed = Buffer.concat([compressibleHalf, incompressible, compressibleHalf])
write("sample-mixed.lzma2", xz(["--format=raw", "--lzma2=preset=1", "-c"], mixed))

// The incompressible block FIRST, so the very first chunk in the stream is an
// uncompressed one asking for a dictionary reset (control byte 1), the one
// shape sample-mixed.lzma2's own uncompressed chunks (control byte 2,
// continuing) never exercise.
const leadingRandom = Buffer.concat([incompressible, compressibleHalf])
write("sample-leading-random.lzma2", xz(["--format=raw", "--lzma2=preset=1", "-c"], leadingRandom))
