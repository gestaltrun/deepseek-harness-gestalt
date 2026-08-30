/**
 * Dependency-free 390×844 gradient color-bar capture frames for fakemobilecli.
 * JPEG is baseline SOF0; H264 is Constrained Baseline Annex-B with I_PCM IDR
 * slices so a browser decoder reconstructs a visible picture without ffmpeg
 * or a checked-in bitstream.
 */

export const FRAME_WIDTH = 390
export const FRAME_HEIGHT = 844
export const FRAME_COUNT = 3

const H264_MB_WIDTH = 25
const H264_MB_HEIGHT = 53
const H264_PADDED_WIDTH = H264_MB_WIDTH * 16
const H264_PADDED_HEIGHT = H264_MB_HEIGHT * 16
const JPEG_PADDED_WIDTH = Math.ceil(FRAME_WIDTH / 8) * 8
const JPEG_PADDED_HEIGHT = Math.ceil(FRAME_HEIGHT / 8) * 8

const BARS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 255, 255],
  [255, 255, 0],
  [0, 255, 255],
  [0, 255, 0],
  [255, 0, 255],
  [255, 0, 0],
  [0, 0, 255],
  [32, 32, 32],
]

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, value | 0))
}

/** One recognizable pixel: eight vertical bars with a vertical fade, shifted per frame. */
export function rgbAt(x: number, y: number, frameIndex = 0): [number, number, number] {
  const bar = Math.min(BARS.length - 1, Math.floor((x * BARS.length) / FRAME_WIDTH))
  const rgb = BARS[bar]
  if (rgb === undefined) throw new Error('color bar index out of range')
  const [r, g, b] = rgb
  const fade = 0.4 + 0.6 * (1 - y / Math.max(1, FRAME_HEIGHT - 1))
  const pulse = ((frameIndex * 40) % 80) / 255
  return [
    clamp8(r * fade + pulse * 40),
    clamp8(g * fade + pulse * 20),
    clamp8(b * fade),
  ]
}

function ycbcrAt(x: number, y: number, frameIndex: number): [number, number, number] {
  const [r, g, b] = rgbAt(Math.min(FRAME_WIDTH - 1, x), Math.min(FRAME_HEIGHT - 1, y), frameIndex)
  const Y = clamp8(0.299 * r + 0.587 * g + 0.114 * b)
  const Cb = clamp8(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)
  const Cr = clamp8(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)
  return [Y, Cb, Cr]
}

/** Fixture luma at one in-picture sample; matches the I_PCM IDR reconstruction. */
export function lumaAt(x: number, y: number, frameIndex = 0): number {
  return ycbcrAt(x, y, frameIndex)[0]
}

class BitWriter {
  private readonly bytes: number[] = []
  private bit = 0
  private accum = 0

  writeBits(value: number, width: number): void {
    if (width <= 0) return
    let remaining = width
    let bits = value >>> 0
    while (remaining > 0) {
      const take = Math.min(8 - this.bit, remaining)
      const shift = remaining - take
      const chunk = (bits >>> shift) & ((1 << take) - 1)
      this.accum = (this.accum << take) | chunk
      this.bit += take
      remaining -= take
      bits &= (1 << shift) - 1
      if (this.bit === 8) {
        this.bytes.push(this.accum)
        this.accum = 0
        this.bit = 0
      }
    }
  }

  writeUe(value: number): void {
    const code = value + 1
    const bits = 32 - Math.clz32(code)
    this.writeBits(0, bits - 1)
    this.writeBits(code, bits)
  }

  writeSe(value: number): void {
    this.writeUe(value <= 0 ? -2 * value : 2 * value - 1)
  }

  alignZero(): void {
    if (this.bit !== 0) this.writeBits(0, 8 - this.bit)
  }

  rbspTrailing(): void {
    this.writeBits(1, 1)
    this.alignZero()
  }

  toBuffer(): Buffer {
    if (this.bit !== 0) throw new Error('unterminated RBSP')
    return Buffer.from(this.bytes)
  }
}

function preventEmulation(rbsp: Buffer): Buffer {
  const out: number[] = []
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros === 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}

function nal(type: number, rbsp: Buffer): Buffer {
  const header = Buffer.from([(3 << 5) | type])
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), header, preventEmulation(rbsp)])
}

function buildSps() {
  const w = new BitWriter()
  w.writeBits(66, 8)
  w.writeBits(1, 1)
  w.writeBits(1, 1)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeBits(0, 2)
  w.writeBits(31, 8)
  w.writeUe(0)
  w.writeUe(0)
  w.writeUe(2)
  w.writeUe(1)
  w.writeBits(0, 1)
  w.writeUe(H264_MB_WIDTH - 1)
  w.writeUe(H264_MB_HEIGHT - 1)
  w.writeBits(1, 1)
  w.writeBits(1, 1)
  w.writeBits(1, 1)
  w.writeUe(0)
  w.writeUe(5)
  w.writeUe(0)
  w.writeUe(2)
  w.writeBits(0, 1)
  w.rbspTrailing()
  return nal(7, w.toBuffer())
}

function buildPps() {
  const w = new BitWriter()
  w.writeUe(0)
  w.writeUe(0)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeUe(0)
  w.writeUe(0)
  w.writeUe(0)
  w.writeBits(0, 1)
  w.writeBits(0, 2)
  w.writeSe(0)
  w.writeSe(0)
  w.writeSe(0)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.rbspTrailing()
  return nal(8, w.toBuffer())
}

function pcmMacroblock(w: BitWriter, mbX: number, mbY: number, frameIndex: number): void {
  w.writeUe(25)
  w.alignZero()
  const originX = mbX * 16
  const originY = mbY * 16
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      w.writeBits(ycbcrAt(originX + col, originY + row, frameIndex)[0], 8)
    }
  }
  for (const plane of [1, 2]) {
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const x = originX + col * 2
        const y = originY + row * 2
        const a = ycbcrAt(x, y, frameIndex)[plane] ?? 128
        const b = ycbcrAt(x + 1, y, frameIndex)[plane] ?? 128
        const c = ycbcrAt(x, y + 1, frameIndex)[plane] ?? 128
        const d = ycbcrAt(x + 1, y + 1, frameIndex)[plane] ?? 128
        w.writeBits(((a + b + c + d) / 4) | 0, 8)
      }
    }
  }
}

function buildIdr(frameIndex: number): Buffer {
  const w = new BitWriter()
  w.writeUe(0)
  w.writeUe(7)
  w.writeUe(0)
  w.writeBits(0, 4)
  w.writeUe(frameIndex)
  w.writeBits(0, 1)
  w.writeBits(0, 1)
  w.writeSe(0)
  for (let mbY = 0; mbY < H264_MB_HEIGHT; mbY += 1) {
    for (let mbX = 0; mbX < H264_MB_WIDTH; mbX += 1) {
      pcmMacroblock(w, mbX, mbY, frameIndex)
    }
  }
  w.rbspTrailing()
  return nal(5, w.toBuffer())
}

/** Constrained Baseline Annex-B stream: SPS/PPS plus several I_PCM IDR pictures. */
export function buildGradientH264(frameCount = FRAME_COUNT): Buffer {
  const nals = [buildSps(), buildPps()]
  for (let frame = 0; frame < frameCount; frame += 1) nals.push(buildIdr(frame))
  return Buffer.concat(nals)
}

class BitReader {
  private readonly bytes: Buffer
  private bitOffset = 0

  constructor(bytes: Buffer) {
    this.bytes = bytes
  }

  bit(): number {
    const byte = this.bytes[this.bitOffset >> 3] ?? 0
    const shift = 7 - (this.bitOffset & 7)
    this.bitOffset += 1
    return (byte >> shift) & 1
  }

  bits(width: number): number {
    let value = 0
    for (let i = 0; i < width; i += 1) value = (value << 1) | this.bit()
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) zeros += 1
    if (zeros === 0) return 0
    return ((1 << zeros) | this.bits(zeros)) - 1
  }

  se(): number {
    const coded = this.ue()
    return (coded & 1) === 1 ? (coded + 1) >> 1 : -(coded >> 1)
  }

  byteAlign(): void {
    while ((this.bitOffset & 7) !== 0) this.bit()
  }
}

function removeEmulation(ebsp: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < ebsp.length; i += 1) {
    if (out.length >= 2 && out[out.length - 2] === 0 && out[out.length - 1] === 0 && ebsp[i] === 3) continue
    out.push(ebsp[i] ?? 0)
  }
  return Buffer.from(out)
}

/**
 * Walk one Annex-B byte stream into NAL units (emulation bytes already removed).
 * @param payload - Complete Annex-B capture body.
 */
export function annexBNals(payload: Buffer): Array<{ type: number; rbsp: Buffer }> {
  const units: Buffer[] = []
  let cursor = 0
  let header = -1
  while (cursor < payload.length - 3) {
    const fourByte = payload[cursor] === 0 && payload[cursor + 1] === 0
      && payload[cursor + 2] === 0 && payload[cursor + 3] === 1
    const threeByte = !fourByte && payload[cursor] === 0 && payload[cursor + 1] === 0
      && payload[cursor + 2] === 1
    if (!fourByte && !threeByte) {
      cursor += 1
      continue
    }
    if (header >= 0) units.push(payload.subarray(header, cursor))
    header = cursor + (fourByte ? 4 : 3)
    cursor = header
  }
  if (header >= 0) units.push(payload.subarray(header))
  return units.map(unit => ({
    type: (unit[0] ?? 0) & 0x1f,
    rbsp: removeEmulation(unit.subarray(1)),
  }))
}

/**
 * Reconstruct luma of the first I_PCM IDR in this fixture's Constrained
 * Baseline stream, cropped to the declared 390×844 picture.
 * @param payload - Complete Annex-B capture body.
 */
export function decodeFirstIpcmIdr(payload: Buffer): { width: number; height: number; y: Uint8Array } {
  const idr = annexBNals(payload).find(nalu => nalu.type === 5)
  if (idr === undefined) throw new Error('capture stream carries no IDR picture NAL')
  const reader = new BitReader(idr.rbsp)
  reader.ue()
  reader.ue()
  reader.ue()
  reader.bits(4)
  reader.ue()
  reader.bits(1)
  reader.bits(1)
  reader.se()
  const luma = new Uint8Array(H264_PADDED_WIDTH * H264_PADDED_HEIGHT)
  for (let mbY = 0; mbY < H264_MB_HEIGHT; mbY += 1) {
    for (let mbX = 0; mbX < H264_MB_WIDTH; mbX += 1) {
      const mbType = reader.ue()
      if (mbType !== 25) throw new Error(`expected I_PCM macroblock, got type ${String(mbType)}`)
      reader.byteAlign()
      const originX = mbX * 16
      const originY = mbY * 16
      for (let row = 0; row < 16; row += 1) {
        for (let col = 0; col < 16; col += 1) {
          luma[(originY + row) * H264_PADDED_WIDTH + originX + col] = reader.bits(8)
        }
      }
      reader.bits(8 * 8 * 8 * 2)
    }
  }
  const cropped = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT)
  for (let row = 0; row < FRAME_HEIGHT; row += 1) {
    cropped.set(luma.subarray(row * H264_PADDED_WIDTH, row * H264_PADDED_WIDTH + FRAME_WIDTH), row * FRAME_WIDTH)
  }
  return { width: FRAME_WIDTH, height: FRAME_HEIGHT, y: cropped }
}

const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)))

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]

const LUM_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]

const CHR_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]

const DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_LUM_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125]
const AC_LUM_VAL = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]
const DC_CHR_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
const DC_CHR_VAL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_CHR_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119]
const AC_CHR_VAL = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]

interface HuffmanEntry {
  readonly code: number
  readonly length: number
}

function buildHuffman(bits: readonly number[], values: readonly number[]): Map<number, HuffmanEntry> {
  const table = new Map<number, HuffmanEntry>()
  let code = 0
  let index = 0
  for (let length = 1; length <= 16; length += 1) {
    code <<= 1
    for (let n = 0; n < (bits[length - 1] ?? 0); n += 1) {
      const symbol = values[index]
      if (symbol === undefined) throw new Error('Huffman values exhausted')
      table.set(symbol, { code, length })
      index += 1
      code += 1
    }
  }
  return table
}

const DC_LUM = buildHuffman(DC_LUM_BITS, DC_LUM_VAL)
const AC_LUM = buildHuffman(AC_LUM_BITS, AC_LUM_VAL)
const DC_CHR = buildHuffman(DC_CHR_BITS, DC_CHR_VAL)
const AC_CHR = buildHuffman(AC_CHR_BITS, AC_CHR_VAL)

function fdct(block: readonly number[]): number[] {
  const tmp = new Array<number>(64)
  const out = new Array<number>(64)
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0
      for (let x = 0; x < 8; x += 1) sum += (block[y * 8 + x] ?? 0) * (COS[u]?.[x] ?? 0)
      tmp[y * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * sum
    }
  }
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      let sum = 0
      for (let y = 0; y < 8; y += 1) sum += (tmp[y * 8 + u] ?? 0) * (COS[v]?.[y] ?? 0)
      out[v * 8 + u] = 0.25 * (v === 0 ? Math.SQRT1_2 : 1) * sum
    }
  }
  return out
}

function categoryOf(value: number): number {
  if (value === 0) return 0
  const abs = Math.abs(value)
  let cat = 0
  let bound = 1
  while (abs >= bound) {
    cat += 1
    bound <<= 1
  }
  return cat
}

function amplitudeBits(value: number, cat: number): number {
  if (cat === 0) return 0
  return value < 0 ? (1 << cat) + value - 1 : value
}

class JpegWriter {
  private readonly chunks: Buffer[] = []
  private bit = 0
  private accum = 0

  marker(code: number, payload?: Buffer): void {
    this.flushBits()
    const body = payload === undefined ? Buffer.alloc(0) : payload
    const header = Buffer.alloc(4)
    header[0] = 0xff
    header[1] = code
    if (code === 0xd8 || code === 0xd9) {
      this.chunks.push(header.subarray(0, 2))
      return
    }
    header.writeUInt16BE(body.length + 2, 2)
    this.chunks.push(header, body)
  }

  writeBits(value: number, width: number): void {
    let remaining = width
    let bits = value
    while (remaining > 0) {
      const take = Math.min(8 - this.bit, remaining)
      const shift = remaining - take
      const chunk = (bits >> shift) & ((1 << take) - 1)
      this.accum = (this.accum << take) | chunk
      this.bit += take
      remaining -= take
      bits &= (1 << shift) - 1
      if (this.bit === 8) this.emitByte(this.accum)
    }
  }

  emitByte(byte: number): void {
    this.chunks.push(Buffer.from([byte]))
    if (byte === 0xff) this.chunks.push(Buffer.from([0x00]))
    this.accum = 0
    this.bit = 0
  }

  flushBits(): void {
    if (this.bit === 0) return
    const pad = (1 << (8 - this.bit)) - 1
    this.emitByte((this.accum << (8 - this.bit)) | pad)
  }

  huffman(table: Map<number, HuffmanEntry>, symbol: number): void {
    const entry = table.get(symbol)
    if (entry === undefined) throw new Error(`JPEG Huffman miss ${String(symbol)}`)
    this.writeBits(entry.code, entry.length)
  }

  toBuffer(): Buffer {
    this.flushBits()
    return Buffer.concat(this.chunks)
  }
}

function encodeBlock(
  writer: JpegWriter,
  block: readonly number[],
  quant: readonly number[],
  dcTable: Map<number, HuffmanEntry>,
  acTable: Map<number, HuffmanEntry>,
  prevDc: number,
): number {
  const shifted = block.map(sample => sample - 128)
  const freq = fdct(shifted)
  const zz = new Array<number>(64)
  for (let i = 0; i < 64; i += 1) {
    zz[i] = Math.round((freq[ZIGZAG[i] ?? 0] ?? 0) / (quant[ZIGZAG[i] ?? 0] ?? 1))
  }
  const dc = zz[0] ?? 0
  const diff = dc - prevDc
  const dcCat = categoryOf(diff)
  writer.huffman(dcTable, dcCat)
  if (dcCat > 0) writer.writeBits(amplitudeBits(diff, dcCat), dcCat)
  let run = 0
  for (let i = 1; i < 64; i += 1) {
    const ac = zz[i] ?? 0
    if (ac === 0) {
      run += 1
      continue
    }
    while (run >= 16) {
      writer.huffman(acTable, 0xf0)
      run -= 16
    }
    const acCat = categoryOf(ac)
    writer.huffman(acTable, (run << 4) | acCat)
    writer.writeBits(amplitudeBits(ac, acCat), acCat)
    run = 0
  }
  if (run > 0) writer.huffman(acTable, 0x00)
  return dc
}

function dqtSegment(tableId: number, table: readonly number[]): Buffer {
  const body = Buffer.alloc(65)
  body[0] = tableId
  for (let i = 0; i < 64; i += 1) body[1 + i] = table[ZIGZAG[i] ?? 0] ?? 0
  return body
}

function dhtSegment(classAndId: number, bits: readonly number[], values: readonly number[]): Buffer {
  return Buffer.concat([Buffer.from([classAndId, ...bits]), Buffer.from(values)])
}

/** Baseline 390×844 JPEG of the same gradient color bars. */
export function buildGradientJpeg(frameIndex = 0): Buffer {
  const planes = [
    new Uint8Array(JPEG_PADDED_WIDTH * JPEG_PADDED_HEIGHT),
    new Uint8Array(JPEG_PADDED_WIDTH * JPEG_PADDED_HEIGHT),
    new Uint8Array(JPEG_PADDED_WIDTH * JPEG_PADDED_HEIGHT),
  ]
  for (let y = 0; y < JPEG_PADDED_HEIGHT; y += 1) {
    for (let x = 0; x < JPEG_PADDED_WIDTH; x += 1) {
      const [Y, Cb, Cr] = ycbcrAt(x, y, frameIndex)
      const index = y * JPEG_PADDED_WIDTH + x
      const luma = planes[0]
      const cbPlane = planes[1]
      const crPlane = planes[2]
      if (luma === undefined || cbPlane === undefined || crPlane === undefined) throw new Error('JPEG planes missing')
      luma[index] = Y
      cbPlane[index] = Cb
      crPlane[index] = Cr
    }
  }
  const writer = new JpegWriter()
  writer.marker(0xd8)
  const jfif = Buffer.from([
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ])
  writer.marker(0xe0, jfif)
  writer.marker(0xdb, dqtSegment(0, LUM_QUANT))
  writer.marker(0xdb, dqtSegment(1, CHR_QUANT))
  const sof = Buffer.alloc(15)
  sof[0] = 8
  sof.writeUInt16BE(FRAME_HEIGHT, 1)
  sof.writeUInt16BE(FRAME_WIDTH, 3)
  sof[5] = 3
  sof[6] = 1
  sof[7] = 0x11
  sof[8] = 0
  sof[9] = 2
  sof[10] = 0x11
  sof[11] = 1
  sof[12] = 3
  sof[13] = 0x11
  sof[14] = 1
  writer.marker(0xc0, sof)
  writer.marker(0xc4, dhtSegment(0x00, DC_LUM_BITS, DC_LUM_VAL))
  writer.marker(0xc4, dhtSegment(0x10, AC_LUM_BITS, AC_LUM_VAL))
  writer.marker(0xc4, dhtSegment(0x01, DC_CHR_BITS, DC_CHR_VAL))
  writer.marker(0xc4, dhtSegment(0x11, AC_CHR_BITS, AC_CHR_VAL))
  writer.marker(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]))
  const prevDc = [0, 0, 0]
  const quant = [LUM_QUANT, CHR_QUANT, CHR_QUANT]
  const dcTable = [DC_LUM, DC_CHR, DC_CHR]
  const acTable = [AC_LUM, AC_CHR, AC_CHR]
  for (let by = 0; by < JPEG_PADDED_HEIGHT; by += 8) {
    for (let bx = 0; bx < JPEG_PADDED_WIDTH; bx += 8) {
      for (let plane = 0; plane < 3; plane += 1) {
        const planeSamples = planes[plane]
        const planeQuant = quant[plane]
        const planeDc = dcTable[plane]
        const planeAc = acTable[plane]
        const previous = prevDc[plane]
        if (
          planeSamples === undefined
          || planeQuant === undefined
          || planeDc === undefined
          || planeAc === undefined
          || previous === undefined
        ) {
          throw new Error('JPEG plane tables missing')
        }
        const block = new Array<number>(64)
        for (let row = 0; row < 8; row += 1) {
          for (let col = 0; col < 8; col += 1) {
            block[row * 8 + col] = planeSamples[(by + row) * JPEG_PADDED_WIDTH + (bx + col)] ?? 0
          }
        }
        prevDc[plane] = encodeBlock(writer, block, planeQuant, planeDc, planeAc, previous)
      }
    }
  }
  writer.marker(0xd9)
  return writer.toBuffer()
}
