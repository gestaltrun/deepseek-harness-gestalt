import { describe, expect, it } from 'vitest'
import { isPng, PNG_SIGNATURE } from '../src/png.ts'
import { buildGradientPng } from './fixtures/u3-visible-frames.ts'

describe('PNG signature recognition', () => {
  it('accepts a complete PNG and rejects a truncated or foreign prefix', () => {
    expect(isPng(buildGradientPng(0))).toBe(true)
    expect(isPng(PNG_SIGNATURE)).toBe(true)
    expect(isPng(PNG_SIGNATURE.subarray(0, 4))).toBe(false)
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(false)
  })
})
