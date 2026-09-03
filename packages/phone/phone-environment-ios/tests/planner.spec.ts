import { describe, expect, it } from 'vitest'
import { deviceId } from '@deepseek-ai/dsh-phone-runtime'
import { planIosEnvironment } from '../src/planner.ts'

describe('iOS environment planner', () => {
  it.each([
    ['win32', 'Windows'],
    ['linux', 'Linux'],
    ['freebsd', 'freebsd'],
  ])('reports %s as unavailable without an executable action', (platform, family) => {
    expect(planIosEnvironment(platform)).toEqual({
      kind: 'unsupported',
      reason: `${family} cannot run iOS Simulator or control iPhone devices; use macOS with a complete Xcode installation.`,
    })
  })

  it('requires a complete Xcode application on macOS', () => {
    expect(planIosEnvironment('darwin')).toMatchObject({ kind: 'xcode-missing' })
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: false,
      firstLaunchComplete: false,
      runtimes: [],
      deviceTypes: [],
      devices: [],
    })).toMatchObject({ kind: 'license-required' })
  })

  it('requires first-launch components before runtime preparation', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: true,
      firstLaunchComplete: false,
      runtimes: [],
      deviceTypes: [],
      devices: [],
    })).toMatchObject({ kind: 'manual-required', code: 'first-launch' })
  })

  it('selects the newest available iOS runtime and iPhone device type', () => {
    const planned = planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: true,
      firstLaunchComplete: true,
      runtimes: [
        { identifier: 'runtime-18-5', name: 'iOS 18.5', version: '18.5', available: true },
        { identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', available: true },
      ],
      deviceTypes: [
        { identifier: 'type-iphone-16', name: 'iPhone 16' },
        { identifier: 'type-iphone-17-pro', name: 'iPhone 17 Pro' },
        { identifier: 'type-ipad', name: 'iPad Pro' },
      ],
      devices: [],
    })
    expect(planned).toMatchObject({
      kind: 'no-simulator',
      plan: {
        runtime: { identifier: 'runtime-26-0', version: '26.0' },
        deviceType: { identifier: 'type-iphone-17-pro', name: 'iPhone 17 Pro' },
        simulatorName: 'DSH Gestalt iPhone',
      },
    })
  })

  it('copies and freezes nested plan facts before publication', () => {
    const runtime = { identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', available: true }
    const deviceType = { identifier: 'type-iphone-17', name: 'iPhone 17' }
    const planned = planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
      licenseAccepted: true, firstLaunchComplete: true,
      runtimes: [runtime], deviceTypes: [deviceType], devices: [],
    })
    if (planned.kind !== 'no-simulator') throw new Error(`unexpected plan ${planned.kind}`)
    runtime.name = 'mutated runtime'
    deviceType.name = 'mutated device type'
    expect(planned.plan.runtime?.name).toBe('iOS 26.0')
    expect(planned.plan.deviceType?.name).toBe('iPhone 17')
    expect(Object.isFrozen(planned.plan.runtime)).toBe(true)
    expect(Object.isFrozen(planned.plan.deviceType)).toBe(true)
  })

  it('reports a missing runtime before requiring a simulator', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: true,
      firstLaunchComplete: true,
      runtimes: [],
      deviceTypes: [{ identifier: 'type-iphone-17', name: 'iPhone 17' }],
      devices: [],
    })).toMatchObject({ kind: 'runtime-missing' })
  })

  it('requires an iPhone device type after selecting a runtime', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
      licenseAccepted: true, firstLaunchComplete: true,
      runtimes: [{ identifier: 'runtime-26', name: 'iOS 26.0', version: '26.0', available: true }],
      deviceTypes: [{ identifier: 'type-ipad', name: 'iPad Pro' }], devices: [],
    })).toMatchObject({ kind: 'manual-required', code: 'xcode-update' })
  })

  it('orders partial runtime versions and same-generation iPhone variants deterministically', () => {
    const planned = planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
      licenseAccepted: true, firstLaunchComplete: true,
      runtimes: [
        { identifier: 'runtime-unavailable', name: 'iOS 99', version: '99', available: false },
        { identifier: 'runtime-tvos', name: 'tvOS 30', version: '30', available: true },
        { identifier: 'runtime-bad', name: 'iOS bad', version: 'bad', available: true },
        { identifier: 'runtime-26', name: 'iOS 26', version: '26', available: true },
        { identifier: 'runtime-26-0-1', name: 'iOS 26.0.1', version: '26.0.1', available: true },
      ],
      deviceTypes: [
        { identifier: 'type-se', name: 'iPhone SE' },
        { identifier: 'type-17-air', name: 'iPhone 17 Air' },
        { identifier: 'type-17', name: 'iPhone 17' },
        { identifier: 'type-17-pro', name: 'iPhone 17 Pro' },
      ],
      devices: [],
    })
    expect(planned).toMatchObject({
      kind: 'no-simulator',
      plan: {
        runtime: { identifier: 'runtime-26-0-1' },
        deviceType: { identifier: 'type-17-pro' },
      },
    })
  })

  it('prefers Pro for an equal generation regardless of input order', () => {
    for (const deviceTypes of [
      [{ identifier: 'pro', name: 'iPhone 17 Pro' }, { identifier: 'base', name: 'iPhone 17' }],
      [{ identifier: 'base', name: 'iPhone 17' }, { identifier: 'pro', name: 'iPhone 17 Pro' }],
    ]) {
      expect(planIosEnvironment('darwin', {
        developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
        licenseAccepted: true, firstLaunchComplete: true,
        runtimes: [
          { identifier: 'long', name: 'iOS 26.0.1', version: '26.0.1', available: true },
          { identifier: 'short', name: 'iOS 26', version: '26', available: true },
        ],
        deviceTypes, devices: [],
      })).toMatchObject({ kind: 'no-simulator', plan: { deviceType: { identifier: 'pro' } } })
    }
  })

  it('reports the managed simulator and whether it is booted', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: true,
      firstLaunchComplete: true,
      runtimes: [{ identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', available: true }],
      deviceTypes: [{ identifier: 'type-iphone-17', name: 'iPhone 17' }],
      devices: [{
        udid: deviceId('SIMULATOR-UDID'), name: 'DSH Gestalt iPhone', state: 'Booted',
        available: true, runtimeIdentifier: 'runtime-26-0',
      }],
    })).toMatchObject({ kind: 'ready', deviceId: 'SIMULATOR-UDID', running: true })
  })

  it('ignores unavailable, differently named, and other-runtime devices', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer', xcodeVersion: '17.0',
      licenseAccepted: true, firstLaunchComplete: true,
      runtimes: [{ identifier: 'runtime-26', name: 'iOS 26.0', version: '26.0', available: true }],
      deviceTypes: [{ identifier: 'type-17', name: 'iPhone 17' }],
      devices: [
        { udid: deviceId('UNAVAILABLE'), name: 'DSH Gestalt iPhone', state: 'Booted', available: false, runtimeIdentifier: 'runtime-26' },
        { udid: deviceId('OTHER-NAME'), name: 'Personal iPhone', state: 'Booted', available: true, runtimeIdentifier: 'runtime-26' },
        { udid: deviceId('OTHER-RUNTIME'), name: 'DSH Gestalt iPhone', state: 'Booted', available: true, runtimeIdentifier: 'runtime-25' },
        { udid: deviceId('STOPPED'), name: 'DSH Gestalt iPhone', state: 'Shutdown', available: true, runtimeIdentifier: 'runtime-26' },
      ],
    })).toMatchObject({ kind: 'ready', deviceId: 'STOPPED', running: false })
  })
})
