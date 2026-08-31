import { describe, expect, it } from 'vitest'
import { planAndroidEnvironment } from '../src/planner.ts'

describe('Android environment planner', () => {
  it.each([
    ['darwin', 'arm64', 'arm64-v8a'],
    ['darwin', 'x64', 'x86_64'],
    ['linux', 'x64', 'x86_64'],
    ['win32', 'x64', 'x86_64'],
  ] as const)('pins API 35 for %s/%s', (platform, architecture, abi) => {
    const result = planAndroidEnvironment(platform, architecture, '/phone')
    expect(result.kind).toBe('supported')
    if (result.kind !== 'supported') return
    expect(result.plan).toMatchObject({
      sdkRoot: '/phone/android/sdk',
      avdHome: '/phone/android/avd',
      avdName: 'Pixel_6_API_35_Gestalt',
      abi,
      commandLineToolsVersion: '15859902',
      minimumFreeBytes: 16 * 1024 * 1024 * 1024,
    })
    expect(result.plan.packageIds).toEqual([
      'platform-tools',
      'emulator',
      `system-images;android-35;google_apis;${abi}`,
    ])
    expect(result.asset.url).toMatch(/^https:\/\/dl\.google\.com\/android\/repository\//u)
  })

  it.each([
    ['win32', 'arm64'],
    ['linux', 'arm64'],
    ['freebsd', 'x64'],
  ])('reports unsupported Host tuple %s/%s', (platform, architecture) => {
    const result = planAndroidEnvironment(platform, architecture, '/phone')
    expect(result.kind).toBe('unsupported')
    if (result.kind !== 'unsupported') throw new Error('unsupported Host tuple produced an Android plan')
    expect(result.reason).toContain('does not have a supported Android Emulator toolchain')
  })

  it('reuses a compatible SDK while retaining a private AVD home', () => {
    const result = planAndroidEnvironment('darwin', 'arm64', '/phone', {
      sdkRoot: '/existing-sdk',
      sdkSource: 'existing',
      commandLineTools: true,
      platformTools: true,
      emulator: true,
      systemImage: false,
      avd: false,
    })
    expect(result.kind).toBe('supported')
    if (result.kind !== 'supported') return
    expect(result.plan).toMatchObject({
      sdkRoot: '/existing-sdk',
      sdkSource: 'existing',
      avdHome: '/phone/android/avd',
      commandLineToolsBytes: 0,
      components: { commandLineTools: true, platformTools: true, emulator: true },
    })
  })
})
