import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPhoneRuntimeSource } from '../src/client/phone-runtime-source.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function snapshot(runtime: unknown): Response {
  return new Response(JSON.stringify({ revision: 1, enabled: true, runtime, platforms: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

describe('Host phone runtime source', () => {
  it('projects full snapshots and invokes prepare, cancel, and refresh paths', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot({ kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 }))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }))
      .mockResolvedValueOnce(snapshot({ kind: 'verifying', targetVersion: '1.0.5' }))
      .mockResolvedValueOnce(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }))
    vi.stubGlobal('fetch', fetcher)
    const source = createHttpPhoneRuntimeSource()
    const changed = vi.fn()
    source.subscribe(changed)

    await source.refresh()
    expect(source.getRuntime()).toEqual({ kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 })
    await source.prepare()
    expect(source.getRuntime()).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
    await source.cancel()
    expect(source.getRuntime()).toEqual({ kind: 'verifying', targetVersion: '1.0.5' })
    await source.refresh()
    expect(source.getRuntime()).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
    expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/phone/environment', 'GET'],
      ['/phone/environment/prepare', 'POST'],
      ['/phone/environment/cancel', 'POST'],
      ['/phone/environment', 'GET'],
    ])
    expect(changed).toHaveBeenCalledTimes(4)
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
    expect(source.getRuntime()).toEqual({
      kind: 'downloading', targetVersion: '1.0.5', receivedBytes: 50, totalBytes: 100,
    })
    finish(snapshot({ kind: 'ready', version: '1.0.5', source: 'managed' }))
    await operation
    expect(source.getRuntime()).toEqual({ kind: 'ready', version: '1.0.5', source: 'managed' })
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
