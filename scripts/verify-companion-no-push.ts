/** Reject Mobile Companion push product residue from shipped source and configuration. */

import { globSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const PRODUCT_GLOBS = [
  'apps/**/*',
  'packages/**/*',
  'examples/**/*',
  'native/**/*',
  'python/**/*',
  'website/**/*',
  '.github/**/*',
  'scripts/**/*',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '*.{json,yaml,yml,toml,ts,mjs,cjs}',
]

const EXCLUDED_PATHS = [
  /(?:^|\/)(?:node_modules|\.git|\.gradle|lib|dist|DerivedData|coverage|tests?|__tests__|snapshots)(?:\/|$)/u,
  /^apps\/mobile\/(?:android\/(?:app\/)?build|android\/app\/src\/main\/assets\/public|ios\/App\/App\/public|release)(?:\/|$)/u,
  /(?:^|\/)(?:README|CONTEXT)(?:\.zh)?\.md$/u,
  /\.md$|\.i18n\.yaml$|(?:\.spec|\.test)\.[^.]+$/u,
  /^scripts\/verify-companion-no-push\.ts$/u,
] as const

const FORBIDDEN_PATHS = [
  { label: 'google-services.json', pattern: /(?:^|\/)google-services\.json$/iu },
  { label: 'GoogleService-Info.plist', pattern: /(?:^|\/)GoogleService-Info\.plist$/u },
  { label: 'firebase-messaging-sw.js', pattern: /(?:^|\/)firebase-messaging-sw\.(?:js|ts)$/iu },
] as const

const FORBIDDEN_TOKENS = [
  { label: 'APNs', pattern: /(?:^|[^a-z0-9])apns(?:$|[^a-z0-9])/iu },
  { label: 'FCM', pattern: /(?:^|[^a-z0-9])fcm(?:$|[^a-z0-9])/iu },
  { label: 'CompanionPush symbol', pattern: /\bCompanionPush[A-Za-z0-9_]*\b/u },
  { label: 'device token symbol', pattern: /\b(?:fcmToken|pushTokens?)\b/iu },
  { label: 'push token repository', pattern: /\bPushTokenRepository[A-Za-z0-9_]*\b/u },
  { label: 'push token symbol', pattern: /\b(?:PushPlatform|PushTokenRegistration|PushTokenStore)\b/u },
  { label: 'push product language', pattern: /\bpush[- ](?:token|notification|delivery|provider|hint|quota|metric|secret)s?\b/iu },
  { label: 'push product language', pattern: /推送(?:令牌|通知|投递|供应商|提示|配额|指标|密钥|服务)/u },
  { label: 'push operation', pattern: /\b(?:emit|register|unregister)-push-(?:hint|token)\b/u },
  { label: 'push quota or persistence', pattern: /\bpushHints(?:At|PerAccountPerDay)\b/u },
  { label: 'Capacitor push dependency', pattern: /@capacitor\/push-notifications\b/u },
  { label: 'native notification dependency', pattern: /\b(?:expo-notifications|firebase-admin|firebase\/messaging|@react-native-firebase\/messaging|FirebaseMessaging|node-apn)\b/u },
  { label: 'native notification dependency', pattern: /com\.google\.firebase:firebase-messaging\b/u },
  { label: 'native notification configuration', pattern: /\b(?:aps-environment|remote-notification|POST_NOTIFICATIONS)\b/iu },
  { label: 'native notification configuration', pattern: /\bgoogle-services(?:\.json)?\b/iu },
  { label: 'native notification API', pattern: /\bUNUserNotificationCenter\b/u },
] as const

const RELEASE_PUSH_EVIDENCE = /["']push["']/u

/**
 * Find forbidden Companion push product tokens in shipped source and configuration.
 * @param root - repository root or a fixture with the same relative layout.
 * @returns stable path-and-line diagnostics.
 */
export function collectCompanionPushResidue(root: string): string[] {
  const files = new Set<string>()
  for (const pattern of PRODUCT_GLOBS) {
    for (const file of globSync(pattern, { cwd: root })) {
      const relative = file.split(sep).join('/')
      if (!EXCLUDED_PATHS.some(excluded => excluded.test(relative)) && statSync(resolve(root, file)).isFile()) {
        files.add(relative)
      }
    }
  }
  const failures: string[] = []
  for (const file of [...files].sort()) {
    const forbiddenPath = FORBIDDEN_PATHS.find(({ pattern }) => pattern.test(file))
    if (forbiddenPath !== undefined) {
      failures.push(`${file}: contains forbidden Companion push product path ${forbiddenPath.label}.`)
    }
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const forbidden = file.endsWith('companion-release.ts') && RELEASE_PUSH_EVIDENCE.test(line)
        ? { label: 'release push evidence' }
        : FORBIDDEN_TOKENS.find(({ pattern }) => pattern.test(line))
      if (forbidden === undefined) return
      failures.push(
        `${file}:${String(index + 1)}: contains forbidden Companion push product token ${forbidden.label}.`,
      )
    })
  }
  return failures
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const failures = collectCompanionPushResidue(ROOT)
  if (failures.length > 0) {
    process.stderr.write('verify-companion-no-push: product residue found:\n')
    for (const failure of failures) process.stderr.write(`  ${failure}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-companion-no-push: shipped source and configuration contain no Companion push product.\n')
}
