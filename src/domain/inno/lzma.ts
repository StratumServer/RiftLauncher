/**
 * LZMA1 and LZMA2 decoding, in plain TypeScript.
 *
 * ## Why this is not a dependency
 *
 * The two streams an Inno Setup installer holds are a raw LZMA1 stream for its
 * header blocks (five property bytes, then data, with no end marker and no
 * stored output length) and a raw LZMA2 stream for its payload (one dictionary
 * size byte, then chunks). Neither is a container format, so neither can be
 * handed to a decoder that expects `.lzma`, `.xz` or `.7z` framing.
 *
 * The npm survey came back empty for what that needs. Every pure JavaScript
 * package on offer descends from one of two ports (LZMA-JS and js-lzma) and
 * decodes LZMA1 alone: `lzma`, `lzma-purejs`, `js-lzma`, `lzma1`, `lzma-web`,
 * `@blu3r4y/lzma`, `lzma-js-simple-v2`. None of them decodes LZMA2, and LZMA2
 * cannot be driven from an LZMA1 decoder from outside, because its chunks share
 * one dictionary and usually one probability model, and no package exposes
 * either across calls. The packages that do decode LZMA2 ship a compiled
 * artifact: `lzma-native` and `@napi-rs/lzma` are per platform binaries,
 * `xz-decompress`, `lzma-wasm` and `@emn178/lzma-wasm` are WebAssembly blobs and
 * only read the `.xz` container anyway.
 *
 * So there was no pure JavaScript package to pick, and adding a binary
 * dependency is a team decision rather than a decision to be taken quietly in a
 * pull request. What is left is the option the format itself makes cheap: LZMA2
 * is a thin chunk framing over the same decoder LZMA1 uses, so one core covers
 * both, and correctness is not a matter of opinion here. The installer carries a
 * SHA-256 for every file it holds, so a wrong decoder does not produce a subtly
 * broken game, it fails the first digest and the install falls back.
 *
 * ## What is implemented
 *
 * The decoder follows the reference LZMA specification: an adaptive binary range
 * decoder, the literal, length and distance probability models, and a dictionary
 * that matches copy out of. Encoding is not implemented and is not needed.
 * Distances above `0xFFFFFFFF - 1` (the end of stream marker) are honoured for
 * LZMA1 and refused for LZMA2, which has no such marker.
 */

import { InnoFormatError } from "./errors"

const TOP_VALUE = 1 << 24
const MODEL_TOTAL_BITS = 11
const MODEL_TOTAL = 1 << MODEL_TOTAL_BITS
const MOVE_BITS = 5
const PROBABILITY_INIT = MODEL_TOTAL >>> 1

const POS_BITS_MAX = 4
const STATE_COUNT = 12
const LEN_TO_POS_STATES = 4
const END_POS_MODEL_INDEX = 14
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >>> 1)
const ALIGN_BITS = 4
const ALIGN_TABLE_SIZE = 1 << ALIGN_BITS
const MATCH_MIN_LEN = 2
const POS_SLOTS = 64
const LITERAL_CODER_SIZE = 0x300

/**
 * Where decoded bytes land, and where matches are copied from.
 *
 * Two shapes exist because the two streams need different things. A header
 * block has no stored output length, so its dictionary grows and stays whole,
 * which makes it trivial to undo the last symbol when the input turns out to
 * have ended. The payload runs to hundreds of megabytes, so its dictionary is a
 * ring the size the stream declares and finished bytes are handed out as they
 * are produced.
 */
interface LzmaDictionary {
  /** Bytes produced since the last dictionary reset. */
  readonly position: number
  /** How far back a match may reach right now. */
  readonly reach: number
  put(byte: number): void
  /** Byte `distance` places back, `distance` being 1 for the byte just written. */
  back(distance: number): number
  copyMatch(distance: number, length: number): void
}

/** Dictionary for header blocks: one buffer that grows, and is the output. */
class GrowingDictionary implements LzmaDictionary {
  private buffer: Uint8Array
  private length = 0

  constructor(private readonly maxBytes: number) {
    this.buffer = new Uint8Array(Math.min(1 << 16, Math.max(1, maxBytes)))
  }

  get position(): number {
    return this.length
  }

  get reach(): number {
    return this.length
  }

  put(byte: number): void {
    if (this.length === this.buffer.length) this.grow()
    this.buffer[this.length++] = byte
  }

  back(distance: number): number {
    const at = this.length - distance
    if (at < 0) throw InnoFormatError.corrupt("a match reaches before the start of the stream")
    return this.buffer[at]!
  }

  copyMatch(distance: number, length: number): void {
    if (distance > this.length) throw InnoFormatError.corrupt("a match reaches before the start of the stream")
    let from = this.length - distance
    for (let i = 0; i < length; i++) this.put(this.buffer[from++]!)
  }

  /** Drops everything produced after `position`, used to undo a symbol the input could not pay for. */
  rollbackTo(position: number): void {
    this.length = position
  }

  /** The decoded bytes, copied out at their exact length. */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }

  private grow(): void {
    if (this.length >= this.maxBytes) throw InnoFormatError.corrupt(`a header block decompressed past ${this.maxBytes} bytes`)
    const grown = new Uint8Array(Math.min(this.maxBytes, this.buffer.length * 2))
    grown.set(this.buffer)
    this.buffer = grown
  }
}

/** Dictionary for the payload: a ring of the declared size, flushed as it fills. */
class RingDictionary implements LzmaDictionary {
  private readonly buffer: Uint8Array
  private cursor = 0
  private unflushed = 0
  private filled = false
  private produced = 0

  constructor(
    size: number,
    private readonly onOutput: (bytes: Uint8Array) => void
  ) {
    this.buffer = new Uint8Array(size)
  }

  get position(): number {
    return this.produced
  }

  get reach(): number {
    return this.filled ? this.buffer.length : this.cursor
  }

  put(byte: number): void {
    if (this.cursor === this.buffer.length) {
      this.flush()
      this.cursor = 0
      this.unflushed = 0
      this.filled = true
    }
    this.buffer[this.cursor++] = byte
    this.produced++
  }

  back(distance: number): number {
    if (distance > this.reach) throw InnoFormatError.corrupt("a match reaches before the start of the stream")
    let at = this.cursor - distance
    if (at < 0) at += this.buffer.length
    return this.buffer[at]!
  }

  copyMatch(distance: number, length: number): void {
    if (distance > this.reach) throw InnoFormatError.corrupt("a match reaches before the start of the stream")
    let from = this.cursor - distance
    if (from < 0) from += this.buffer.length
    for (let i = 0; i < length; i++) {
      this.put(this.buffer[from++]!)
      if (from === this.buffer.length) from = 0
    }
  }

  /** Hands out everything produced since the last call. */
  flush(): void {
    if (this.cursor === this.unflushed) return
    this.onOutput(this.buffer.subarray(this.unflushed, this.cursor))
    this.unflushed = this.cursor
  }

  /** Starts the window over, as an LZMA2 dictionary reset asks. */
  reset(): void {
    this.flush()
    this.cursor = 0
    this.unflushed = 0
    this.filled = false
    this.produced = 0
  }
}

/**
 * The adaptive binary range decoder.
 *
 * One instance is reused across LZMA2 chunks because every chunk restarts the
 * range coder with its own five initialisation bytes, while the probability
 * model above it may carry on.
 */
class RangeDecoder {
  private input: Uint8Array = new Uint8Array(0)
  private at = 0
  range = 0
  code = 0
  /** Set once a read went past the end of the input, and never cleared until the next start. */
  overrun = false

  /** Points the decoder at one chunk of compressed bytes and reads its five initialisation bytes. */
  start(input: Uint8Array): void {
    if (input.length < 5) throw InnoFormatError.corrupt("a compressed chunk is shorter than its range coder header")
    if (input[0] !== 0) throw InnoFormatError.corrupt("a compressed chunk does not start with a range coder header")
    this.input = input
    this.code = ((input[1]! << 24) | (input[2]! << 16) | (input[3]! << 8) | input[4]!) >>> 0
    this.range = 0xffffffff
    this.at = 5
    this.overrun = false
  }

  private nextByte(): number {
    if (this.at >= this.input.length) {
      this.overrun = true
      return 0
    }
    return this.input[this.at++]!
  }

  private normalize(): void {
    if (this.range < TOP_VALUE) {
      this.range = (this.range * 256) >>> 0
      this.code = (this.code * 256 + this.nextByte()) >>> 0
    }
  }

  decodeBit(probabilities: Uint16Array, index: number): number {
    const probability = probabilities[index]!
    const bound = (this.range >>> MODEL_TOTAL_BITS) * probability
    let bit: number
    if (this.code < bound) {
      probabilities[index] = probability + ((MODEL_TOTAL - probability) >>> MOVE_BITS)
      this.range = bound
      bit = 0
    } else {
      probabilities[index] = probability - (probability >>> MOVE_BITS)
      this.code = (this.code - bound) >>> 0
      this.range = (this.range - bound) >>> 0
      bit = 1
    }
    this.normalize()
    return bit
  }

  decodeDirectBits(count: number): number {
    let result = 0
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1
      this.code = (this.code - this.range) >>> 0
      const mask = 0 - (this.code >>> 31)
      this.code = (this.code + (this.range & mask)) >>> 0
      result = (result * 2 + mask + 1) >>> 0
      this.normalize()
    }
    return result
  }

  decodeBitTree(probabilities: Uint16Array, base: number, bits: number): number {
    let index = 1
    for (let i = 0; i < bits; i++) index = (index << 1) | this.decodeBit(probabilities, base + index)
    return index - (1 << bits)
  }

  decodeBitTreeReverse(probabilities: Uint16Array, base: number, bits: number): number {
    let index = 1
    let result = 0
    for (let i = 0; i < bits; i++) {
      const bit = this.decodeBit(probabilities, base + index)
      index = (index << 1) | bit
      result |= bit << i
    }
    return result >>> 0
  }
}

/** The length coder, used once for matches and once for repeated matches. */
class LengthDecoder {
  private readonly choice = new Uint16Array(2)
  private readonly low = new Uint16Array(1 << (POS_BITS_MAX + 3))
  private readonly mid = new Uint16Array(1 << (POS_BITS_MAX + 3))
  private readonly high = new Uint16Array(1 << 8)

  reset(): void {
    this.choice.fill(PROBABILITY_INIT)
    this.low.fill(PROBABILITY_INIT)
    this.mid.fill(PROBABILITY_INIT)
    this.high.fill(PROBABILITY_INIT)
  }

  decode(range: RangeDecoder, posState: number): number {
    if (range.decodeBit(this.choice, 0) === 0) return range.decodeBitTree(this.low, posState << 3, 3)
    if (range.decodeBit(this.choice, 1) === 0) return 8 + range.decodeBitTree(this.mid, posState << 3, 3)
    return 16 + range.decodeBitTree(this.high, 0, 8)
  }
}

/**
 * Everything the decoder carries between symbols: the probability model, the
 * four most recent distances, and the machine state.
 *
 * Held apart from the decode loop because LZMA2 resets these three things on its
 * own schedule, independently of the dictionary and of the range coder.
 */
class LzmaModel {
  literalContextBits = 0
  literalPositionBits = 0
  positionBits = 0

  /** Sized by `lc` and `lp`, so it is allocated once the properties are known and reused after that. */
  literals = new Uint16Array(0)
  private literalTableSize = 0

  readonly isMatch = new Uint16Array(STATE_COUNT << POS_BITS_MAX)
  readonly isRep = new Uint16Array(STATE_COUNT)
  readonly isRepG0 = new Uint16Array(STATE_COUNT)
  readonly isRepG1 = new Uint16Array(STATE_COUNT)
  readonly isRepG2 = new Uint16Array(STATE_COUNT)
  readonly isRep0Long = new Uint16Array(STATE_COUNT << POS_BITS_MAX)
  readonly posSlots = new Uint16Array(LEN_TO_POS_STATES * POS_SLOTS)
  readonly posDecoders = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL_INDEX)
  readonly alignDecoder = new Uint16Array(ALIGN_TABLE_SIZE)
  readonly matchLengths = new LengthDecoder()
  readonly repeatLengths = new LengthDecoder()

  state = 0
  rep0 = 0
  rep1 = 0
  rep2 = 0
  rep3 = 0
  propertiesSet = false

  /** Reads the packed `lc`, `lp` and `pb` byte the format calls the properties. */
  setProperties(properties: number): void {
    if (properties >= 9 * 5 * 5) throw InnoFormatError.corrupt(`invalid LZMA properties byte (${properties})`)
    let rest = properties
    this.literalContextBits = rest % 9
    rest = (rest - this.literalContextBits) / 9
    this.literalPositionBits = rest % 5
    this.positionBits = (rest - this.literalPositionBits) / 5
    this.literalTableSize = LITERAL_CODER_SIZE << (this.literalContextBits + this.literalPositionBits)
    if (this.literals.length < this.literalTableSize) this.literals = new Uint16Array(this.literalTableSize)
    this.propertiesSet = true
  }

  reset(): void {
    if (!this.propertiesSet) throw InnoFormatError.corrupt("a compressed chunk resets its state before any properties were read")
    this.literals.subarray(0, this.literalTableSize).fill(PROBABILITY_INIT)
    this.isMatch.fill(PROBABILITY_INIT)
    this.isRep.fill(PROBABILITY_INIT)
    this.isRepG0.fill(PROBABILITY_INIT)
    this.isRepG1.fill(PROBABILITY_INIT)
    this.isRepG2.fill(PROBABILITY_INIT)
    this.isRep0Long.fill(PROBABILITY_INIT)
    this.posSlots.fill(PROBABILITY_INIT)
    this.posDecoders.fill(PROBABILITY_INIT)
    this.alignDecoder.fill(PROBABILITY_INIT)
    this.matchLengths.reset()
    this.repeatLengths.reset()
    this.state = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
  }
}

/** How a run of symbols ended. */
type DecodeOutcome = "limit-reached" | "end-marker" | "input-exhausted"

/**
 * Decodes symbols until `limit` bytes have been produced since the dictionary
 * was last reset, the stream declares its end, or the input runs out.
 *
 * The input running out is a normal ending for a header block, which stores
 * neither its length nor an end marker, so the caller says whether a symbol that
 * needed bytes past the end should be undone. It always should: the encoder
 * flushes exactly enough bytes for every real symbol, so a symbol that reads
 * past the end is not one the encoder wrote.
 */
function decodeSymbols(range: RangeDecoder, dictionary: LzmaDictionary, model: LzmaModel, limit: number, onOverrun?: (position: number) => void): DecodeOutcome {
  // Modulo rather than a bit mask: the payload of one installer runs to
  // hundreds of megabytes, and a position counter is only a moment away from
  // the point where `&` starts truncating to a signed 32 bit int.
  const positions = 1 << model.positionBits
  const literalPositions = 1 << model.literalPositionBits
  const literalContextBits = model.literalContextBits

  while (dictionary.position < limit) {
    const mark = dictionary.position
    const posState = mark % positions

    if (range.decodeBit(model.isMatch, (model.state << POS_BITS_MAX) + posState) === 0) {
      const previous = dictionary.reach === 0 ? 0 : dictionary.back(1)
      const literalState = (mark % literalPositions << literalContextBits) + (previous >>> (8 - literalContextBits))
      const base = literalState * LITERAL_CODER_SIZE
      let symbol = 1

      if (model.state >= 7) {
        let matchByte = dictionary.back(model.rep0 + 1)
        do {
          const matchBit = (matchByte >>> 7) & 1
          matchByte = (matchByte << 1) & 0xff
          const bit = range.decodeBit(model.literals, base + ((1 + matchBit) << 8) + symbol)
          symbol = (symbol << 1) | bit
          if (matchBit !== bit) {
            while (symbol < 0x100) symbol = (symbol << 1) | range.decodeBit(model.literals, base + symbol)
            break
          }
        } while (symbol < 0x100)
      } else {
        while (symbol < 0x100) symbol = (symbol << 1) | range.decodeBit(model.literals, base + symbol)
      }

      if (range.overrun) {
        onOverrun?.(mark)
        return "input-exhausted"
      }

      dictionary.put(symbol & 0xff)
      model.state = model.state < 4 ? 0 : model.state < 10 ? model.state - 3 : model.state - 6
      continue
    }

    let length: number

    if (range.decodeBit(model.isRep, model.state) !== 0) {
      if (dictionary.reach === 0) throw InnoFormatError.corrupt("a repeated match appears before anything was decoded")

      if (range.decodeBit(model.isRepG0, model.state) === 0) {
        if (range.decodeBit(model.isRep0Long, (model.state << POS_BITS_MAX) + posState) === 0) {
          if (range.overrun) {
            onOverrun?.(mark)
            return "input-exhausted"
          }
          model.state = model.state < 7 ? 9 : 11
          dictionary.put(dictionary.back(model.rep0 + 1))
          continue
        }
      } else {
        let distance: number
        if (range.decodeBit(model.isRepG1, model.state) === 0) distance = model.rep1
        else if (range.decodeBit(model.isRepG2, model.state) === 0) {
          distance = model.rep2
          model.rep2 = model.rep1
        } else {
          distance = model.rep3
          model.rep3 = model.rep2
          model.rep2 = model.rep1
        }
        model.rep1 = model.rep0
        model.rep0 = distance
      }

      length = model.repeatLengths.decode(range, posState)
      model.state = model.state < 7 ? 8 : 11
    } else {
      model.rep3 = model.rep2
      model.rep2 = model.rep1
      model.rep1 = model.rep0
      length = model.matchLengths.decode(range, posState)
      model.state = model.state < 7 ? 7 : 10

      const distance = decodeDistance(range, model, length)
      if (distance === 0xffffffff) {
        if (range.overrun) {
          onOverrun?.(mark)
          return "input-exhausted"
        }
        return "end-marker"
      }
      if (distance >= dictionary.reach) throw InnoFormatError.corrupt(`a match reaches ${distance + 1} bytes back with only ${dictionary.reach} decoded`)
      model.rep0 = distance
    }

    if (range.overrun) {
      onOverrun?.(mark)
      return "input-exhausted"
    }

    length += MATCH_MIN_LEN
    if (mark + length > limit) throw InnoFormatError.corrupt("a match runs past the end of its chunk")
    dictionary.copyMatch(model.rep0 + 1, length)
  }

  return "limit-reached"
}

function decodeDistance(range: RangeDecoder, model: LzmaModel, length: number): number {
  const lenToPosState = length < LEN_TO_POS_STATES ? length : LEN_TO_POS_STATES - 1
  const posSlot = range.decodeBitTree(model.posSlots, lenToPosState * POS_SLOTS, 6)
  if (posSlot < 4) return posSlot

  const directBits = (posSlot >>> 1) - 1
  let distance = ((2 | (posSlot & 1)) * Math.pow(2, directBits)) >>> 0

  if (posSlot < END_POS_MODEL_INDEX) {
    distance = (distance + range.decodeBitTreeReverse(model.posDecoders, distance - posSlot, directBits)) >>> 0
    return distance
  }

  distance = (distance + range.decodeDirectBits(directBits - ALIGN_BITS) * ALIGN_TABLE_SIZE) >>> 0
  distance = (distance + range.decodeBitTreeReverse(model.alignDecoder, 0, ALIGN_BITS)) >>> 0
  return distance
}

/**
 * Decodes a raw LZMA1 stream that stores neither its output length nor an end
 * marker, which is how Inno Setup compresses its header blocks.
 *
 * @param properties The five property bytes: the packed `lc`/`lp`/`pb` byte then
 * the dictionary size, which is ignored here because the output is its own
 * dictionary.
 * @param data The compressed bytes, starting at the range coder header.
 * @param maxBytes Refusal bound on the decompressed size. A real header block is
 * a few megabytes; past this the read is not on a header at all.
 */
export function decodeLzma1(properties: Uint8Array, data: Uint8Array, maxBytes: number): Uint8Array {
  if (properties.length < 5) throw InnoFormatError.corrupt("an LZMA1 stream is shorter than its property header")

  const model = new LzmaModel()
  model.setProperties(properties[0]!)
  model.reset()

  const dictionary = new GrowingDictionary(maxBytes)
  const range = new RangeDecoder()
  range.start(data)

  decodeSymbols(range, dictionary, model, Number.POSITIVE_INFINITY, (position) => dictionary.rollbackTo(position))

  return dictionary.toBytes()
}

/**
 * Refusal bound on the dictionary the stream asks for, since that number decides
 * one allocation. Inno Setup compiles with dictionaries in the tens of
 * megabytes; anything above this is a size byte read at the wrong offset.
 */
const LZMA2_MAX_DICTIONARY = 512 * 1024 * 1024

/** Turns the LZMA2 dictionary size byte into a byte count. */
export function lzma2DictionarySize(properties: number): number {
  if (properties > 40) throw InnoFormatError.corrupt(`invalid LZMA2 dictionary size byte (${properties})`)
  const size = properties === 40 ? 0xffffffff : (2 | (properties & 1)) * Math.pow(2, (properties >>> 1) + 11)
  if (size > LZMA2_MAX_DICTIONARY) throw InnoFormatError.unsupported(`an LZMA2 dictionary of ${size} bytes`)
  return size
}

/** What the driver hands the LZMA2 decoder when it asks for more compressed bytes. */
export interface Lzma2Input {
  /** Resolves exactly `length` bytes, or rejects when the source ends first. */
  readExactly(length: number): Promise<Uint8Array>
}

/** The decoder contract the domain can use without knowing whether it is native or TypeScript. */
export interface Lzma2DecoderPort {
  /** True after the stream's terminating control byte has been consumed. */
  readonly finished: boolean
  /** Reads and decodes one raw LZMA2 chunk. */
  decodeChunk(input: Lzma2Input): Promise<number>
}

/** Allows the Node worker to inject an optional native decoder without leaking Node into domain code. */
export type Lzma2DecoderFactory = (dictionarySizeProperties: number, onOutput: (bytes: Uint8Array) => void) => Lzma2DecoderPort

/**
 * Decodes a raw LZMA2 stream, chunk by chunk, handing decoded bytes out as they
 * are produced.
 *
 * The stream is a sequence of chunks, each one at most 2 MiB of output and at
 * most 64 KiB of input, and this implementation hands each one to `onOutput`
 * before reading the next, so it never holds more than a chunk of either. That
 * bound is a property of this decoder, not of `Lzma2DecoderPort`: a decoder
 * backed by a library that does not stream, such as the injected native one,
 * can buffer a whole solid block before it starts draining, and its caller in
 * `extract.ts` has to allow for that. A control byte of zero ends the stream;
 * the driver may also stop early once it has read as much as it wanted, which
 * is what the payload reader does with the last file of a block.
 */
export class Lzma2Decoder implements Lzma2DecoderPort {
  private readonly model = new LzmaModel()
  private readonly range = new RangeDecoder()
  private readonly dictionary: RingDictionary
  private needsDictionaryReset = true
  private ended = false

  /**
   * @param dictionarySizeProperties The one byte an LZMA2 stream opens with.
   * @param onOutput Called with each run of decoded bytes, in order. The buffer
   * is a view onto the dictionary and is reused, so a consumer copies what it
   * keeps before returning.
   */
  constructor(dictionarySizeProperties: number, onOutput: (bytes: Uint8Array) => void) {
    this.dictionary = new RingDictionary(lzma2DictionarySize(dictionarySizeProperties), onOutput)
  }

  /** True once the stream's terminating control byte was read. */
  get finished(): boolean {
    return this.ended
  }

  /**
   * Reads one chunk from `input` and pushes its bytes to the output callback.
   *
   * @returns How many bytes the chunk produced, zero once the stream ended.
   */
  async decodeChunk(input: Lzma2Input): Promise<number> {
    if (this.ended) return 0

    const control = (await input.readExactly(1))[0]!
    if (control === 0) {
      this.dictionary.flush()
      this.ended = true
      return 0
    }

    if (control < 3) return this.decodeUncompressedChunk(input, control)
    if (control < 0x80) throw InnoFormatError.corrupt(`invalid LZMA2 control byte (${control})`)

    return this.decodeCompressedChunk(input, control)
  }

  private async decodeUncompressedChunk(input: Lzma2Input, control: number): Promise<number> {
    const header = await input.readExactly(2)
    const size = ((header[0]! << 8) | header[1]!) + 1

    if (control === 1) this.resetDictionary()
    else if (this.needsDictionaryReset) throw InnoFormatError.corrupt("an LZMA2 chunk continues a dictionary that was never started")

    const bytes = await input.readExactly(size)
    for (let i = 0; i < size; i++) this.dictionary.put(bytes[i]!)
    this.dictionary.flush()

    // The probability model, the machine state and the four recent distances all
    // survive an uncompressed chunk untouched. Only the dictionary moved, and
    // only because bytes were appended to it. Resetting any of the rest here is
    // what breaks this format: the payload of Vintage Story runs forty four
    // uncompressed chunks in a row and then goes straight back to a compressed
    // chunk that asks for no reset at all, which only decodes if the model came
    // through the detour intact.
    return size
  }

  private async decodeCompressedChunk(input: Lzma2Input, control: number): Promise<number> {
    const header = await input.readExactly(4)
    const outputSize = (((control & 0x1f) << 16) | (header[0]! << 8) | header[1]!) + 1
    const inputSize = ((header[2]! << 8) | header[3]!) + 1
    const reset = (control >>> 5) & 3
    if (reset >= 3) this.resetDictionary()
    else if (this.needsDictionaryReset) throw InnoFormatError.corrupt("an LZMA2 chunk continues a dictionary that was never started")

    if (reset >= 2) this.model.setProperties((await input.readExactly(1))[0]!)
    if (reset >= 1) this.model.reset()
    else if (!this.model.propertiesSet) throw InnoFormatError.corrupt("an LZMA2 chunk continues a state that was never started")

    const compressed = await input.readExactly(inputSize)
    this.range.start(compressed)

    const limit = this.dictionary.position + outputSize
    const outcome = decodeSymbols(this.range, this.dictionary, this.model, limit)
    if (outcome !== "limit-reached") throw InnoFormatError.corrupt("an LZMA2 chunk ended before the size it declared")
    if (this.range.overrun) throw InnoFormatError.corrupt("an LZMA2 chunk read past the compressed size it declared")

    this.dictionary.flush()
    return outputSize
  }

  private resetDictionary(): void {
    this.dictionary.reset()
    this.needsDictionaryReset = false
  }
}
