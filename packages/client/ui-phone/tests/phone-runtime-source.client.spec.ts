import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPhoneRuntimeSource } from '../src/client/phone-runtime-source.ts'

const ANDROID_PLAN = {
  sdkRoot: '/dsh/phone/android/sdk', sdkSource: 'managed', avdHome: '/dsh/phone/android/avd',
  avdName: 'Pixel_6_API_35_Gestalt', abi: 'arm64-v8a', commandLineToolsVersion: '15859902',
  commandLineToolsBytes: 156_083_281,
  packageIds: ['platform-tools', 'emulator', 'system-images;android-35;google_apis;arm64-v8a'],
  minimumFreeBytes: 16 * 1024 ** 3, licenseUrl: 'https://developer.android.com/studio/terms',
  components: { commandLineTools: false, platformTools: false, emulator: false, systemImage: false, avd: false },
} as const

const IOS_PLAN = {
  developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
  simulatorName: 'DSH Gestalt iPhone',
  runtime: { identifier: 'runtime-26', name: 'iOS 26.0', version: '26.0', available: true },
  deviceType: { identifier: 'type-iphone-17', name: 'iPhone 17' },
} as const

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
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 2,
      { android: { kind: 'deferred' }, ios: { kind: 'no-simulator', plan: {
        ...plan, runtime: { ...plan.runtime, available: true },
      } } },
    ))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    await source.prepareIos()
    await source.cancelIos()
    await source.refreshIos()
    await source.startIos()
    expect(source.getSnapshot().platforms.ios).toMatchObject({
      kind: 'no-simulator', plan: { simulatorName: 'DSH Gestalt iPhone', runtime: { version: '26.0' } },
    })
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/phone/environment/ios/prepare',
      '/phone/environment/ios/cancel',
      '/phone/environment/ios/refresh',
      '/phone/environment/ios/start',
    ])
  })

  it('projects Android plans and sends explicit license consent to the trusted Host operation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' },
      2,
      { android: { kind: 'missing', plan: ANDROID_PLAN }, ios: { kind: 'deferred' } },
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

  it('deduplicates active detection and releases it after success and failure', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => await pending)
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    source.ensureDetected()
    source.ensureDetected()
    const joined = source.refresh()
    expect(fetcher).toHaveBeenCalledOnce()
    finish(snapshot({ kind: 'missing', targetVersion: '1.0.5' }))
    await joined
    source.ensureDetected()
    expect(fetcher).toHaveBeenCalledOnce()

    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await expect(source.refresh()).rejects.toThrow('phone environment request failed with HTTP 503')
    fetcher.mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'system' }, 2))
    await source.refresh()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'ready', version: '1.0.5', source: 'system' })
  })

  it('keeps detecting while Host startup activation is in flight', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({
        kind: 'activating', targetVersion: '1.0.5', source: 'override',
      }))
      .mockResolvedValueOnce(snapshot({
        kind: 'ready', version: '1.0.5', source: 'override',
      }, 2))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    source.ensureDetected()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().runtime).toEqual({
      kind: 'activating', targetVersion: '1.0.5', source: 'override',
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(source.getSnapshot().runtime).toEqual({
      kind: 'ready', version: '1.0.5', source: 'override',
    })
    expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/phone/environment', 'GET'],
      ['/phone/environment', 'GET'],
    ])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces passive polling with an active refresh and clears the pending timer at readiness', async () => {
    vi.useFakeTimers()
    let finishRefresh!: (response: Response) => void
    const refreshResponse = new Promise<Response>((resolve) => { finishRefresh = resolve })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'activating', targetVersion: '1.0.5', source: 'override' }))
      .mockImplementationOnce(async () => await refreshResponse)
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'override' }, 3))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    source.ensureDetected()
    await vi.advanceTimersByTimeAsync(0)
    const refresh = source.refresh()
    await vi.advanceTimersByTimeAsync(100)
    finishRefresh(snapshot({ kind: 'activating', targetVersion: '1.0.5', source: 'override' }, 2))
    await refresh
    await vi.advanceTimersByTimeAsync(100)

    expect(source.getSnapshot().runtime.kind).toBe('ready')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('retries passive polling after a transient Host request failure', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'activating', targetVersion: '1.0.5', source: 'override' }))
      .mockRejectedValueOnce(new Error('temporary Host restart'))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'override' }, 2))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    source.ensureDetected()
    await vi.advanceTimersByTimeAsync(200)

    expect(source.getSnapshot().runtime.kind).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('clears passive polling and ignores a late response after disposal', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    let signal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_path, init) => {
      signal = init?.signal ?? undefined
      return await pending
    })
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    const listener = vi.fn()
    source.subscribe(listener)

    source.ensureDetected()
    expect(fetcher).toHaveBeenCalledOnce()
    source.dispose()
    expect(signal?.aborted).toBe(true)

    finish(snapshot({ kind: 'activating', targetVersion: '1.0.5', source: 'override' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.getSnapshot().revision).toBe(-1)
    expect(listener).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    source.ensureDetected()
    await expect(source.refresh()).rejects.toThrow('phone runtime source is disposed')
    await expect(source.prepare()).rejects.toThrow('phone runtime source is disposed')
    await expect(source.cancel()).rejects.toThrow('phone runtime source is disposed')
    await expect(source.prepareIos()).rejects.toThrow('phone runtime source is disposed')
    const disposedListener = vi.fn()
    source.subscribe(disposedListener)()
    expect(disposedListener).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('ignores a response body that finishes parsing after disposal', async () => {
    let finishBody!: (body: unknown) => void
    const body = new Promise<unknown>((resolve) => { finishBody = resolve })
    const response = new Response('{}')
    const parse = vi.spyOn(response, 'json').mockImplementation(async () => await body)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(response))
    const source = createHttpPhoneRuntimeSource()

    const refresh = source.refresh()
    await vi.waitFor(() => { expect(parse).toHaveBeenCalledOnce() })
    source.dispose()
    finishBody({
      revision: 1,
      enabled: true,
      runtime: { kind: 'ready', version: '1.0.5', source: 'managed' },
      platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
    })

    await expect(refresh).resolves.toBeUndefined()
    expect(source.getSnapshot().revision).toBe(-1)
  })

  it('aborts polled operation requests and clears all timers with one lifecycle abort', async () => {
    vi.useFakeTimers()
    const responses: Array<(response: Response) => void> = []
    const signals: AbortSignal[] = []
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_path, init) => {
      if (init?.signal != null) signals.push(init.signal)
      return await new Promise<Response>((resolve) => { responses.push(resolve) })
    })
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    const operation = source.prepare()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    responses[1]!(snapshot({
      kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 1, totalBytes: 2,
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetcher).toHaveBeenCalledTimes(3)

    source.dispose()
    source.dispose()
    expect(signals).toHaveLength(3)
    expect(new Set(signals).size).toBe(1)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    responses[2]!(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 3))
    responses[0]!(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 2))
    await expect(operation).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.getSnapshot()).toMatchObject({ revision: 1, runtime: { kind: 'downloading' } })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('clears an operation timer before its first poll can start', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => await new Promise<Response>(
      (resolve) => { finish = resolve },
    )))
    const source = createHttpPhoneRuntimeSource()

    const operation = source.prepare()
    expect(vi.getTimerCount()).toBe(1)
    source.dispose()
    expect(vi.getTimerCount()).toBe(0)
    finish(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }))
    await expect(operation).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('joins preparation to an already active Host request', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => await pending)
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    const refresh = source.refresh()
    const prepare = source.prepare()
    expect(fetcher).toHaveBeenCalledOnce()
    finish(snapshot({ kind: 'missing', targetVersion: '1.0.5' }))
    await expect(Promise.all([refresh, prepare])).resolves.toEqual([undefined, undefined])
  })

  it('contains a default-reported subscriber failure and removes unsubscribed listeners', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'override' })))
    const source = createHttpPhoneRuntimeSource()
    source.subscribe(() => { throw new Error('bad subscriber') })
    const removed = vi.fn()
    const unsubscribe = source.subscribe(removed)
    unsubscribe()

    await source.refresh()
    expect(report).toHaveBeenCalledWith('phone runtime subscriber failed', expect.any(Error))
    expect(removed).not.toHaveBeenCalled()
  })

  it('continues polling after a transient refresh failure and stops stale poll callbacks', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const preparing = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === '/phone/environment/prepare') return await preparing
      throw new Error('transient poll failure')
    })
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    const operation = source.prepare()
    await vi.advanceTimersByTimeAsync(100)
    expect(fetcher).toHaveBeenCalledTimes(3)
    finish(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 2))
    await operation
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([
    null,
    [],
    { revision: '1', enabled: true, runtime: {}, platforms: {} },
    { revision: 1, enabled: 'yes', runtime: {}, platforms: {} },
    { revision: 1, enabled: true, runtime: null, platforms: {} },
    { revision: 1, enabled: true, runtime: {}, platforms: null },
  ])('rejects a non-snapshot Host response %#', async (body) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(body))))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow('not a full revisioned snapshot')
  })

  it.each([
    [{ kind: 'missing', targetVersion: '1.0.5' }, { kind: 'missing', targetVersion: '1.0.5' }],
    [{ kind: 'missing', targetVersion: '1.0.5', assetBytes: 0 }, { kind: 'missing', targetVersion: '1.0.5', assetBytes: 0 }],
    [{ kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 0, totalBytes: 1 },
      { kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 0, totalBytes: 1 }],
    [{ kind: 'verifying', targetVersion: '1.0.5' }, { kind: 'verifying', targetVersion: '1.0.5' }],
    [{ kind: 'activating', targetVersion: '1.0.5', source: 'managed' },
      { kind: 'activating', targetVersion: '1.0.5', source: 'managed' }],
    [{ kind: 'ready', version: '1.0.5', source: 'override' }, { kind: 'ready', version: '1.0.5', source: 'override' }],
    [{ kind: 'failed', targetVersion: '1.0.5', code: 'BROKEN', message: 'broken' },
      { kind: 'failed', targetVersion: '1.0.5', code: 'BROKEN', message: 'broken' }],
  ] as const)('accepts runtime state %#', async (runtime, expected) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(runtime)))
    const source = createHttpPhoneRuntimeSource()
    await source.refresh()
    expect(source.getSnapshot().runtime).toEqual(expected)
  })

  it.each([
    { kind: 'missing', targetVersion: 1 },
    { kind: 'downloading', targetVersion: 1, receivedBytes: 0, totalBytes: 1 },
    { kind: 'downloading', targetVersion: '1.0.5', receivedBytes: '0', totalBytes: 1 },
    { kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 0, totalBytes: '1' },
    { kind: 'verifying', targetVersion: 1 },
    { kind: 'activating', targetVersion: 1, source: 'managed' },
    { kind: 'activating', targetVersion: '1.0.5', source: 'other' },
    { kind: 'ready', version: 1, source: 'managed' },
    { kind: 'ready', version: '1.0.5', source: 'other' },
    { kind: 'failed', targetVersion: 1, code: 'BROKEN', message: 'broken' },
    { kind: 'failed', targetVersion: '1.0.5', code: 1, message: 'broken' },
    { kind: 'failed', targetVersion: '1.0.5', code: 'BROKEN', message: 1 },
    { kind: 'other' },
  ])('rejects invalid runtime state %#', async (runtime) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(runtime)))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow('invalid runtime state')
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('omits invalid optional asset byte count %#', async (assetBytes) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot({
      kind: 'missing', targetVersion: '1.0.5', assetBytes,
    })))
    const source = createHttpPhoneRuntimeSource()
    await source.refresh()
    expect(source.getSnapshot().runtime).toEqual({ kind: 'missing', targetVersion: '1.0.5' })
  })

  it.each([
    [null, 'invalid Android state'],
    [[], 'invalid Android state'],
    [{ kind: 'unsupported', reason: 1 }, 'invalid Android plan'],
    [{ kind: 'other' }, 'invalid Android plan'],
  ])('rejects invalid platform state %#', async (android, expectedMessage) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'missing', targetVersion: '1.0.5' },
      1,
      { android, ios: { kind: 'deferred' } },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow(expectedMessage)
  })

  it.each([
    [null, 'invalid iOS state'],
    [[], 'invalid iOS state'],
    [{ kind: 'unsupported', reason: 1 }, 'invalid platform state'],
    [{ kind: 'other' }, 'invalid iOS plan'],
  ])('rejects invalid iOS platform state %#', async (ios, expectedMessage) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'missing', targetVersion: '1.0.5' },
      1,
      { android: { kind: 'deferred' }, ios },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow(expectedMessage)
  })

  it.each([
    { kind: 'deferred' },
    { kind: 'unsupported', reason: 'macOS required' },
    { kind: 'checking' },
    { kind: 'checking', operation: 'prepare' },
    { kind: 'xcode-missing', message: 'install Xcode' },
    { kind: 'license-required', developerDir: IOS_PLAN.developerDir, message: 'accept license' },
    { kind: 'manual-required', code: 'first-launch', message: 'finish launch' },
    { kind: 'manual-required', code: 'xcode-update', message: 'update Xcode', developerDir: IOS_PLAN.developerDir },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: false },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: true, plan: IOS_PLAN },
    { kind: 'runtime-missing', plan: IOS_PLAN },
    { kind: 'runtime-missing', plan: {
      developerDir: IOS_PLAN.developerDir,
      xcodeVersion: IOS_PLAN.xcodeVersion,
      simulatorName: IOS_PLAN.simulatorName,
    } },
    { kind: 'no-simulator', plan: IOS_PLAN },
    { kind: 'preparing', plan: IOS_PLAN, step: 'downloading-runtime' },
    { kind: 'preparing', plan: IOS_PLAN, step: 'creating-simulator' },
    { kind: 'preparing', plan: IOS_PLAN, step: 'booting' },
    { kind: 'ready', plan: IOS_PLAN, deviceId: 'ios-simulator-1', running: false },
  ])('accepts iOS state %#', async (ios) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android: { kind: 'deferred' }, ios },
    )))
    const source = createHttpPhoneRuntimeSource()
    await source.refresh()
    expect(source.getSnapshot().platforms.ios).toMatchObject(ios)
  })

  it.each([
    [{}, 'invalid iOS state'],
    [{ kind: 'checking', operation: 'refresh' }, 'invalid iOS state'],
    [{ kind: 'xcode-missing', message: 1 }, 'invalid iOS plan'],
    [{ kind: 'license-required', developerDir: 1, message: 'accept' }, 'invalid iOS plan'],
    [{ kind: 'license-required', developerDir: IOS_PLAN.developerDir, message: 1 }, 'invalid iOS plan'],
    [{ kind: 'manual-required', code: 'other', message: 'manual' }, 'invalid iOS plan'],
    [{ kind: 'manual-required', code: 'first-launch', message: 1 }, 'invalid iOS plan'],
    [{ kind: 'manual-required', code: 'first-launch', message: 'manual', developerDir: 1 }, 'invalid iOS plan'],
    [{ kind: 'failed', code: 1, message: 'failed', retryable: true }, 'invalid iOS plan'],
    [{ kind: 'failed', code: 'BROKEN', message: 1, retryable: true }, 'invalid iOS plan'],
    [{ kind: 'failed', code: 'BROKEN', message: 'failed', retryable: 'yes' }, 'invalid iOS plan'],
    [{ kind: 'failed', code: 'BROKEN', message: 'failed', retryable: true, plan: {} }, 'invalid iOS plan'],
    [{ kind: 'preparing', plan: IOS_PLAN, step: 'other' }, 'invalid iOS state'],
    [{ kind: 'ready', plan: IOS_PLAN, deviceId: 1, running: false }, 'invalid iOS state'],
    [{ kind: 'ready', plan: IOS_PLAN, deviceId: 'ios-simulator-1', running: 'yes' }, 'invalid iOS state'],
    [{ kind: 'other', plan: IOS_PLAN }, 'invalid iOS state'],
  ])('rejects malformed iOS state %#', async (ios, expectedMessage) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android: { kind: 'deferred' }, ios },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow(expectedMessage)
  })

  it.each([
    [{ ...IOS_PLAN, developerDir: 1 }, 'invalid iOS plan'],
    [{ ...IOS_PLAN, xcodeVersion: 1 }, 'invalid iOS plan'],
    [{ ...IOS_PLAN, simulatorName: 1 }, 'invalid iOS plan'],
    [{ ...IOS_PLAN, runtime: null }, 'invalid iOS runtime'],
    [{ ...IOS_PLAN, runtime: { ...IOS_PLAN.runtime, identifier: 1 } }, 'invalid iOS runtime'],
    [{ ...IOS_PLAN, runtime: { ...IOS_PLAN.runtime, name: 1 } }, 'invalid iOS runtime'],
    [{ ...IOS_PLAN, runtime: { ...IOS_PLAN.runtime, version: 1 } }, 'invalid iOS runtime'],
    [{ ...IOS_PLAN, runtime: { ...IOS_PLAN.runtime, available: false } }, 'invalid iOS runtime'],
    [{ ...IOS_PLAN, deviceType: null }, 'invalid iOS device type'],
    [{ ...IOS_PLAN, deviceType: { ...IOS_PLAN.deviceType, identifier: 1 } }, 'invalid iOS device type'],
    [{ ...IOS_PLAN, deviceType: { ...IOS_PLAN.deviceType, name: 1 } }, 'invalid iOS device type'],
  ])('rejects malformed iOS plan %#', async (plan, expectedMessage) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android: { kind: 'deferred' }, ios: { kind: 'runtime-missing', plan } },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow(expectedMessage)
  })

  it('invokes every Android operation, omits absent bodies, and joins an active operation', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => await pending)
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 2))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 3))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 4))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()

    const refreshing = source.refreshAndroid()
    const joined = source.startAndroid()
    expect(fetcher).toHaveBeenCalledOnce()
    finish(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }))
    await Promise.all([refreshing, joined])
    await source.cancelAndroid()
    await source.refreshAndroid()
    await source.startAndroid()
    expect(fetcher.mock.calls.slice(1).map(([path, init]) => [path, init?.body])).toEqual([
      ['/phone/environment/android/cancel', undefined],
      ['/phone/environment/android/refresh', undefined],
      ['/phone/environment/android/start', undefined],
    ])
  })

  it('reports Android operation failures and ignores a stale operation snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }, 5))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Android unavailable' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 502 }))
      .mockResolvedValueOnce(snapshot({ kind: 'failed', targetVersion: '1.0.5', code: 'STALE', message: 'stale' }, 4))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    await source.cancelAndroid()
    await expect(source.refreshAndroid()).rejects.toThrow('Android unavailable')
    await expect(source.startAndroid()).rejects.toThrow('phone environment request failed with HTTP 502')
    await source.cancelAndroid()
    expect(source.getSnapshot().revision).toBe(5)
  })

  it.each([
    { kind: 'deferred' },
    { kind: 'unsupported', reason: 'unsupported host' },
    { kind: 'checking' },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: false },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: true, plan: ANDROID_PLAN },
    { kind: 'missing', plan: ANDROID_PLAN },
    { kind: 'awaiting-license', plan: ANDROID_PLAN },
    { kind: 'downloading', plan: ANDROID_PLAN, receivedBytes: 0, totalBytes: 1 },
    { kind: 'installing', plan: ANDROID_PLAN, step: 'licenses' },
    { kind: 'installing', plan: ANDROID_PLAN, step: 'packages' },
    { kind: 'creating-avd', plan: ANDROID_PLAN },
    { kind: 'checking-acceleration', plan: ANDROID_PLAN },
    { kind: 'booting', plan: ANDROID_PLAN },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'disk-space', message: 'manual' },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'windows-hypervisor', message: 'manual' },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'linux-kvm', message: 'manual' },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'virtualization', message: 'manual' },
    { kind: 'ready', plan: ANDROID_PLAN, running: false },
    { kind: 'ready', plan: ANDROID_PLAN, running: true, deviceId: 'emulator-5554' },
  ])('accepts Android state %#', async (android) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' },
      1,
      { android, ios: { kind: 'deferred' } },
    )))
    const source = createHttpPhoneRuntimeSource()
    await source.refresh()
    expect(source.getSnapshot().platforms.android).toMatchObject(android)
  })

  it('accepts an existing x86 Android plan with every component installed', async () => {
    const existing = {
      ...ANDROID_PLAN,
      sdkSource: 'existing',
      abi: 'x86_64',
      components: { commandLineTools: true, platformTools: true, emulator: true, systemImage: true, avd: true },
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android: { kind: 'ready', plan: existing, running: false }, ios: { kind: 'deferred' } },
    )))
    const source = createHttpPhoneRuntimeSource()
    await source.refresh()
    expect(source.getSnapshot().platforms.android).toMatchObject({ kind: 'ready', plan: existing })
  })

  it.each([
    null,
    [],
    {},
    { kind: 1 },
    { kind: 'unsupported', reason: 1 },
    { kind: 'failed', code: 1, message: 'failed', retryable: true },
    { kind: 'failed', code: 'BROKEN', message: 1, retryable: true },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: 'yes' },
    { kind: 'failed', code: 'BROKEN', message: 'failed', retryable: true, plan: {} },
    { kind: 'downloading', plan: ANDROID_PLAN, receivedBytes: '0', totalBytes: 1 },
    { kind: 'downloading', plan: ANDROID_PLAN, receivedBytes: 0, totalBytes: '1' },
    { kind: 'installing', plan: ANDROID_PLAN, step: 'other' },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'other', message: 'manual' },
    { kind: 'manual-required', plan: ANDROID_PLAN, code: 'disk-space', message: 1 },
    { kind: 'ready', plan: ANDROID_PLAN, running: 'yes' },
    { kind: 'ready', plan: ANDROID_PLAN, running: true, deviceId: 1 },
    { kind: 'other', plan: ANDROID_PLAN },
  ])('rejects invalid Android state %#', async (android) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android, ios: { kind: 'deferred' } },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow(/invalid Android/)
  })

  it.each([
    null,
    { ...ANDROID_PLAN, sdkRoot: 1 },
    { ...ANDROID_PLAN, sdkSource: 'other' },
    { ...ANDROID_PLAN, avdHome: 1 },
    { ...ANDROID_PLAN, avdName: 1 },
    { ...ANDROID_PLAN, abi: 'other' },
    { ...ANDROID_PLAN, commandLineToolsVersion: 1 },
    { ...ANDROID_PLAN, commandLineToolsBytes: -1 },
    { ...ANDROID_PLAN, packageIds: 'platform-tools' },
    { ...ANDROID_PLAN, packageIds: [1] },
    { ...ANDROID_PLAN, minimumFreeBytes: -1 },
    { ...ANDROID_PLAN, licenseUrl: 1 },
    { ...ANDROID_PLAN, components: null },
  ])('rejects invalid Android plan %#', async (plan) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
      { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
      { android: { kind: 'missing', plan }, ios: { kind: 'deferred' } },
    )))
    await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow('invalid Android plan')
  })

  it.each(['commandLineTools', 'platformTools', 'emulator', 'systemImage', 'avd'] as const)(
    'rejects non-boolean Android component %s',
    async (component) => {
      const plan = { ...ANDROID_PLAN, components: { ...ANDROID_PLAN.components, [component]: 'yes' } }
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(snapshot(
        { kind: 'ready', version: '1.0.5', source: 'managed' }, 1,
        { android: { kind: 'missing', plan }, ios: { kind: 'deferred' } },
      )))
      await expect(createHttpPhoneRuntimeSource().refresh()).rejects.toThrow('invalid Android components')
    },
  )
})
