import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPhoneRuntimeSource } from '../src/client/phone-runtime-source.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function snapshot(runtime: unknown, revision = 1, platforms: unknown = {
  android: { kind: 'deferred' }, ios: { kind: 'deferred' },
}): Response {
  return new Response(JSON.stringify({ revision, enabled: true, runtime, platforms }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('Host phone runtime source', () => {
  it('projects iOS preparation plans and invokes the trusted managed operation', async () => {
    const plan = {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
      simulatorName: 'DSH Gestalt iPhone',
      runtime: { identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', isAvailable: true },
      deviceType: { identifier: 'type-iphone-17', name: 'iPhone 17' },
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 2,
      { android: { kind: 'deferred' }, ios: { kind: 'no-simulator', plan: {
        ...plan, runtime: { ...plan.runtime, available: true },
      } } },
    ))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    await source.prepareIos()
    expect(source.getSnapshot().platforms.ios).toMatchObject({
      kind: 'no-simulator', plan: { simulatorName: 'DSH Gestalt iPhone', runtime: { version: '26.0' } },
    })
    expect(fetcher).toHaveBeenCalledWith('/phone/environment/ios/prepare', expect.objectContaining({ method: 'POST' }))
  })

  it('projects Android plans and sends explicit license consent to the trusted Host operation', async () => {
    const plan = {
      sdkRoot: '/dsh/phone/android/sdk', sdkSource: 'managed', avdHome: '/dsh/phone/android/avd',
      avdName: 'Pixel_6_API_35_Gestalt', abi: 'arm64-v8a', commandLineToolsVersion: '15859902',
      commandLineToolsBytes: 156_083_281,
      packageIds: ['platform-tools', 'emulator', 'system-images;android-35;google_apis;arm64-v8a'],
      minimumFreeBytes: 16 * 1024 ** 3, licenseUrl: 'https://developer.android.com/studio/terms',
      components: { commandLineTools: false, platformTools: false, emulator: false, systemImage: false, avd: false },
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' },
      2,
      { android: { kind: 'missing', plan }, ios: { kind: 'deferred' } },
    ))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    await source.prepareAndroid()
    expect(source.getSnapshot().platforms.android).toMatchObject({
      kind: 'missing', plan: { avdName: 'Pixel_6_API_35_Gestalt', abi: 'arm64-v8a' },
    })
    expect(fetcher).toHaveBeenCalledWith('/phone/environment/android/prepare', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ licenseAccepted: true }),
    }))
  })

  it('projects full snapshots and invokes prepare, cancel, and refresh paths', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 }))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 2))
      .mockResolvedValueOnce(snapshot({ kind: 'verifying', targetVersion: '1.0.5' }, 3))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 4))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    const changed = vi.fn()
    source.subscribe(changed)

    await source.refresh()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 })
    await source.prepare()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
    await source.cancel()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'verifying', targetVersion: '1.0.5' })
    await source.refresh()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
    expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/phone/environment/refresh', 'POST'],
      ['/phone/environment/prepare', 'POST'],
      ['/phone/environment/cancel', 'POST'],
      ['/phone/environment/refresh', 'POST'],
    ])
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('preserves platform state, rejects stale responses, and isolates subscriber failures', async () => {
    let finishOlder!: (response: Response) => void
    const older = new Promise<Response>((resolve) => { finishOlder = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => await older)
      .mockResolvedValueOnce(snapshot(
        { kind: 'ready', version: '1.0.5', source: 'managed' },
        8,
        { android: { kind: 'deferred' }, ios: { kind: 'unsupported', reason: 'iOS simulators require macOS and Xcode.' } },
      )))
    const listenerError = vi.fn()
    const source = createHttpPhoneRuntimeSource(listenerError)
    const first = source.cancel()
    const later = source.prepare()
    source.subscribe(() => { throw new Error('broken renderer subscriber') })
    const survivor = vi.fn()
    source.subscribe(survivor)
    await later
    finishOlder(snapshot({ kind: 'failed', targetVersion: '1.0.5', code: 'OLD', message: 'stale' }, 7))
    await first
    expect(source.getSnapshot()).toMatchObject({
      revision: 8,
      runtime: { kind: 'ready' },
      platforms: { ios: { kind: 'unsupported', reason: 'iOS simulators require macOS and Xcode.' } },
    })
    expect(survivor).toHaveBeenCalledOnce()
    expect(listenerError).toHaveBeenCalledOnce()
  })

  it('polls the full snapshot while managed preparation is in flight', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const preparing = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/phone/environment/prepare') return await preparing
      return snapshot({ kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 50, totalBytes: 100 })
    })
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    const operation = source.prepare()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().runtime).toEqual({
      kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 50, totalBytes: 100,
    })
    finish(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 2))
    await operation
    expect(source.getSnapshot().runtime).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
  })

  it('rejects invalid runtime snapshots and reports Host operation failures', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: 5, source: 'managed' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'download blocked' } }), { status: 502 })))
    const source = createHttpPhoneRuntimeSource()
    await expect(source.refresh()).rejects.toThrow(/invalid runtime state/)
    await expect(source.prepare()).rejects.toThrow('download blocked')
  })
})
