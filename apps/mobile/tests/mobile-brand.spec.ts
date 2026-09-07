import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const IOS_ICON = new URL('../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', import.meta.url)

describe('Mobile brand validation', () => {
  it('uses the 獭子哥 name in every consumer-facing owner', () => {
    const capacitor = source('../capacitor.config.ts')
    const document = source('../index.html')
    const ios = source('../ios/App/App/Info.plist')
    const android = source('../android/app/src/main/res/values/strings.xml')
    const account = source('../src/MobileAccount.tsx')

    expect(capacitor).toContain("appName: '獭子哥'")
    expect(document).toContain('<title>獭子哥</title>')
    expect(ios).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>獭子哥<\/string>/u)
    expect(android).toContain('<string name="app_name">獭子哥</string>')
    expect(android).toContain('<string name="title_activity_main">獭子哥</string>')
    expect(account).toContain('<div className={css.mark} aria-hidden="true">獭</div>')
    expect(account).toContain('<p className={css.product}>獭子哥</p>')

    for (const owner of [capacitor, document, ios, android, account]) {
      expect(owner).not.toMatch(/DeepSeek Gestalt|千机-Gestalt/u)
    }
  })

  it('keeps the Gestalt build identity separate from the 獭子哥 display name', () => {
    const android = source('../scripts/build-android-release.sh')
    const ios = source('../scripts/build-ios-release.sh')
    const gradle = source('../android/app/build.gradle')
    const workflow = source('../../../.github/workflows/mobile-release.yml')

    for (const release of [android, ios]) {
      const buildPrerequisite = release.indexOf('pnpm run build:lib:host')
      const brandValidation = release.indexOf('pnpm --filter @deepseek-ai/dsh-mobile run verify:brand')
      expect(buildPrerequisite).toBeGreaterThanOrEqual(0)
      expect(brandValidation).toBeGreaterThan(buildPrerequisite)
    }
    expect(workflow.match(/run: bash apps\/mobile\/scripts\/build-android-release\.sh/gu)).toHaveLength(2)
    expect(android).toContain('Gestalt-${MOBILE_VERSION}-${MOBILE_BUILD_NUMBER}.apk')
    expect(android).toContain('-PdshMobileVersionCode="${MOBILE_BUILD_NUMBER}"')
    expect(android).toContain('-PdshMobileVersionName="${MOBILE_VERSION}"')
    expect(android).toContain('versionCode=\'${MOBILE_BUILD_NUMBER}\'')
    expect(android).toContain('package: name=\'${bundle_id}\'')
    expect(android).toContain('application-label:\'獭子哥\'')
    expect(android).not.toContain('android.injected.version')
    expect(gradle).toContain("project.findProperty('dshMobileVersionCode')")
    expect(gradle).toContain("project.findProperty('dshMobileVersionName')")
    expect(ios).toContain('PRODUCT_NAME=Gestalt')
    expect(ios).toContain('Gestalt-${MOBILE_VERSION}-${MOBILE_BUILD_NUMBER}.ipa')
    expect(ios).toContain('Print :CFBundleDisplayName')
    expect(ios).toContain('Print :CFBundleIdentifier')
    expect(workflow).toContain("require('./apps/mobile/package.json').version")
    expect(workflow).toContain("require('./apps/mobile/release.json').buildNumber")
    expect(workflow).toContain('name: gestalt-android-${{ needs.release-version.outputs.version }}-${{ needs.release-version.outputs.build_number }}')
    expect(workflow).toContain('name: gestalt-ios-${{ needs.release-version.outputs.version }}-${{ needs.release-version.outputs.build_number }}')
  })

  it('uses com.gestalt.mobile as the sole native application identity', () => {
    const capacitor = source('../capacitor.config.ts')
    const gradle = source('../android/app/build.gradle')
    const androidStrings = source('../android/app/src/main/res/values/strings.xml')
    const androidActivity = source('../android/app/src/main/java/com/gestalt/mobile/MainActivity.java')
    const androidStorage = source('../android/app/src/main/java/com/gestalt/mobile/GestaltProtectedStoragePlugin.java')
    const iosProject = source('../ios/App/App.xcodeproj/project.pbxproj')
    const iosStorage = source('../ios/App/App/GestaltProtectedStoragePlugin.swift')
    const iosExport = source('../ios/AppStoreExportOptions.plist')
    const androidRelease = source('../scripts/build-android-release.sh')
    const iosRelease = source('../scripts/build-ios-release.sh')
    const workflow = source('../../../.github/workflows/mobile-release.yml')

    expect(capacitor).toContain("appId: 'com.gestalt.mobile'")
    expect(gradle).toContain('namespace = "com.gestalt.mobile"')
    expect(gradle).toContain('applicationId "com.gestalt.mobile"')
    expect(androidStrings).toContain('<string name="package_name">com.gestalt.mobile</string>')
    expect(androidStrings).toContain('<string name="custom_url_scheme">com.gestalt.mobile</string>')
    expect(androidActivity).toContain('package com.gestalt.mobile;')
    expect(androidStorage).toContain('"com.gestalt.mobile.protected-storage.v1"')
    expect(iosProject.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.gestalt\.mobile;/gu)).toHaveLength(2)
    expect(iosProject.match(/PRODUCT_NAME = Gestalt;/gu)).toHaveLength(2)
    expect(iosStorage).toContain('"com.gestalt.mobile.protected-storage.v1"')
    expect(iosExport).toContain('<key>com.gestalt.mobile</key>')
    expect(androidRelease).toContain('MOBILE_BUNDLE_ID:?MOBILE_BUNDLE_ID is required')
    expect(iosRelease).toContain('MOBILE_BUNDLE_ID:?MOBILE_BUNDLE_ID is required')
    expect(androidRelease).not.toContain('MOBILE_BUNDLE_ID:-')
    expect(iosRelease).not.toContain('MOBILE_BUNDLE_ID:-')
    expect(workflow.match(/MOBILE_BUNDLE_ID: \$\{\{ vars\.MOBILE_BUNDLE_ID \}\}/gu)).toHaveLength(3)
    for (const job of ['android-acceptance-candidate', 'android', 'ios']) {
      expect(workflow).toMatch(new RegExp(`\\n  ${job}:[\\s\\S]*?MOBILE_BUNDLE_ID: \\$\\{\\{ vars\\.MOBILE_BUNDLE_ID \\}\\}`, 'u'))
    }

    for (const owner of [
      capacitor,
      gradle,
      androidStrings,
      androidActivity,
      androidStorage,
      iosProject,
      iosStorage,
      iosExport,
      androidRelease,
      iosRelease,
      workflow,
    ]) {
      expect(owner).not.toContain('com.alibaba.gestalt.mobile')
    }
  })

  it('uses one opaque iOS master and complete Android launcher families', () => {
    verifyPng(readFileSync(IOS_ICON), { width: 1024, height: 1024, alpha: false })

    const densities = [
      ['mdpi', 48, 108],
      ['hdpi', 72, 162],
      ['xhdpi', 96, 216],
      ['xxhdpi', 144, 324],
      ['xxxhdpi', 192, 432],
    ] as const
    for (const [density, legacy, foreground] of densities) {
      const directory = `../android/app/src/main/res/mipmap-${density}`
      verifyPng(readFileSync(new URL(`${directory}/ic_launcher.png`, import.meta.url)), {
        width: legacy, height: legacy, alpha: false,
      })
      verifyPng(readFileSync(new URL(`${directory}/ic_launcher_round.png`, import.meta.url)), {
        width: legacy, height: legacy, alpha: true,
      })
      verifyPng(readFileSync(new URL(`${directory}/ic_launcher_foreground.png`, import.meta.url)), {
        width: foreground, height: foreground, alpha: false,
      })
    }
  })

  it('rejects an incorrectly sized or transparent iOS master', () => {
    const wrongSize = Buffer.from(readFileSync(IOS_ICON))
    wrongSize.writeUInt32BE(512, 16)
    expect(() => { verifyPng(wrongSize, { width: 1024, height: 1024, alpha: false }) })
      .toThrow('expected 1024x1024')

    const transparent = Buffer.from(readFileSync(IOS_ICON))
    transparent[25] = 6
    expect(() => { verifyPng(transparent, { width: 1024, height: 1024, alpha: false }) })
      .toThrow('expected alpha=false')
  })
})

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function verifyPng(
  bytes: Buffer,
  expected: { width: number; height: number; alpha: boolean },
): void {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, signature.length).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('mobile-brand: expected a PNG with an IHDR header')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width !== expected.width || height !== expected.height) {
    throw new Error(`mobile-brand: expected ${String(expected.width)}x${String(expected.height)}, received ${String(width)}x${String(height)}`)
  }
  const colorType = bytes[25]
  const alpha = colorType === 4 || colorType === 6
  if (alpha !== expected.alpha) {
    throw new Error(`mobile-brand: expected alpha=${String(expected.alpha)}, received alpha=${String(alpha)}`)
  }
}
