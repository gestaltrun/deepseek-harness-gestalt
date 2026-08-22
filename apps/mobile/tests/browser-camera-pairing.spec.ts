// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCameraPairingQrScanner } from '../src/personal-pairing.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BrowserCameraPairingQrScanner', () => {
  it('reads one complete QR payload from the browser camera and releases every track', async () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const getUserMedia = vi.fn(async () => stream)
    const link = 'https://platform.example/pair?challenge=complete-high-entropy-payload'
    const stopDecoder = vi.fn()
    const scan = vi.fn((_video, callback: BrowserScanCallback) => {
      callback({ getText: () => link }, undefined, { stop: stopDecoder })
      return { stop: stopDecoder }
    })
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      reader: { scan },
    })
    const video = document.createElement('video')
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()

    await expect(scanner.scan(video)).resolves.toBe(link)

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    })
    expect(scan).toHaveBeenCalledWith(video, expect.any(Function), expect.any(Function))
    expect(stopDecoder).toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
  })

  it('fails explicitly when browser camera APIs are unavailable', async () => {
    const scanner = new BrowserCameraPairingQrScanner({
      reader: { scan: vi.fn() },
    })

    await expect(scanner.scan(document.createElement('video')))
      .rejects.toThrow('Camera scanning is not supported by this browser')
  })

  it('reports camera denial without starting the QR decoder', async () => {
    const denial = new DOMException('denied', 'NotAllowedError')
    const scan = vi.fn()
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: {
        getUserMedia: vi.fn(async () => await Promise.reject(denial)),
      } as unknown as MediaDevices,
      reader: { scan },
    })

    await expect(scanner.scan(document.createElement('video')))
      .rejects.toThrow('Camera permission was denied')
    expect(scan).not.toHaveBeenCalled()
  })

  it('settles cancellation while camera permission is pending and stops every late track', async () => {
    const permission = deferred<MediaStream>()
    const stopFirst = vi.fn()
    const stopSecond = vi.fn()
    const controller = new AbortController()
    const scan = vi.fn()
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: {
        getUserMedia: vi.fn(async () => await permission.promise),
      } as unknown as MediaDevices,
      reader: { scan },
    })
    const scanning = scanner.scan(document.createElement('video'), controller.signal)

    controller.abort()

    await expect(scanning).rejects.toThrow('camera scan was cancelled')
    permission.resolve({ getTracks: () => [{ stop: stopFirst }, { stop: stopSecond }] } as unknown as MediaStream)
    await Promise.resolve()
    await Promise.resolve()
    expect(stopFirst).toHaveBeenCalledOnce()
    expect(stopSecond).toHaveBeenCalledOnce()
    expect(scan).not.toHaveBeenCalled()
  })

  it('rejects an empty decoded QR value and releases the camera', async () => {
    const stop = vi.fn()
    const stopDecoder = vi.fn()
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] } as unknown as MediaStream)),
      } as unknown as MediaDevices,
      reader: {
        scan: vi.fn((_video, callback: BrowserScanCallback) => {
          callback({ getText: () => '' }, undefined, { stop: stopDecoder })
          return { stop: stopDecoder }
        }),
      },
    })
    const video = document.createElement('video')
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()

    await expect(scanner.scan(video))
      .rejects.toThrow('QR payload must be non-empty')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('stops the decoder retry loop and media tracks before cancellation settles', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const controller = new AbortController()
    let retries = 0
    let retryTimer: ReturnType<typeof setInterval> | undefined
    const stopDecoder = vi.fn(() => { clearInterval(retryTimer) })
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] } as unknown as MediaStream)),
      } as unknown as MediaDevices,
      reader: { scan: vi.fn(() => {
        retryTimer = setInterval(() => { retries += 1 }, 10)
        return { stop: stopDecoder }
      }) },
    })
    const video = document.createElement('video')
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()
    const scanning = scanner.scan(video, controller.signal)
    await vi.advanceTimersByTimeAsync(25)
    const retriesBeforeAbort = retries

    controller.abort()

    await expect(scanning).rejects.toThrow('camera scan was cancelled')
    await vi.advanceTimersByTimeAsync(100)
    expect(retries).toBe(retriesBeforeAbort)
    expect(stopDecoder).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })

  it('quiesces the real ZXing retry scheduler when the view unmounts', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const drawImage = vi.fn()
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(16 * 16 * 4) }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      drawImage,
      getImageData,
    }) as unknown as CanvasRenderingContext2D)
    const scanner = new BrowserCameraPairingQrScanner({
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] } as unknown as MediaStream)),
      } as unknown as MediaDevices,
    })
    const video = document.createElement('video')
    Object.defineProperties(video, {
      videoWidth: { value: 16 },
      videoHeight: { value: 16 },
    })
    video.play = vi.fn(async () => undefined)
    video.pause = vi.fn()
    const controller = new AbortController()
    const scanning = scanner.scan(video, controller.signal)
    await vi.advanceTimersByTimeAsync(1)
    expect(drawImage).toHaveBeenCalled()
    const attemptsBeforeUnmount = drawImage.mock.calls.length

    controller.abort()

    await expect(scanning).rejects.toThrow('camera scan was cancelled')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(drawImage).toHaveBeenCalledTimes(attemptsBeforeUnmount)
    expect(stop).toHaveBeenCalled()
  })
})

type BrowserScanCallback = (
  result: { getText(): string } | undefined,
  error: Error | undefined,
  controls: { stop(): void },
) => void

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
