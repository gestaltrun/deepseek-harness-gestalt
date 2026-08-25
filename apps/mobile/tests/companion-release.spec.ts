import { describe, expect, it } from 'vitest'
import {
  COMPANION_RELEASE_DEVICE_CHECKS,
  COMPANION_RELEASE_FLOWS,
  COMPANION_RELEASE_PLATFORMS,
  authorizeCompanionDistribution,
  companionReleaseReady,
  type CompanionReleaseEvidence,
} from '../src/companion-release.ts'

function complete(): CompanionReleaseEvidence {
  return {
    flows: new Set(COMPANION_RELEASE_FLOWS),
    devices: new Set(COMPANION_RELEASE_PLATFORMS.flatMap(platform =>
      COMPANION_RELEASE_DEVICE_CHECKS.map(check => `${platform}:${check}` as const),
    )),
    upgradePreservedKeys: true,
    uiAcceptance: true,
    failureAcceptance: true,
  }
}

describe('Companion release validation', () => {
  it('does not register an interceptable custom scheme for the pairing invitation', () => {
    const android = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    const ios = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8')
    expect(android).not.toContain('android:scheme="deepseek-gestalt"')
    expect(ios).not.toContain('<string>deepseek-gestalt</string>')
    expect(COMPANION_RELEASE_DEVICE_CHECKS).not.toContain('deep-link')
  })

  it('contains no notification-provider release evidence', () => {
    expect(COMPANION_RELEASE_DEVICE_CHECKS).not.toContain('push')
  })

  it('returns an object when iOS protected storage has no retained value', () => {
    const plugin = readFileSync(new URL(
      '../ios/App/App/GestaltProtectedStoragePlugin.swift', import.meta.url,
    ), 'utf8')
    const missingValue = plugin.match(/if status == errSecItemNotFound \{([\s\S]*?)\n        \}/u)?.[1]
    expect(missingValue).toContain('call.resolve([:])')
    expect(missingValue).not.toContain('call.resolve()')
  })

  it('boots iOS through the bridge controller that registers protected storage', () => {
    const storyboard = readFileSync(new URL('../ios/App/App/Base.lproj/Main.storyboard', import.meta.url), 'utf8')

    expect(storyboard).toContain('customClass="GestaltBridgeViewController"')
    expect(storyboard).toContain('customModule="App"')
    expect(storyboard).not.toContain('customClass="CAPBridgeViewController"')
  })

  it('verifies Android release signatures with the Android SDK verifier only', () => {
    const packaging = readFileSync(new URL('../scripts/build-android-release.sh', import.meta.url), 'utf8')

    expect(packaging).toContain('ANDROID_SDK_ROOT')
    expect(packaging).toContain('ANDROID_HOME')
    expect(packaging).toContain('apksigner')
    expect(packaging).not.toContain('jarsigner')
  })

  it('requires every flow, both platforms, upgrade, UI, and failure acceptance', () => {
    expect(companionReleaseReady(complete())).toBe(true)
    expect(companionReleaseReady({ ...complete(), upgradePreservedKeys: false })).toBe(false)
    expect(companionReleaseReady({ ...complete(), uiAcceptance: false })).toBe(false)
    expect(companionReleaseReady({ ...complete(), failureAcceptance: false })).toBe(false)
    expect(companionReleaseReady({ ...complete(), flows: new Set(COMPANION_RELEASE_FLOWS.slice(1)) })).toBe(false)
    expect(companionReleaseReady({ ...complete(), devices: new Set() })).toBe(false)
  })

  it('does not authorize TestFlight or Android APK without explicit approval', () => {
    expect(authorizeCompanionDistribution(complete(), {})).toEqual({ testFlight: false, androidApk: false })
    expect(() => authorizeCompanionDistribution(complete(), { testFlight: true }))
      .toThrow('transport risk')
    expect(authorizeCompanionDistribution(complete(), {
      testFlight: true,
      transportRiskAccepted: true,
    })).toEqual({ testFlight: true, androidApk: false })
    expect(() => authorizeCompanionDistribution({ ...complete(), uiAcceptance: false }, {
      testFlight: true,
      transportRiskAccepted: true,
    }))
      .toThrow('incomplete')
  })
})
import { readFileSync } from 'node:fs'
