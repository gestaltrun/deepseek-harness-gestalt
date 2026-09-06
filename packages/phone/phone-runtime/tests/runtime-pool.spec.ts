import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, PhoneDevicesError } from '../src/index.ts'
import {
  createPhoneRuntimePool,
  type PhoneRuntimeAdapter,
  type PhoneRuntimeGeneration,
  type PhoneRuntimePool,
  type PhoneRuntimeSlotConfig,
  type PhoneRuntimeStart,
} from '../src/runtime-pool.ts'
import { stageFake, wireDevice } from './helpers.ts'
import type {
  DeviceId,
  PhoneAgentInstallOptions,
  PhoneCaptureRequest,
  PhoneDeviceList,
  PhoneIoRequest,
} from '../src/types.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []
const pools: PhoneRuntimePool[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map(async pool => pool.dispose().catch(() => {})))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

const EMPTY_LIST: PhoneDeviceList = { android: [], ios: { simulators: [], reals: [] } }

function stubGeneration(label: string): PhoneRuntimeGeneration {
  return {
    listDevices: async () => EMPTY_LIST,
    boot: async () => {},
    shutdown: async () => {},
    io: async () => {},
    startCapture: async () => ({ contentType: 'application/octet-stream', body: new ReadableStream() }),
    screenshot: async () => ({ mediaType: 'image/png', path: `/tmp/${label}.png` }),
    agentStatus: async id => ({ deviceId: id, installed: false }),
    installAgent: async (id, _options?: PhoneAgentInstallOptions) => ({
      deviceId: id,
      installed: true,
      reinstalled: false,
    }),
    isReady: () => true,
    onReadinessChanged: () => () => {},
    onChanged: () => () => {},
  }
}

interface ControlledStart {
  readonly promise: Promise<PhoneRuntimeStart>
  readonly start: PhoneRuntimeStart
  readonly stopped: Promise<'stopped'>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  readonly stopCount: () => number
}

function controlledStart(): ControlledStart {
  const waiter = Promise.withResolvers<PhoneRuntimeStart>()
  const stopped = Promise.withResolvers<'stopped'>()
  let stopCount = 0
  const start: PhoneRuntimeStart = {
    generation: stubGeneration('controlled'),
    async stop() {
      stopCount += 1
      stopped.resolve('stopped')
    },
  }
  return {
    promise: waiter.promise,
    start,
    stopped: stopped.promise,
    resolve: () => {
      waiter.resolve(start)
    },
    reject: (error) => {
      waiter.reject(error)
    },
    stopCount: () => stopCount,
  }
}

describe('PhoneRuntimePool occupancy', () => {
  it('reports independent prior and current stop failures in one cell', async () => {
    const failures = [new Error('prior stop'), new Error('current stop')] as const
    let starts = 0
    const pool = createPhoneRuntimePool({
      async start() {
        const failure = starts++ === 0 ? failures[0] : failures[1]
        return { generation: stubGeneration('failures'), stop: () => Promise.reject(failure) }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    await expect(pool.stopExternal()).rejects.toBe(failures[0])
    await pool.acquireExternal()
    await expect(pool.dispose()).rejects.toMatchObject({ errors: failures })
  })

  it('retains the new pending start after a stopped prior epoch', async () => {
    const next = Promise.withResolvers<PhoneRuntimeStart>()
    const stopped = Promise.withResolvers<undefined>()
    let starts = 0
    let oldStops = 0
    let newStops = 0
    const pool = createPhoneRuntimePool({
      async start() {
        starts += 1
        if (starts === 2) return await next.promise
        return { generation: stubGeneration('old'), async stop() { oldStops += 1 } }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const old = await pool.acquireExternal()
    await pool.stopExternal()
    const pending = pool.acquireExternal()
    const disposed = pool.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await disposed
    expect(pool.lifecycle().cleanupPending).toBe(1)
    await expect(old.listDevices()).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    next.resolve({
      generation: stubGeneration('late-new'),
      stop() { newStops += 1; return stopped.promise },
    })
    await vi.waitFor(() => { expect(newStops).toBe(1) })
    expect(pool.lifecycle().cleanupPending).toBe(1)
    stopped.resolve(undefined)
    await vi.waitFor(() => { expect(pool.lifecycle().cleanupPending).toBe(0) })
    expect(oldStops).toBe(1)
  })

  it('aborts replacement only after its adapter start has entered', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const next = controlledStart()
    let starts = 0
    const pool = createPhoneRuntimePool({
      async start(request) {
        starts += 1
        if (starts === 1) return { generation: stubGeneration('old'), async stop() {} }
        entered.resolve(request.signal)
        return await next.promise
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    const cancel = new AbortController()
    const replacing = pool.replaceExternal({ executablePath: '/next', signal: cancel.signal })
    const signal = await entered.promise
    cancel.abort()
    expect(signal.aborted).toBe(true)
    next.resolve()
    await replacing
    expect(next.stopCount()).toBe(1)
  })

  it('preserves synchronous stop failure and dispose promise identity', async () => {
    const failure = new Error('synchronous stop')
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('sync'),
          stop() { calls += 1; throw failure },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    const first = pool.dispose()
    expect(pool.dispose()).toBe(first)
    await expect(first).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  it('retains pending start ownership through stopExternal and dispose', async () => {
    const start = controlledStart()
    const pool = createPhoneRuntimePool({ start: () => start.promise }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    await pool.stopExternal()
    const closed = pool.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await closed
    expect(pool.lifecycle()).toMatchObject({ phase: 'closed', cleanupPending: 1 })
    start.resolve()
    await start.stopped
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
    })
    expect(start.stopCount()).toBe(1)
  })

  it.each(['release', 'dispose'] as const)('observes the original non-memoized stop after %s timeout', async (operation) => {
    const stopped = Promise.withResolvers<undefined>()
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('once-stop'),
          stop() {
            calls += 1
            return calls === 1 ? stopped.promise : Promise.resolve()
          },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    await (operation === 'release' ? handle.release() : pool.dispose())
    expect(calls).toBe(1)
    expect(pool.lifecycle().cleanupPending).toBe(1)
    stopped.reject(new Error('original stop failed'))
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().cleanupFailures).toContain('original stop failed')
    })
  })

  it('publishes dispose before a synchronous stop callback reenters it', async () => {
    let nested: Promise<void> | undefined
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('reentrant'),
          stop() {
            calls += 1
            if (calls === 1) nested = pool.dispose()
            return Promise.resolve()
          },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    const outer = pool.dispose()
    expect(nested).toBe(outer)
    await outer
    expect(calls).toBe(1)
  })

  it('returns the same release promise while last occupancy cleanup is pending', async () => {
    const stopped = Promise.withResolvers<undefined>()
    const pool = createPhoneRuntimePool({
      async start() {
        return { generation: stubGeneration('release-identity'), stop: () => stopped.promise }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    const first = handle.release()
    const second = handle.release()
    expect(second).toBe(first)
    stopped.resolve(undefined)
    await first
  })

  it('retains a rejected stopExternal result for dispose without stopping twice', async () => {
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('external-reject'),
          stop() {
            calls += 1
            return Promise.reject(new Error('external stop failed'))
          },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    await expect(pool.stopExternal()).rejects.toThrow('external stop failed')
    await expect(pool.dispose()).rejects.toThrow('external stop failed')
    expect(calls).toBe(1)
  })

  it('does not relinquish a ready child when stopExternal is pre-aborted', async () => {
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('external-preabort'),
          async stop() { calls += 1 },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(pool.stopExternal(cancelled.signal)).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    expect(handle.isReady()).toBe(true)
    expect(calls).toBe(0)
    await pool.dispose()
    expect(calls).toBe(1)
  })

  it('counts last-release and dispose observing the same pending stop once', async () => {
    const stopped = Promise.withResolvers<undefined>()
    let calls = 0
    const pool = createPhoneRuntimePool({
      async start() {
        return {
          generation: stubGeneration('shared-cleanup'),
          stop() { calls += 1; return stopped.promise },
        }
      },
    }, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    await handle.release()
    await pool.dispose()
    expect(pool.lifecycle()).toMatchObject({ phase: 'closed', cleanupPending: 1 })
    expect(calls).toBe(1)
    stopped.reject(new Error('shared cleanup failed'))
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().cleanupFailures).toEqual(['shared cleanup failed'])
    })
  })

  it('mints distinct external handles that share one Adapter start', async () => {
    let starts = 0
    const configs: PhoneRuntimeSlotConfig[] = []
    const adapter: PhoneRuntimeAdapter = {
      async start(request) {
        starts += 1
        configs.push(request.config)
        return { generation: stubGeneration('external'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, {
      cleanupTimeoutMs: 200,
      executablePath: '/opt/fake/mobilecli',
      environment: { ANDROID_SDK_ROOT: '/sdk' },
    })
    pools.push(pool)
    const first = pool.acquireExternal()
    const second = pool.acquireExternal()
    const [a, b] = await Promise.all([first, second])
    expect(starts).toBe(1)
    expect(a.occupancyId).not.toBe(b.occupancyId)
    expect(configs[0]?.provenance).toBe('host-external')
    expect(configs[0]?.executablePath).toBe('/opt/fake/mobilecli')
    expect(a.occupancyId).not.toMatch(/session/i)
    await a.release()
    await expect(a.listDevices()).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await expect(b.listDevices()).resolves.toEqual(EMPTY_LIST)
    await b.release()
    expect(starts).toBe(1)
  })

  it('rejects a cancelled sibling immediately without awaiting Adapter start', async () => {
    const start = controlledStart()
    const adapter: PhoneRuntimeAdapter = { start: () => start.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const first = pool.acquireExternal()
    const cancel = new AbortController()
    const sibling = pool.acquireExternal(cancel.signal)
    cancel.abort()
    await expect(sibling).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    start.resolve()
    const handle = await first
    expect(handle.isReady()).toBe(true)
  })

  it('rejects failed start and removes pending occupancies', async () => {
    const firstAttempt = controlledStart()
    const retry = controlledStart()
    const queue = [firstAttempt, retry]
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        const next = queue.shift()
        if (next === undefined) throw new Error('unexpected extra start')
        return next.promise
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    firstAttempt.reject(new PhoneDevicesError('PHONE_UNAVAILABLE', 'spawn failed'))
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    const next = pool.acquireExternal()
    retry.resolve()
    const recovered = await next
    expect(recovered.isReady()).toBe(true)
  })

  it('stops a late Adapter resolve privately after pool dispose settles as cleanupPending', async () => {
    const start = controlledStart()
    const adapter: PhoneRuntimeAdapter = { start: () => start.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    const closed = pool.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await closed
    expect(pool.lifecycle().phase).toBe('closed')
    expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    start.resolve()
    await start.stopped
    await vi.waitFor(() => {
      expect(start.stopCount()).toBe(1)
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().phase).toBe('closed')
    })
  })

  it('does not let an aborted handle operate on a replacement generation', async () => {
    let generationLabel = 'v1'
    let stopV1 = 0
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        const label = generationLabel
        return {
          generation: {
            ...stubGeneration(label),
            listDevices: async () => ({
              android: label === 'v2' ? [{
                id: deviceId('emu-v2'),
                name: 'v2',
                kind: 'emulator',
                platform: 'android',
                state: 'online',
                online: true,
              }] : [],
              ios: { simulators: [], reals: [] },
            }),
          },
          async stop() {
            if (label === 'v1') stopV1 += 1
          },
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const oldHandle = await pool.acquireExternal()
    generationLabel = 'v2'
    await pool.replaceExternal({ executablePath: '/opt/fake/mobilecli-2' })
    await expect(oldHandle.listDevices()).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await oldHandle.release()
    expect(stopV1).toBe(1)
    const next = await pool.acquireExternal()
    expect((await next.listDevices()).android.map(entry => entry.id)).toEqual([deviceId('emu-v2')])
    await next.release()
  })

  it('keeps occupancies after stopExternal and does not autostart', async () => {
    let starts = 0
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        starts += 1
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    expect(starts).toBe(1)
    await pool.stopExternal()
    await expect(handle.listDevices()).rejects.toMatchObject({ code: 'PHONE_UNRESOLVED' })
    expect(starts).toBe(1)
    const again = await pool.acquireExternal()
    expect(starts).toBe(2)
    await expect(handle.listDevices()).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await again.release()
    await handle.release()
  })

  it('last-release after stopExternal does not start a child', async () => {
    let starts = 0
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        starts += 1
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    await pool.stopExternal()
    expect(starts).toBe(1)
    await handle.release()
    expect(starts).toBe(1)
    expect(pool.lifecycle().phase).toBe('open')
    expect(pool.lifecycle().cleanupPending).toBe(0)
  })

  it('memoizes dispose and rejects new acquires', async () => {
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await pool.acquireExternal()
    const first = pool.dispose()
    const second = pool.dispose()
    expect(second).toBe(first)
    await first
    await expect(pool.acquireExternal()).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await expect(pool.acquireIsolatedIos()).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    const open = createPhoneRuntimePool({
      async start() {
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }, { cleanupTimeoutMs: 200 })
    pools.push(open)
    await expect(open.acquireIsolatedIos()).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
  })

  it('forwards generation fleet operations through a live handle', async () => {
    const id = deviceId('emu-1')
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return { generation: stubGeneration('ops'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    await handle.boot(id)
    await handle.shutdown(id)
    await handle.io({ deviceId: id, method: 'text', text: 'x' })
    await handle.startCapture({ deviceId: id, format: 'mjpeg' })
    await handle.screenshot(id)
    await handle.agentStatus(id)
    await handle.installAgent(id, { force: true })
    handle.onReadinessChanged(() => {})()
    handle.onChanged(() => {})()
    await handle.release()
    expect(() => handle.isReady()).toThrow(PhoneDevicesError)
    await handle.release()
    const live = await pool.acquireExternal()
    const afterLive = new AbortController()
    const joined = await pool.acquireExternal(afterLive.signal)
    afterLive.abort()
    await expect(joined.listDevices()).resolves.toEqual(EMPTY_LIST)
    await live.release()
    await joined.release()
  })

  it('rejects already-aborted acquire and isolated cancel without leaking a slot', async () => {
    const start = controlledStart()
    const adapter: PhoneRuntimeAdapter = { start: () => start.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 80 })
    pools.push(pool)
    const dead = new AbortController()
    dead.abort()
    await expect(pool.acquireExternal(dead.signal)).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await expect(pool.acquireIsolatedIos()).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    start.resolve()
    const handle = await pool.acquireExternal()
    await handle.release()
  })

  it('races last-release stop against the cleanup budget', async () => {
    const stopped = Promise.withResolvers<'stopped'>()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('slow-stop'),
          stop: () => stopped.promise.then(() => {}),
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    const releasing = handle.release()
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    })
    stopped.resolve('stopped')
    await releasing
  })

  it('rejects replace abort and a thrown Adapter start', async () => {
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await pool.acquireExternal()
    const cancel = new AbortController()
    cancel.abort()
    await expect(pool.replaceExternal({
      executablePath: '/opt/next',
      signal: cancel.signal,
    })).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    let starts = 0
    const failing: PhoneRuntimeAdapter = {
      async start() {
        starts += 1
        if (starts === 1) return { generation: stubGeneration('first'), async stop() {} }
        throw new Error('replace boom')
      },
    }
    const pool2 = createPhoneRuntimePool(failing, { cleanupTimeoutMs: 200 })
    pools.push(pool2)
    await pool2.acquireExternal()
    await expect(pool2.replaceExternal({ executablePath: '/opt/next' })).rejects.toMatchObject({
      code: 'PHONE_UNAVAILABLE',
    })
  })

  it('cancels the last pending occupancy and contains a late start', async () => {
    const start = controlledStart()
    const adapter: PhoneRuntimeAdapter = { start: () => start.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 30 })
    pools.push(pool)
    const cancel = new AbortController()
    const waiting = pool.acquireExternal(cancel.signal)
    cancel.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    start.resolve()
    await start.stopped
    expect(start.stopCount()).toBe(1)
  })

  it('rejects acquire while last-release cleanup is pending', async () => {
    const stopped = Promise.withResolvers<'stopped'>()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('hang-stop'),
          stop: () => stopped.promise.then(() => {}),
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    const releasing = handle.release()
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    })
    await expect(pool.acquireExternal()).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    stopped.resolve('stopped')
    await releasing
  })

  it('ignores a late start failure after replace bumped the epoch', async () => {
    const first = controlledStart()
    const second = controlledStart()
    let calls = 0
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        calls += 1
        return calls === 1 ? first.promise : second.promise
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    const replacing = pool.replaceExternal({ executablePath: '/opt/x' })
    first.reject(new Error('stale start failed'))
    second.resolve()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await replacing
    const next = await pool.acquireExternal()
    expect(next.isReady()).toBe(true)
    await next.release()
  })

  it('aborts pending acquire on replace and wraps a non-Error Adapter throw', async () => {
    const first = controlledStart()
    let calls = 0
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        calls += 1
        if (calls === 1) return first.promise
        throw new PhoneDevicesError('PHONE_UNAVAILABLE', 'not-an-error')
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    await expect(pool.replaceExternal({ executablePath: '/opt/x' })).rejects.toMatchObject({
      code: 'PHONE_UNAVAILABLE',
    })
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    first.resolve()
    await first.stopped
  })

  it('contains a throwing late stop and aggregates dispose stop failures', async () => {
    const waiter = Promise.withResolvers<PhoneRuntimeStart>()
    const adapter: PhoneRuntimeAdapter = { start: () => waiter.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    const closed = pool.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await closed
    expect(pool.lifecycle().phase).toBe('closed')
    expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    waiter.resolve({
      generation: stubGeneration('late-throw'),
      async stop() {
        throw new Error('late stop failed')
      },
    })
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().phase).toBe('closed')
      expect(pool.lifecycle().cleanupFailures).toContain('late stop failed')
    })
    const boom: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('boom-stop'),
          async stop() {
            throw new Error('stop failed')
          },
        }
      },
    }
    const pool2 = createPhoneRuntimePool(boom, { cleanupTimeoutMs: 200 })
    pools.push(pool2)
    await pool2.acquireExternal()
    await expect(pool2.dispose()).rejects.toThrow(/stop failed/)
  })

  it('contains last-release of a hanging start and a throwing stop', async () => {
    const start = controlledStart()
    const adapter: PhoneRuntimeAdapter = { start: () => start.promise }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 1 })
    pools.push(pool)
    const cancel = new AbortController()
    const waiting = pool.acquireExternal(cancel.signal)
    cancel.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    })
    start.resolve()
    await start.stopped
    const throwing: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('throw-stop'),
          async stop() {
            throw new Error('last-release stop failed')
          },
        }
      },
    }
    const pool2 = createPhoneRuntimePool(throwing, { cleanupTimeoutMs: 200 })
    pools.push(pool2)
    const handle = await pool2.acquireExternal()
    await handle.release()
  })

  it('aborts a live replace signal during Adapter start', async () => {
    const start = controlledStart()
    let calls = 0
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve({ generation: stubGeneration('v1'), async stop() {} })
        }
        return start.promise
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await pool.acquireExternal()
    const cancel = new AbortController()
    const replacing = pool.replaceExternal({ executablePath: '/opt/next', signal: cancel.signal })
    await Promise.resolve()
    cancel.abort()
    start.resolve()
    await Promise.race([replacing.catch(() => {}), start.stopped])
  })

  it('rejects already-aborted isolated acquire and a second replace during stop', async () => {
    const dead = new AbortController()
    dead.abort()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return { generation: stubGeneration('iso'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await expect(pool.acquireIsolatedIos(dead.signal)).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    const slowStop = Promise.withResolvers<'stopped'>()
    let starts = 0
    const replacing: PhoneRuntimeAdapter = {
      async start() {
        starts += 1
        return {
          generation: stubGeneration(`g${String(starts)}`),
          stop: () => slowStop.promise.then(() => {}),
        }
      },
    }
    const pool2 = createPhoneRuntimePool(replacing, { cleanupTimeoutMs: 200 })
    pools.push(pool2)
    await pool2.acquireExternal()
    const first = pool2.replaceExternal({ executablePath: '/a' })
    const second = pool2.replaceExternal({ executablePath: '/b' })
    slowStop.resolve('stopped')
    await Promise.allSettled([first, second])
  })

  it('records cleanupPending when dispose races a hanging ready stop', async () => {
    const stopped = Promise.withResolvers<'stopped'>()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('ready-hang'),
          stop: () => stopped.promise.then(() => {}),
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    const closed = pool.dispose()
    await closed
    expect(pool.lifecycle().phase).toBe('closed')
    expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    stopped.resolve('stopped')
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().phase).toBe('closed')
    })
  })

  it('settles dispose cleanupPending when hanging ready stop rejects', async () => {
    const stopped = Promise.withResolvers<never>()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('dispose-reject-stop'),
          stop: () => stopped.promise,
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    await pool.acquireExternal()
    const closed = pool.dispose()
    await closed
    expect(pool.lifecycle().phase).toBe('closed')
    expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    void stopped.promise.catch(() => {})
    stopped.reject(new Error('dispose stop rejected'))
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().phase).toBe('closed')
      expect(pool.lifecycle().cleanupFailures).toContain('dispose stop rejected')
    })
  })

  it('records cleanupPending when dispose races a hanging start', async () => {
    const start = controlledStart()
    let invoked = 0
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        invoked += 1
        return start.promise
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 1 })
    pools.push(pool)
    const waiting = pool.acquireExternal()
    await vi.waitFor(() => {
      expect(invoked).toBe(1)
    })
    const closed = pool.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_DISPOSED' })
    await closed
    expect(pool.lifecycle().phase).toBe('closed')
    expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    start.reject(new Error('start failed after dispose'))
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().phase).toBe('closed')
      expect(pool.lifecycle().cleanupFailures).toContain('start failed after dispose')
    })
  })

  it('settles last-release cleanup when hanging stop rejects', async () => {
    const stopped = Promise.withResolvers<never>()
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('reject-stop'),
          stop: () => stopped.promise,
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    const releasing = handle.release()
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    })
    void stopped.promise.catch(() => {})
    stopped.reject(new Error('stop rejected'))
    await releasing
  })

  it('records cleanupPending when last-release races a hanging start', async () => {
    const waiter = Promise.withResolvers<PhoneRuntimeStart>()
    let invoked = 0
    const adapter: PhoneRuntimeAdapter = {
      start: () => {
        invoked += 1
        return waiter.promise
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 20 })
    pools.push(pool)
    const cancel = new AbortController()
    const waiting = pool.acquireExternal(cancel.signal)
    await vi.waitFor(() => {
      expect(invoked).toBe(1)
    })
    cancel.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBeGreaterThan(0)
    })
    waiter.reject(new Error('start failed after cancel'))
    await vi.waitFor(() => {
      expect(pool.lifecycle().cleanupPending).toBe(0)
      expect(pool.lifecycle().cleanupFailures).toContain('start failed after cancel')
    })
  })

  it('keeps a bounded cleanupFailures ring after admission is closed', async () => {
    let stopIndex = 0
    const pool = createPhoneRuntimePool({
      async start() {
        const label = stopIndex
        return {
          generation: stubGeneration('overflow'),
          async stop() {
            throw new Error(`overflow-${String(label)}`)
          },
        }
      },
    }, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    for (; stopIndex < 9; stopIndex += 1) {
      const handle = await pool.acquireExternal()
      await handle.release()
    }
    expect(pool.lifecycle().cleanupFailures).not.toContain('overflow-0')
    expect(pool.lifecycle().cleanupFailures).toContain('overflow-8')
    expect(pool.lifecycle().cleanupFailures).toHaveLength(8)
    expect(pool.lifecycle().phase).toBe('open')
  })

  it('rejects a non-integer cleanup budget', () => {
    expect(() => createPhoneRuntimePool({
      async start() {
        return { generation: stubGeneration('x'), async stop() {} }
      },
    }, { cleanupTimeoutMs: 0 })).toThrow(/cleanupTimeoutMs/)
  })

  it('stopExternal on an empty pool is a no-op and two throwing stops aggregate', async () => {
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('iso'),
          async stop() {
            throw new Error('isolated stop failed')
          },
        }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await pool.stopExternal()
    const first = await pool.acquireExternal()
    const secondPool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(secondPool)
    await secondPool.acquireExternal()
    await expect(Promise.all([pool.dispose(), secondPool.dispose()])).rejects.toThrow(/isolated stop failed/)
    await first.release().catch(() => {})
  })

  it('wraps a non-Error Adapter start and a non-Error dispose stop', async () => {
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        throw 'spawn-string'
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await expect(pool.acquireExternal()).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    await expect(pool.replaceExternal({ executablePath: '/opt/x' })).rejects.toMatchObject({
      code: 'PHONE_UNAVAILABLE',
    })
    const stopping: PhoneRuntimeAdapter = {
      async start() {
        return {
          generation: stubGeneration('string-stop'),
          async stop() {
            throw 'stop-string'
          },
        }
      },
    }
    const pool2 = createPhoneRuntimePool(stopping, { cleanupTimeoutMs: 200 })
    pools.push(pool2)
    await pool2.acquireExternal()
    await expect(pool2.dispose()).rejects.toBeInstanceOf(Error)
  })

  it('reports isReady false after stopExternal and ignores last-release autostart', async () => {
    const adapter: PhoneRuntimeAdapter = {
      async start() {
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    const handle = await pool.acquireExternal()
    await pool.stopExternal()
    expect(handle.isReady()).toBe(false)
    const again = await pool.acquireExternal()
    expect(again.isReady()).toBe(true)
    await expect(handle.listDevices()).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
    await again.release()
    await handle.release()
  })

  it('passes a live replace AbortSignal into Adapter start', async () => {
    const seen: AbortSignal[] = []
    const adapter: PhoneRuntimeAdapter = {
      async start(request) {
        seen.push(request.signal)
        return { generation: stubGeneration('ext'), async stop() {} }
      },
    }
    const pool = createPhoneRuntimePool(adapter, { cleanupTimeoutMs: 200 })
    pools.push(pool)
    await pool.acquireExternal()
    const signal = new AbortController().signal
    await pool.replaceExternal({ executablePath: '/opt/next', signal })
    expect(seen.length).toBe(2)
    expect(seen[1]).toBeDefined()
  })
})

async function generationFromFake(devices: Array<Record<string, unknown>>): Promise<PhoneRuntimeStart> {
  const fake = await stageFake({ devices })
  fakes.push(fake)
  await fake.claim()
  const context = new Context()
  contexts.push(context)
  await context.plugin(PhoneDevices, {
    executablePath: fake.executablePath,
    serverPort: fake.port,
    pollIntervalMs: 20,
    readyStabilityMs: 20,
    readyTimeoutMs: 6_000,
    requestTimeoutMs: 1_500,
    bootTimeoutMs: 2_000,
  }).await()
  const devicesService = context.phoneDevices
  return {
    generation: {
      listDevices: signal => devicesService.listDevices(signal),
      boot: (id, signal) => devicesService.boot(id, signal),
      shutdown: (id, signal) => devicesService.shutdown(id, signal),
      io: (request: PhoneIoRequest, signal) => devicesService.io(request, signal),
      startCapture: (request: PhoneCaptureRequest) => devicesService.startCapture(request),
      screenshot: (id: DeviceId, signal) => devicesService.screenshot(id, signal),
      agentStatus: (id, signal) => devicesService.agentStatus(id, signal),
      installAgent: (id, installOptions) => devicesService.installAgent(id, installOptions),
      isReady: () => devicesService.isReady(),
      onReadinessChanged: listener => devicesService.onReadinessChanged(listener),
      onChanged: sub => devicesService.onChanged(sub),
    },
    stop: async () => { await context.fiber.dispose() },
  }
}

function fakeAdapter(devices: Array<Record<string, unknown>>): PhoneRuntimeAdapter {
  return {
    async start() {
      return await generationFromFake(devices)
    },
  }
}

describe('PhoneRuntimePool isolation', () => {
  it('rejects isolated acquire until a private HOME/set/bind provider exists', async () => {
    const pool = createPhoneRuntimePool(fakeAdapter([wireDevice('emulator-AAAA', 'android', 'emulator', 'online')]), {
      cleanupTimeoutMs: 2_000,
    })
    pools.push(pool)
    await expect(pool.acquireIsolatedIos()).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' })
    const external = await pool.acquireExternal()
    expect((await external.listDevices()).android.map(entry => entry.id)).toEqual([deviceId('emulator-AAAA')])
  })

  it('keeps two fake external generations on separate pools without a silent fallback', async () => {
    const android = createPhoneRuntimePool(
      fakeAdapter([wireDevice('emulator-AAAA', 'android', 'emulator', 'online')]),
      { cleanupTimeoutMs: 2_000 },
    )
    const ios = createPhoneRuntimePool(
      fakeAdapter([wireDevice('SIM-BBBB', 'ios', 'simulator', 'online')]),
      { cleanupTimeoutMs: 2_000 },
    )
    pools.push(android, ios)
    const external = await android.acquireExternal()
    const other = await ios.acquireExternal()
    const externalList = await external.listDevices()
    const otherList = await other.listDevices()
    expect(externalList.android.map(entry => entry.id)).toEqual([deviceId('emulator-AAAA')])
    expect(otherList.ios.simulators.map(entry => entry.id)).toEqual([deviceId('SIM-BBBB')])
    await expect(other.startCapture({
      deviceId: deviceId('emulator-AAAA'),
      format: 'mjpeg',
    })).rejects.toBeInstanceOf(PhoneDevicesError)
    expect((await external.listDevices()).android.map(entry => entry.id)).toEqual([deviceId('emulator-AAAA')])
    await other.release()
    expect((await external.listDevices()).android.map(entry => entry.id)).toEqual([deviceId('emulator-AAAA')])
  })
})
