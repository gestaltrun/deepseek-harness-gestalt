import { describe, expect, it } from 'vitest'
import { planIosEnvironment } from '../src/planner.ts'

describe('iOS environment planner', () => {
  it.each([
    ['win32', 'Windows'],
    ['linux', 'Linux'],
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

  it('reports the managed simulator and whether it is booted', () => {
    expect(planIosEnvironment('darwin', {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '17.0',
      licenseAccepted: true,
      firstLaunchComplete: true,
      runtimes: [{ identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', available: true }],
      deviceTypes: [{ identifier: 'type-iphone-17', name: 'iPhone 17' }],
      devices: [{
        udid: 'SIMULATOR-UDID', name: 'DSH Gestalt iPhone', state: 'Booted',
        available: true, runtimeIdentifier: 'runtime-26-0',
      }],
    })).toMatchObject({ kind: 'ready', deviceId: 'SIMULATOR-UDID', running: true })
  })
})
