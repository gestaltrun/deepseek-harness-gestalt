import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import type { Config, PhoneDeviceChange, PhoneDeviceList } from '@deepseek-ai/dsh-phone-runtime'
import type { PhoneRuntimeStateOwner } from '../src/runtime-state.ts'
import { changeSets, groupEntries, parseDeviceInfos } from '../src/devices.ts'
import {
  PHONE_RUNTIME_STATE_OWNER,
  phoneRuntimeStateValidator,
  registerPhoneRuntimeStateReader,
  registerPhoneRuntimeStateValidator,
} from '../src/runtime-state.ts'
import * as PhoneRuntimeInvariant from '../src/invariant.ts'
import { assertConsecutiveChange } from '../src/invariant.ts'
import { stageFake, wireDevice } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: Context[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

const FAST_CONFIG: Partial<Config> = {
  pollIntervalMs: 20,
  readyTimeoutMs: 6_000,
  requestTimeoutMs: 1_500,
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolveTick => setTimeout(resolveTick, 10))
  }
}

function listFor(entries: Array<{ id: string; platform: 'ios' | 'android'; kind: string; state: string }>): PhoneDeviceList {
  return groupEntries(parseDeviceInfos(entries.map(({ id, platform, kind, state }) =>
    wireDevice(id, platform, kind as 'real' | 'simulator' | 'emulator', state))))
}

function genuineChange(previous: PhoneDeviceList | undefined, next: PhoneDeviceList): PhoneDeviceChange {
  const delta = changeSets(previous, next)
  return Object.freeze({
    list: next,
    added: Object.freeze(delta.added),
    removed: Object.freeze(delta.removed),
  })
}

describe('phone runtime invariant companion', () => {
  it('refuses to load against a Service without its owner symbol', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(InvariantRegistry).await()
    context.provide('phoneDevices', {} as never)
    await expect(context.plugin(PhoneRuntimeInvariant).await())
      .rejects.toThrow(InvariantError)
    await expect(context.plugin(PhoneRuntimeInvariant).await())
      .rejects.toThrow(/owner symbol/)
    // An explicit undefined owner hits the second guard with the same message.
    const symbolless = new Context()
    contexts.push(symbolless)
    await symbolless.plugin(InvariantRegistry).await()
    symbolless.provide('phoneDevices', { [PHONE_RUNTIME_STATE_OWNER]: undefined } as never)
    await expect(symbolless.plugin(PhoneRuntimeInvariant).await())
      .rejects.toThrow(/owner symbol/)
  })

  it('refuses to load when the Service generation lacks its state reader or seat is taken', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(InvariantRegistry).await()
    const stubOwner = {} as PhoneRuntimeStateOwner
    context.provide('phoneDevices', { [PHONE_RUNTIME_STATE_OWNER]: stubOwner } as never)
    await expect(context.plugin(PhoneRuntimeInvariant).await())
      .rejects.toThrow(/state reader registration/)
    // A second invariant mount over an occupied validator seat also fails loud.
    const second = new Context()
    contexts.push(second)
    await second.plugin(InvariantRegistry).await()
    const seatedOwner = {} as PhoneRuntimeStateOwner
    registerPhoneRuntimeStateReader(seatedOwner, () => undefined)
    registerPhoneRuntimeStateValidator(seatedOwner, () => undefined)
    second.provide('phoneDevices', { [PHONE_RUNTIME_STATE_OWNER]: seatedOwner } as never)
    await expect(second.plugin(PhoneRuntimeInvariant).await())
      .rejects.toThrow(/second validator seat/)
  })

  it('approves one real generation riding real changes through publication', async () => {
    const fake = await stageFake({
      devices: [wireDevice('SIM-1', 'ios', 'simulator', 'offline')],
    })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await context.plugin(InvariantRegistry).await()
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    }).await()
    await context.plugin(PhoneRuntimeInvariant).await()

    const seen: PhoneDeviceChange[] = []
    context.phoneDevices.onChanged(change => seen.push(change))
    await context.phoneDevices.boot(deviceId('SIM-1'))
    await waitFor(() => seen.length > 0)
    expect(seen[0]?.added).toEqual([])
    expect(seen[0]?.removed).toEqual([])
    expect(seen[0]?.list.ios.simulators[0]?.online).toBe(true)

    await context.phoneDevices.shutdown(deviceId('SIM-1'))
    await waitFor(() => seen.length >= 2)
    expect(seen[1]?.added).toEqual([])
    expect(seen[1]?.removed).toEqual([])
    expect(seen[1]?.list.ios.simulators[0]?.online).toBe(false)
  })

  it('halts polling loudly when a malformed candidate reaches publication', async () => {
    const fake = await stageFake({
      devices: [wireDevice('SIM-1', 'ios', 'simulator', 'offline')],
    })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    // The invariant companion stays unmounted, so this test owns the seat.
    await context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
    }).await()
    const owner = (context.phoneDevices as unknown as Record<PropertyKey, unknown>)[PHONE_RUNTIME_STATE_OWNER]
    expect(owner).toBeDefined()
    if (typeof owner !== 'object' || owner === null) {
      throw new Error('phone runtime state owner must be an object')
    }
    expect(phoneRuntimeStateValidator(owner)).toBeUndefined()

    registerPhoneRuntimeStateValidator(owner, () => {
      throw new Error('tampered validator rejects every candidate')
    })
    // The honest validator refuses duplicate seats; ownership is exact.
    expect(phoneRuntimeStateValidator(owner)).toBeDefined()

    const notifications: number[] = []
    context.phoneDevices.onChanged(() => notifications.push(notifications.length))
    await fake.setDevices([wireDevice('SIM-1', 'ios', 'simulator', 'online')])
    await waitFor(async () => {
      const answer: unknown = await context.phoneDevices.listDevices().then(
        value => value,
        (error: unknown) => error,
      )
      return answer instanceof Error && answer.message.includes('runtime-invariant')
    }, 4_000)
    expect(notifications).toEqual([])
    const refused: unknown = await context.phoneDevices.listDevices().then(
      () => null,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('runtime-invariant')
  })
})

describe('assertConsecutiveChange', () => {
  it('accepts an honest first acquisition', () => {
    const first = listFor([{ id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' }])
    expect(assertConsecutiveChange(undefined, genuineChange(undefined, first))).toEqual(first)
  })

  it('rejects candidates carrying no observable difference', () => {
    const same = listFor([{ id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' }])
    expect(() => assertConsecutiveChange(same, genuineChange(same, same)))
      .toThrow(/no observable difference/)
  })

  it('rejects removed arrays disagreeing with their own listings', () => {
    const before = listFor([
      { id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' },
      { id: 'GONE', platform: 'android', kind: 'real', state: 'online' },
    ])
    const after = listFor([{ id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' }])
    const lied = Object.freeze({
      list: after,
      added: Object.freeze([]),
      removed: Object.freeze([deviceId('SOMEONE-ELSE')]),
    }) satisfies PhoneDeviceChange
    expect(() => assertConsecutiveChange(before, lied)).toThrow(/removed .* must equal the recomputed/)
  })

  it('rejects notification arrays disagreeing with their own listings', () => {
    const before = listFor([{ id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' }])
    const after = listFor([
      { id: 'emulator-5554', platform: 'android', kind: 'emulator', state: 'online' },
      { id: 'NEW', platform: 'android', kind: 'real', state: 'online' },
    ])
    const lied = Object.freeze({
      list: after,
      added: Object.freeze([]),
      removed: Object.freeze([]),
    }) satisfies PhoneDeviceChange
    expect(() => assertConsecutiveChange(before, lied)).toThrow(/must equal the recomputed/)
  })

  it('rejects an empty-baseline miscount against reality', () => {
    const after = listFor([])
    void after
    expect(() => assertConsecutiveChange(undefined, {
      list: listFor([]),
      added: [deviceId('GHOST')],
      removed: [],
    })).toThrow(/must equal the recomputed|no observable difference/)
  })
})
