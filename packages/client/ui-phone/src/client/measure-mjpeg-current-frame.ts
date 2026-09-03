/**
 * Current JPEG size of a live MJPEG `<img>`. Chromium keeps
 * `naturalWidth`/`naturalHeight` at the first `multipart/x-mixed-replace`
 * JPEG; `createImageBitmap` reports the bitmap that is painted now.
 */

/** Device-pixel size of one MJPEG JPEG. */
export interface MjpegCurrentFrameSize {
  readonly width: number
  readonly height: number
}

/**
 * Measure the JPEG currently painted by `img`.
 * @param img - Live MJPEG image element.
 * @returns Current bitmap size, or `undefined` when no current JPEG is readable.
 */
export async function measureMjpegCurrentFrame(
  img: HTMLImageElement,
): Promise<MjpegCurrentFrameSize | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(img)
  } catch {
    // No current JPEG bitmap yet (poll before first paint) or a tainted
    // source. The caller retries on the next cadence.
    return undefined
  }
  const { width, height } = bitmap
  bitmap.close()
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return { width, height }
}
