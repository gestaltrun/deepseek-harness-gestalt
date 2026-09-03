import { describe, expect, it } from 'vitest'
import { initialPhoneEnvironmentSnapshot, selectPhoneRuntimeCandidate } from '../src/index.ts'

describe('phone runtime candidate planner', () => {
  it('uses explicit override, then managed current, then system discovery', () => {
    expect(selectPhoneRuntimeCandidate({ override: '/override', managed: '/managed', system: '/system' }))
      .toEqual({ source: 'override', executablePath: '/override' })
    expect(selectPhoneRuntimeCandidate({ override: ' ', managed: '/managed', system: '/system' }))
      .toEqual({ source: 'managed', executablePath: '/managed' })
    expect(selectPhoneRuntimeCandidate({ system: '/system' }))
      .toEqual({ source: 'system', executablePath: '/system' })
    expect(selectPhoneRuntimeCandidate({})).toBeUndefined()
  })
})

describe('initial phone environment snapshot', () => {
  it('advertises the shared runtime download and defers both macOS platform sections', () => {
    expect(initialPhoneEnvironmentSnapshot('darwin', 'arm64', true)).toEqual({
      revision: 0,
      enabled: true,
      runtime: { kind: 'missing', targetVersion: '1.0.5', assetBytes: 5_458_848 },
      platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
    })
  })

  it.each(['linux', 'win32'])('makes iOS truthfully unavailable on %s', (platform) => {
    const snapshot = initialPhoneEnvironmentSnapshot(platform, 'x64', false)
    expect(snapshot.platforms.ios).toEqual({
      kind: 'unsupported',
      reason: 'iOS Simulator and physical iPhone control require macOS with a complete Xcode installation.',
    })
  })

  it('does not promise a download size for unsupported hosts', () => {
    expect(initialPhoneEnvironmentSnapshot('freebsd', 'x64', false).runtime).toEqual({
      kind: 'missing', targetVersion: '1.0.5',
    })
  })
})
