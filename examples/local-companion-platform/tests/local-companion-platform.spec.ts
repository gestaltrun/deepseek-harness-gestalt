import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  LOCAL_COMPANION_LISTEN_CONFIG,
  startLocalCompanionPlatform,
  validateListenConfig,
} from '../src/listen.ts'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const boot = readFileSync(new URL('../../../apps/platform/src/boot.ts', import.meta.url), 'utf8')
const listen = readFileSync(new URL('../src/listen.ts', import.meta.url), 'utf8')

describe('local companion Platform keyless assembled path', () => {
  it('keeps DevelopmentKeylessPairingHandshakeProvider off the production listen', () => {
    expect(boot).not.toContain('DevelopmentKeylessPairingHandshakeProvider')
    expect(boot).not.toContain('local-companion-platform')
    expect(listen).toContain('DevelopmentKeylessPairingHandshakeProvider')
  })

  it('answers healthz on the TLS origin and refuses a heartbeat that cannot keep the directory live', async () => {
    expect(() => {
      validateListenConfig({
        ...LOCAL_COMPANION_LISTEN_CONFIG,
        heartbeatIntervalMs: LOCAL_COMPANION_LISTEN_CONFIG.directoryTtlMs,
      })
    }).toThrow('heartbeatIntervalMs')
    const platform = await startLocalCompanionPlatform({
      ...LOCAL_COMPANION_LISTEN_CONFIG,
      port: 0,
      entropy: 'sequential',
    })
    try {
      const health = await platform.fetch(`${platform.origin}/healthz`)
      const ready = await platform.fetch(`${platform.origin}/readyz`)
      expect(health.status).toBe(200)
      expect(ready.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
      expect(platform.relayUrl).toBe(`${platform.origin.replace('https:', 'wss:')}/v1/remote-access/relay`)
    } finally {
      await platform.close()
    }
  })

  it('rewrites the Vite page origin onto the selected HTTPS origin for Account CORS', async () => {
    const pageOrigin = 'http://127.0.0.1:4173'
    const platform = await startLocalCompanionPlatform({
      ...LOCAL_COMPANION_LISTEN_CONFIG,
      port: 0,
      pageOrigin,
      entropy: 'sequential',
    })
    try {
      const preflight = await platform.fetch(`${platform.origin}/v1/account/login-attempts`, {
        method: 'OPTIONS',
        headers: {
          origin: pageOrigin,
          'access-control-request-method': 'POST',
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe(pageOrigin)
    } finally {
      await platform.close()
    }
  })

  it('boots the Loader and completes same-account pairing plus an encrypted Relay round trip', async () => {
    const result = await runLoaderSmoke({
      label: 'local-companion-platform',
      tempDirPrefix: 'local-companion-platform-',
      binScript: driver,
      libBinScript: driver,
      configPath: config,
      tsconfigPath: tsconfig,
      processTimeoutMs: 120_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatchInlineSnapshot(`
      "LOGIN desktop=octocat mobile=octocat sameAccount=true
      PAIRING defaultEnabled=false confirmed=paired authority=companion-surface qrEqualsLink=true
      AUTH_WORDS mobile=delta-zenith-jade-dawn-harbor-ember desktop=delta-zenith-jade-dawn-harbor-ember
      PAIRING_KEY bits=256 desktopEqualsMobile=true
      PLATFORM originProtocol=https: relayPath=/v1/remote-access/relay instances=2 nonSticky=true
      ROUND_TRIP encrypted=true outcome=accepted
      CRYPTO provider=keyless-proof reviewed=false listen=local-companion-platform
      "
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
