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

import { lzmaSampleText } from "./lzmaSample"

const FIXTURES_DIR = join(__dirname, "inno")

mkdirSync(FIXTURES_DIR, { recursive: true })

const sample = Buffer.from(lzmaSampleText(), "utf8")
console.log(`sample: ${sample.length} bytes`)

// The .lzma "alone" container is five property bytes, an eight byte size, then
// the raw stream. The test feeds the properties and the stream to the decoder
// and drops the size, which is exactly what a header block does not carry.
const alone = execFileSync("xz", ["--format=lzma", "-6", "-c"], { input: sample, maxBuffer: 1 << 24 })
writeFileSync(join(FIXTURES_DIR, "sample.lzma1"), alone)
console.log(`sample.lzma1: ${alone.length} bytes`)

// A raw LZMA2 stream carries no dictionary size byte of its own, so the test
// names one. Preset 6 asks for an 8 MiB dictionary, which is property byte 22.
const raw2 = execFileSync("xz", ["--format=raw", "--lzma2=preset=6", "-c"], { input: sample, maxBuffer: 1 << 24 })
writeFileSync(join(FIXTURES_DIR, "sample.lzma2"), raw2)
console.log(`sample.lzma2: ${raw2.length} bytes`)
