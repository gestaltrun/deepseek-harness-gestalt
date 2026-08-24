import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectCompanionPushResidue } from './verify-companion-no-push.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Companion push absence gate', () => {
  it('rejects product symbols, operations, secrets, and native dependencies without banning ordinary arrays', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-companion-no-push-'))
    roots.push(root)
    mkdirSync(join(root, 'apps/mobile/src'), { recursive: true })
    mkdirSync(join(root, 'packages/client/ui-better-sidebar/src/client'), { recursive: true })
    mkdirSync(join(root, 'packages/platform/remote-access/src'), { recursive: true })
    writeFileSync(join(root, 'apps/mobile/src/list.ts'), 'const values: string[] = []\nvalues.push("ok")\n')
    writeFileSync(join(root, 'apps/mobile/src/notifications.ts'), 'const provider = "APNs"\n')
    writeFileSync(join(root, 'apps/mobile/src/push-language.ts'), 'const label = "推送通知"\n')
    writeFileSync(
      join(root, 'packages/client/ui-better-sidebar/src/client/locales.ts'),
      'const gitHelp = "push 策略硬拦；不允许模型自动推送"\n',
    )
    writeFileSync(join(root, 'packages/platform/remote-access/src/config.ts'), 'const secret = "PLATFORM_FCM_KEY"\n')

    expect(collectCompanionPushResidue(root)).toEqual([
      'apps/mobile/src/notifications.ts:1: contains forbidden Companion push product token APNs.',
      'apps/mobile/src/push-language.ts:1: contains forbidden Companion push product token push product language.',
      'packages/platform/remote-access/src/config.ts:1: contains forbidden Companion push product token FCM.',
    ])
  })

  it('scans public assets, native projects, manifests, scripts, workflows, and release evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-companion-no-push-paths-'))
    roots.push(root)
    const files: Record<string, string> = {
      '.github/workflows/mobile-release.yml': 'secret: PLATFORM_FCM_KEY\n',
      'apps/desktop/build/entitlements.mac.plist': '<key>aps-environment</key>\n',
      'apps/mobile/android/app/google-services.json': '{}\n',
      'apps/mobile/android/app/src/main/AndroidManifest.xml': '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n',
      'apps/mobile/ios/App/App.entitlements': '<key>aps-environment</key>\n',
      'apps/mobile/ios/App/Notifications.swift': 'UNUserNotificationCenter.current()\n',
      'apps/mobile/package.json': '{"dependencies":{"expo-notifications":"1.0.0"}}\n',
      'apps/mobile/public/firebase-messaging-sw.js': 'self.addEventListener("message", () => {})\n',
      'apps/mobile/src/companion-release.ts': 'const checks = ["push"]\n',
      'packages/platform/remote-access/package.json': '{"dependencies":{"node-apn":"1.0.0"}}\n',
      'packages/platform/remote-access/src/push-store.ts': 'class PushTokenRepositoryMemory {}\n',
      'scripts/mobile-release.ts': 'const fcmToken = process.env.VALUE\n',
      'scripts/mobile-tokens.ts': 'const pushTokens: string[] = []\n',
    }
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), contents)
    }

    const failures = collectCompanionPushResidue(root)
    expect(failures).toEqual(expect.arrayContaining([
      '.github/workflows/mobile-release.yml:1: contains forbidden Companion push product token FCM.',
      'apps/desktop/build/entitlements.mac.plist:1: contains forbidden Companion push product token native notification configuration.',
      'apps/mobile/android/app/google-services.json: contains forbidden Companion push product path google-services.json.',
      'apps/mobile/android/app/src/main/AndroidManifest.xml:1: contains forbidden Companion push product token native notification configuration.',
      'apps/mobile/ios/App/App.entitlements:1: contains forbidden Companion push product token native notification configuration.',
      'apps/mobile/ios/App/Notifications.swift:1: contains forbidden Companion push product token native notification API.',
      'apps/mobile/package.json:1: contains forbidden Companion push product token native notification dependency.',
      'apps/mobile/public/firebase-messaging-sw.js: contains forbidden Companion push product path firebase-messaging-sw.js.',
      'apps/mobile/src/companion-release.ts:1: contains forbidden Companion push product token release push evidence.',
      'packages/platform/remote-access/package.json:1: contains forbidden Companion push product token native notification dependency.',
      'packages/platform/remote-access/src/push-store.ts:1: contains forbidden Companion push product token push token repository.',
      'scripts/mobile-release.ts:1: contains forbidden Companion push product token device token symbol.',
      'scripts/mobile-tokens.ts:1: contains forbidden Companion push product token device token symbol.',
    ]))
    expect(failures).toHaveLength(13)
  })

  it('finds no Companion push product residue in the repository', () => {
    expect(collectCompanionPushResidue(join(import.meta.dirname, '..'))).toEqual([])
  }, 15_000)

  it('ignores Gradle build caches while retaining native source enforcement', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-companion-no-push-gradle-cache-'))
    roots.push(root)
    const files: Record<string, string> = {
      'apps/mobile/android/.gradle/8.10/fileHashes/google-services-index.bin': 'FCM cache index',
      'apps/mobile/android/app/build/intermediates/lint-cache/google-services.xml': '<fcmToken />',
      'apps/mobile/android/app/src/main/google-services.json': '{}',
      'apps/mobile/android/app/src/main/Notifications.kt': 'val service = "APNs"',
    }
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), contents)
    }

    expect(collectCompanionPushResidue(root)).toEqual([
      'apps/mobile/android/app/src/main/Notifications.kt:1: contains forbidden Companion push product token APNs.',
      'apps/mobile/android/app/src/main/google-services.json: contains forbidden Companion push product path google-services.json.',
    ])
  })
})
