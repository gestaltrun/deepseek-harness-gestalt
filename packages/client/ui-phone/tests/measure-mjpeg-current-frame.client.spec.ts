// @vitest-environment jsdom
/**
 * `createImageBitmap` reports the JPEG painted now; `naturalWidth` is not
 * consulted because Chromium freezes it on the first multipart frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureMjpegCurrentFrame } from '../src/client/measure-mjpeg-current-frame.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function img(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  const element = document.createElement('img')
  Object.defineProperties(element, {
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  })
  return element
}

describe('measureMjpegCurrentFrame', () => {
  it('returns the current bitmap size when naturalWidth stays at the first JPEG', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2400, height: 1080, close })))
    await expect(measureMjpegCurrentFrame(img(1080, 2400))).resolves.toEqual({
      width: 2400, height: 1080,
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns undefined when createImageBitmap is missing', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    await expect(measureMjpegCurrentFrame(img(1080, 2400))).resolves.toBeUndefined()
  })

  it('returns undefined when createImageBitmap rejects', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      throw new Error('no bitmap')
    }))
    await expect(measureMjpegCurrentFrame(img(1080, 2400))).resolves.toBeUndefined()
  })

  it('returns undefined for a non-positive bitmap and still closes it', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 0, height: 1080, close })))
    await expect(measureMjpegCurrentFrame(img(1080, 2400))).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns undefined for a non-finite bitmap and still closes it', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: Number.NaN, height: 1080, close })))
    await expect(measureMjpegCurrentFrame(img(1080, 2400))).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })
})
