import { describe, expect, it } from 'vitest'
import { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import {
  allRefs,
  changeSets,
  groupEntries,
  parseDeviceInfos,
  phoneDeviceKind,
} from '../src/devices.ts'
import { PhoneDevicesError } from '../src/errors.ts'

const ANDROID_EMU = deviceId('emulator-5554')
const IOS_SIM = deviceId('SIM-UDID-1')
const IOS_REAL = deviceId('REAL-UDID-1')

function wire(
  id: string,
  platform: 'ios' | 'android',
  type: string,
  state = 'online',
  name = `${id}-n`,
): { id: string; name: string; platform: string; type: string; state: string; model: string; provider: { type: string } } {
  return { id, name, platform, type, state, model: 'm', provider: { type: 'local' } }
}

describe('devices.list result validation', () => {
  it('maps a well-formed listing onto frozen refs with online from state', () => {
    const refs = parseDeviceInfos([
      wire('emulator-5554', 'android', 'emulator'),
      wire('REAL', 'ios', 'real', 'unauthorized'),
      wire('OFF', 'android', 'real', 'offline'),
    ])
    expect(refs.map(ref => [ref.id, ref.kind, ref.online])).toEqual([
      [ANDROID_EMU, 'emulator', true],
      [deviceId('REAL'), 'real', false],
      [deviceId('OFF'), 'real', false],
    ])
  })

  it('keeps every upstream state verbatim instead of folding non-online states together', () => {
    const refs = parseDeviceInfos([
      wire('u', 'ios', 'real', 'unauthorized'),
      wire('o', 'android', 'emulator'),
      wire('x', 'android', 'emulator', 'recovery'),
    ])
    expect(refs.map(ref => [ref.id, ref.state, ref.online])).toEqual([
      [deviceId('u'), 'unauthorized', false],
      [deviceId('o'), 'online', true],
      [deviceId('x'), 'recovery', false],
    ])
  })

  it('reports a change when only the upstream state flips between two non-online values', () => {
    const before = groupEntries(parseDeviceInfos([wire('u', 'ios', 'real', 'unauthorized')]))
    const after = groupEntries(parseDeviceInfos([wire('u', 'ios', 'real', 'offline')]))
    expect(changeSets(before, after)).toMatchObject({ changed: true, added: [], removed: [] })
  })

  it.each([
    ['non-array', 42, 'result must be a device array'],
    ['element not object', [null], 'must be an object'],
    ['missing id', [{ name: 'x', platform: 'ios', type: 'real', state: 'online' }], '"id"'],
    ['empty name', [{ id: 'i', name: '', platform: 'ios', type: 'real', state: 'online' }], '"name"'],
    ['unknown platform', [{ id: 'i', name: 'i-n', platform: 'harmony', type: 'real', state: 'online' }], 'platform'],
    ['missing state', [{ id: 'i', name: 'n', platform: 'ios', type: 'real' }], '"state"'],
    ['unknown type', [wire('i', 'ios', 'devicelike')], 'device type "devicelike" is unknown'],
  ])('rejects %s with PHONE_PROTOCOL', (_label, input, fragment) => {
    let caught: unknown
    try {
      parseDeviceInfos(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PhoneDevicesError)
    expect((caught as PhoneDevicesError).code).toBe('PHONE_PROTOCOL')
    expect((caught as PhoneDevicesError).message).toContain(fragment)
  })

  it('requires the exact upstream platform vocabulary', () => {
    const error = (() => {
      try {
        parseDeviceInfos([{ id: 'i', name: 'i-n', platform: 'windowsmobile', type: 'real', state: 'online' }])
        return undefined
      } catch (caught) {
        return caught as PhoneDevicesError
      }
    })()
    expect(error).toBeInstanceOf(PhoneDevicesError)
    expect((error as PhoneDevicesError).message).toContain('"windowsmobile"')
  })
})

describe('phoneDeviceKind translation', () => {
  it('passes the closed vocabulary through', () => {
    expect(phoneDeviceKind('emulator')).toBe('emulator')
    expect(phoneDeviceKind('simulator')).toBe('simulator')
    expect(phoneDeviceKind('real')).toBe('real')
  })

  it('fails loud on anything else', () => {
    expect(() => phoneDeviceKind('device')).toThrow(expect.objectContaining({ code: 'PHONE_PROTOCOL' }))
  })
})

describe('grouping', () => {
  it('keeps android flat and splits ios by simulator class', () => {
    const list = groupEntries(parseDeviceInfos([
      wire('emulator-5554', 'android', 'emulator'),
      wire('PIXEL_6', 'android', 'real', 'offline'),
      wire('SIM-UDID-1', 'ios', 'simulator', 'offline'),
      wire('REAL-UDID-1', 'ios', 'real'),
    ]))
    expect(list.android.map(ref => ref.id)).toEqual([ANDROID_EMU, deviceId('PIXEL_6')])
    expect(list.ios.simulators.map(ref => [ref.id, ref.online])).toEqual([[IOS_SIM, false]])
    expect(list.ios.reals.map(ref => ref.id)).toEqual([IOS_REAL])
    expect(Object.isFrozen(list.ios)).toBe(true)
    expect(Object.isFrozen(list.android)).toBe(true)
    expect(allRefs(list)).toHaveLength(4)
  })

  it('groups empty inputs into empty groups', () => {
    const list = groupEntries([])
    expect(list.android).toEqual([])
    expect(list.ios.simulators).toEqual([])
    expect(list.ios.reals).toEqual([])
    expect(changeSets(undefined, list)).toEqual({ changed: false, added: [], removed: [] })
  })
})

describe('changeSets', () => {
  const base = (): ReturnType<typeof groupEntries> => groupEntries(parseDeviceInfos([
    wire('A', 'android', 'emulator'),
    wire('S', 'ios', 'simulator', 'offline'),
  ]))

  it('reports membership additions and removals', () => {
    const before = base()
    const after = groupEntries(parseDeviceInfos([
      wire('A', 'android', 'emulator'),
      wire('NEW', 'android', 'real'),
    ]))
    expect(changeSets(before, after)).toEqual({
      changed: true,
      added: [deviceId('NEW')],
      removed: [deviceId('S')],
    })
  })

  it('detects fact changes without id movement', () => {
    const before = base()
    const after = groupEntries(parseDeviceInfos([
      wire('A', 'android', 'emulator', 'offline'),
      wire('S', 'ios', 'simulator'),
    ]))
    const delta = changeSets(before, after)
    expect(delta.changed).toBe(true)
    expect(delta.added).toEqual([])
    expect(delta.removed).toEqual([])
  })

  it('detects a pure rename and a kind change', () => {
    const renamed = groupEntries(parseDeviceInfos([
      wire('A', 'android', 'emulator', 'online', 'renamed'),
      wire('S', 'ios', 'simulator', 'offline'),
    ]))
    expect(changeSets(base(), renamed).changed).toBe(true)
    const rekindled = groupEntries(parseDeviceInfos([
      wire('A', 'android', 'real'),
      wire('S', 'ios', 'simulator', 'offline'),
    ]))
    expect(changeSets(base(), rekindled).changed).toBe(true)
  })

  it('stays silent for identical listings regardless of extra upstream fields', () => {
    const first = base()
    const second = groupEntries(parseDeviceInfos([
      { ...wire('A', 'android', 'emulator'), provider: { type: 'fleet' } },
      wire('S', 'ios', 'simulator', 'offline'),
    ]))
    expect(changeSets(first, second).changed).toBe(false)
  })

  it('treats the very first acquisition against nothing as changed only when non-empty', () => {
    expect(changeSets(undefined, base()).changed).toBe(true)
    expect(changeSets(undefined, groupEntries([])).changed).toBe(false)
  })
})
