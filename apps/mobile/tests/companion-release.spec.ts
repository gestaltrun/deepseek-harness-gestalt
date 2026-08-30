import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPANION_RELEASE_DEVICE_CHECKS,
  COMPANION_RELEASE_FLOWS,
  COMPANION_RELEASE_PLATFORMS,
  authorizeCompanionDistribution,
  companionReleaseReady,
  createCompanionReleaseAttestation,
  verifyCompanionReleaseAttestation,
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

const identity = {
  repository: 'gestaltrun/deepseek-harness-gestalt',
  sourceRunId: 123,
  candidateSha: 'a'.repeat(40),
  tree: 'b'.repeat(40),
}

function operatorEvidence() {
  return {
    flows: [...COMPANION_RELEASE_FLOWS],
    devices: COMPANION_RELEASE_PLATFORMS.flatMap(platform =>
      COMPANION_RELEASE_DEVICE_CHECKS.map(check => `${platform}:${check}` as const)),
    upgradePreservedKeys: true,
    uiAcceptance: true,
    failureAcceptance: true,
    transportRiskAccepted: true,
  }
}

describe('Companion release validation', () => {
  it('uses complete-link pairing without requiring camera acceptance', () => {
    expect(COMPANION_RELEASE_FLOWS).toContain('link-pairing')
    expect(COMPANION_RELEASE_FLOWS).not.toContain('camera-pairing')
  })

  it('does not register an interceptable custom scheme for the pairing invitation', () => {
    const android = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    const ios = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8')
    expect(android).not.toContain('android:scheme="deepseek-gestalt"')
    expect(ios).not.toContain('<string>deepseek-gestalt</string>')
    expect(COMPANION_RELEASE_DEVICE_CHECKS).not.toContain('deep-link')
  })

  it('keeps phone presentation portrait and declares every iPad multitasking orientation', () => {
    const android = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
    const ios = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8')

    expect(android).toContain('android:screenOrientation="portrait"')
    expect(ios.match(/<key>UISupportedInterfaceOrientations<\/key>[\s\S]*?<\/array>/u)?.[0])
      .not.toContain('UIInterfaceOrientationLandscape')
    const ipadOrientations = ios.match(/<key>UISupportedInterfaceOrientations~ipad<\/key>[\s\S]*?<\/array>/u)?.[0]
    expect(ipadOrientations).toContain('<string>UIInterfaceOrientationPortrait</string>')
    expect(ipadOrientations).toContain('<string>UIInterfaceOrientationPortraitUpsideDown</string>')
    expect(ipadOrientations).toContain('<string>UIInterfaceOrientationLandscapeLeft</string>')
    expect(ipadOrientations).toContain('<string>UIInterfaceOrientationLandscapeRight</string>')
  })

  it.runIf(process.platform === 'darwin')(
    'parses provisioning-profile expiration from a locale-independent UTC value',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-profile-expiration-'))
      const profile = join(directory, 'profile.plist')
      writeFileSync(profile, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>ExpirationDate</key><date>2030-01-02T03:04:05Z</date></dict></plist>
`)
      try {
        const parser = fileURLToPath(new URL('../scripts/ios-profile-expiration-epoch.sh', import.meta.url))
        const epoch = execFileSync('bash', [parser, profile], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai' },
        }).trim()
        expect(epoch).toBe(String(Date.parse('2030-01-02T03:04:05Z') / 1_000))
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    },
  )

  it.runIf(process.platform === 'darwin')(
    'validates the release Info.plist orientation lists through plutil',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-release-orientations-'))
      const invalidPlist = join(directory, 'Info.plist')
      const validator = fileURLToPath(new URL(
        '../scripts/verify-ios-release-orientations.sh', import.meta.url,
      ))
      const plist = fileURLToPath(new URL('../ios/App/App/Info.plist', import.meta.url))
      try {
        expect(() => execFileSync('bash', [validator, plist], { encoding: 'utf8' })).not.toThrow()
        writeFileSync(invalidPlist, readFileSync(plist, 'utf8').replace(
          '<string>UIInterfaceOrientationLandscapeRight</string>',
          '<string>UIInterfaceOrientationPortrait</string>',
        ))
        expect(() => execFileSync('bash', [validator, invalidPlist], {
          encoding: 'utf8',
          stdio: 'pipe',
        })).toThrow()
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'keeps the TestFlight password out of the altool process arguments',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-mobile-testflight-upload-'))
      const ipa = join(directory, 'candidate.ipa')
      const capturedArguments = join(directory, 'arguments.txt')
      const fakeXcrun = join(directory, 'xcrun')
      const password = 'test-app-specific-password'
      writeFileSync(ipa, 'fixture')
      writeFileSync(fakeXcrun, `#!/usr/bin/env bash
set -euo pipefail
[[ -n "\${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]
printf '%s\n' "$@" > "\${DSH_CAPTURE_ARGUMENTS:?}"
printf 'upload invoked\n'
`)
      chmodSync(fakeXcrun, 0o755)
      try {
        const uploader = fileURLToPath(new URL('../scripts/upload-testflight.sh', import.meta.url))
        const result = spawnSync('bash', [uploader], {
          encoding: 'utf8',
          env: {
            ...process.env,
            APPLE_APP_SPECIFIC_PASSWORD: password,
            APPLE_ID: 'release@example.test',
            DSH_CAPTURE_ARGUMENTS: capturedArguments,
            IPA_PATH: ipa,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
          },
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        const capturedArgumentText = readFileSync(capturedArguments, 'utf8')
        const argumentsList = capturedArgumentText.trim().split('\n')
        const passwordIndex = argumentsList.indexOf('--password')
        expect(argumentsList[passwordIndex + 1]).toBe('@env:APPLE_APP_SPECIFIC_PASSWORD')
        expect(capturedArgumentText).not.toContain(password)
        expect(result.stdout).not.toContain(password)
        expect(result.stderr).not.toContain(password)
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    },
  )

  it('keeps the Session action dock on the phone viewport and styles per-Workspace paging', () => {
    const styles = readFileSync(new URL('../src/MobileBrowse.module.css', import.meta.url), 'utf8')

    expect(styles).toMatch(/\.page\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.dock\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;/u)
    expect(styles).toMatch(/\.groupMore\s*\{[\s\S]*?border-radius:\s*12px;[\s\S]*?background:/u)
    expect(styles).toMatch(/\.searchPill,[\s\S]*?border:\s*1px solid var\(--dsw-alias-border-l4\);/u)
    expect(styles).toMatch(/\.searchPill,[\s\S]*?background:\s*var\(--dsw-alias-bg-module-platform\);/u)
    expect(styles).toMatch(/\.searchPill,[\s\S]*?color:\s*var\(--dsw-alias-label-primary\);/u)
    expect(styles).toMatch(/\.searchPanel input::placeholder\s*\{[\s\S]*?color:\s*var\(--dsw-alias-label-secondary\);/u)
  })

  it('keeps pairing controls beside one replaceable method stage', () => {
    const styles = readFileSync(new URL('../src/MobilePairing.module.css', import.meta.url), 'utf8')
    const actions = styles.match(/\.taskActions\s*\{([\s\S]*?)\}/u)?.[1]

    expect(styles).toMatch(/\.methodStage\s*\{[\s\S]*?max-width:\s*360px;/u)
    expect(actions).not.toContain('margin-top: auto')
  })

  it('styles the conversation header and attachment control as phone chrome', () => {
    const styles = readFileSync(new URL('../src/MobileConversation.module.css', import.meta.url), 'utf8')
    const back = styles.match(/\.back\s*\{([\s\S]*?)\}/u)?.[1]
    const composer = styles.match(/\.composer\s*\{([\s\S]*?)\}/u)?.[1]
    const attachment = styles.match(/\.attachment\s*\{([\s\S]*?)\}/u)?.[1]

    expect(back).toContain('width: 40px')
    expect(back).toContain('height: 40px')
    expect(back).toContain('border: 0')
    expect(back).toContain('background: transparent')
    expect(composer).toContain('padding-bottom: env(safe-area-inset-bottom)')
    expect(attachment).toContain('width: 28px')
    expect(attachment).toContain('border-radius: 999px')
  })

  it('contains no notification-provider release evidence', () => {
    expect(COMPANION_RELEASE_DEVICE_CHECKS).not.toContain('push')
  })

  it('disables Capacitor logging for protected native bridge values', () => {
    const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8')

    expect(config).toContain("loggingBehavior: 'none'")
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

  it('keeps the operated iOS Simulator proxy out of release and physical-device builds', () => {
    const bridge = readFileSync(new URL(
      '../ios/App/App/GestaltBridgeViewController.swift', import.meta.url,
    ), 'utf8')

    expect(bridge).toContain('#if DEBUG && targetEnvironment(simulator)')
    expect(bridge).toContain('DSH_IOS_SIMULATOR_PROXY_HOST')
    expect(bridge).toContain('DSH_IOS_SIMULATOR_PROXY_PORT')
    expect(bridge).toContain('DispatchQueue.main.asyncAfter(deadline: .now() + 1)')
    expect(bridge).toContain('self?.webView?.configuration.websiteDataStore.proxyConfigurations = [proxy]')
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

  it('binds complete acceptance to one repository, run, commit, and tree', () => {
    const attestation = createCompanionReleaseAttestation(operatorEvidence(), identity)
    expect(verifyCompanionReleaseAttestation(attestation, identity, {
      testFlight: true,
      androidApk: true,
      transportRiskAccepted: true,
    })).toEqual({ testFlight: true, androidApk: true })
    expect(() => verifyCompanionReleaseAttestation(attestation, { ...identity, sourceRunId: 124 }, {
      testFlight: true, androidApk: true, transportRiskAccepted: true,
    })).toThrow('sourceRunId')
    expect(() => verifyCompanionReleaseAttestation(attestation, { ...identity, candidateSha: 'c'.repeat(40) }, {
      testFlight: true, androidApk: true, transportRiskAccepted: true,
    })).toThrow('candidateSha')
    expect(() => verifyCompanionReleaseAttestation(attestation, { ...identity, repository: 'other/repository' }, {
      testFlight: true, androidApk: true, transportRiskAccepted: true,
    })).toThrow('repository')
  })

  it('rejects missing, duplicate, unknown, and unapproved evidence', () => {
    const completeEvidence = operatorEvidence()
    expect(() => createCompanionReleaseAttestation({
      ...completeEvidence, flows: COMPANION_RELEASE_FLOWS.slice(1),
    }, identity)).toThrow('incomplete')
    expect(() => createCompanionReleaseAttestation({
      ...completeEvidence, flows: [...COMPANION_RELEASE_FLOWS, COMPANION_RELEASE_FLOWS[0]],
    }, identity)).toThrow('duplicates')
    expect(() => createCompanionReleaseAttestation({
      ...completeEvidence, flows: [...COMPANION_RELEASE_FLOWS, 'unknown-flow'],
    }, identity)).toThrow('unknown')
    const attestation = createCompanionReleaseAttestation(completeEvidence, identity)
    expect(() => verifyCompanionReleaseAttestation(attestation, identity, {
      testFlight: true, androidApk: true, transportRiskAccepted: false,
    })).toThrow('transport risk')
  })
})
