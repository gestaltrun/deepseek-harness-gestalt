import { describe, expect, it } from 'vitest'
import {
  FRAME_COUNT,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  annexBNals,
  buildGradientH264,
  buildGradientJpeg,
  decodeFirstIpcmIdr,
  lumaAt,
} from './fixtures/u3-visible-frames.ts'
import { assertRecognizableH264Picture, assertStructurallyDecodableJpeg, jpegDimensions } from './helpers.ts'

describe('U3 visible capture frames', () => {
  it('encodes a 390x844 baseline JPEG of the gradient color bars', () => {
    const jpeg = buildGradientJpeg(0)
    assertStructurallyDecodableJpeg(jpeg)
    expect(jpegDimensions(jpeg)).toEqual({ width: FRAME_WIDTH, height: FRAME_HEIGHT })
  })

  it('encodes a Constrained Baseline Annex-B stream whose first IDR luma matches the gradient', () => {
    const stream = buildGradientH264()
    const types = annexBNals(stream).map(nal => nal.type)
    expect(types[0]).toBe(7)
    expect(types[1]).toBe(8)
    expect(types.filter(type => type === 5)).toHaveLength(FRAME_COUNT)
    assertRecognizableH264Picture(stream)
    const picture = decodeFirstIpcmIdr(stream)
    expect(picture.y[0]).toBe(lumaAt(0, 0, 0))
  })

  it('rejects a six-byte SPS prefix as a visible picture', () => {
    expect(() => {
      assertRecognizableH264Picture(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]))
    }).toThrow(/no PPS NAL/)
  })
})
