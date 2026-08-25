import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')

describe('packaged Desktop main bundle', () => {
  it('writes the public Relay configuration consumed by an ambient-env-free package', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-desktop-release-config-'))
    const output = join(temporary, 'operated-platform.json')
    try {
      execFileSync(process.execPath, [join(desktop, 'scripts', 'write-operated-platform-config.mjs'), output], {
        cwd: desktop,
        env: {
          PATH: process.env.PATH,
          PLATFORM_ORIGIN: 'https://platform.release.example',
          PLATFORM_GITHUB_CALLBACK: 'https://platform.release.example/v1/account/oauth/github/callback',
          PLATFORM_GITHUB_CLIENT_ID: 'release-client',
          PLATFORM_GITHUB_CREDENTIAL_REFERENCE: 'credentials://release-client',
          PLATFORM_POSTGRES_DATABASE: 'release-database',
          PLATFORM_IDENTITY_NAMESPACE: 'release-identity',
          DESKTOP_COMPANION_ATTACHMENT_HOST_TIMEOUT_MS: '120000',
          DESKTOP_REMOTE_RELAY_ATTACH_TIMEOUT_MS: '10000',
          DESKTOP_REMOTE_RELAY_NEGOTIATION_TIMEOUT_MS: '10000',
          DESKTOP_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS: '30000',
          DESKTOP_REMOTE_RELAY_RECONNECT_DELAY_MS: '1000',
          DESKTOP_REMOTE_RELAY_INBOUND_MAX_BYTES: '1048576',
          DESKTOP_REMOTE_RELAY_INBOUND_MAX_MESSAGES: '16',
        },
        stdio: 'pipe',
      })
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        origin: 'https://platform.release.example',
        remoteRelay: {
          url: 'wss://platform.release.example/v1/remote-access/relay',
          negotiationTimeoutMs: 10_000,
          inboundMaxBytes: 1_048_576,
        },
      })
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('requires a complete operated Platform config artifact at build time', () => {
    const env = { ...process.env }
    delete env.DSH_DESKTOP_OPERATED_PLATFORM_CONFIG
    expect(() => execFileSync(process.execPath, [join(desktop, 'scripts', 'build-main.mjs')], {
      cwd: desktop,
      env,
      stdio: 'pipe',
    })).toThrow()
  })

  it('rejects unknown input fields before writing the public packaged artifact', () => {
    const fixture = JSON.parse(readFileSync(
      join(desktop, 'tests', 'fixtures', 'operated-platform.json'),
      'utf8',
    )) as Record<string, unknown>
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-desktop-platform-config-'))
    const source = join(temporary, 'operated-platform.json')
    writeFileSync(source, JSON.stringify({ ...fixture, databasePassword: 'must-not-package' }))
    const artifact = join(desktop, 'out', 'operated-platform.json')
    rmSync(artifact, { force: true })
    try {
      expect(() => execFileSync(process.execPath, [join(desktop, 'scripts', 'build-main.mjs'), source], {
        cwd: desktop,
        stdio: 'pipe',
      })).toThrow()
      expect(existsSync(artifact)).toBe(false)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('inlines workspace packages and externalizes native runtime dependencies', () => {
    execFileSync(process.execPath, [
      join(desktop, 'scripts', 'build-main.mjs'),
      join(desktop, 'tests', 'fixtures', 'operated-platform.json'),
    ], {
      cwd: desktop,
      stdio: 'pipe',
    })
    const source = readFileSync(join(desktop, 'out', 'main.mjs'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]@deepseek-ai\//)
    expect(source).not.toMatch(/import\s+['"]@deepseek-ai\//)
    expect(source).toMatch(/from\s+['"]electron['"]/)
    expect(source).toMatch(/import\s*\(\s*['"]electron-updater['"]\s*\)/)
    expect(source).toMatch(/from\s+['"]ws['"]/)
    expect(source).not.toContain('node_modules/ws/lib/websocket.js')
    const desktopPackage = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(desktopPackage.dependencies?.ws).toBe('^8.21.0')
    expect(source).toContain('companion entry search')
    expect(source).not.toContain('DSH_PLATFORM_ORIGIN')
    expect(JSON.parse(readFileSync(join(desktop, 'out', 'operated-platform.json'), 'utf8'))).toEqual({
      environment: 'production',
      origin: 'https://platform.fixture.example',
      callbackUrl: 'https://platform.fixture.example/v1/account/oauth/github/callback',
      githubClientId: 'desktop-packaged-fixture',
      credentialReference: 'credentials://github-oauth/desktop-packaged-fixture',
      databaseIdentity: 'desktop-packaged-fixture',
      identityNamespace: 'desktop-packaged-fixture',
      companionAttachmentHostTimeoutMs: 120_000,
      remoteRelay: {
        url: 'wss://platform.fixture.example/v1/remote-access/relay',
        attachTimeoutMs: 10_000,
        negotiationTimeoutMs: 10_000,
        heartbeatIntervalMs: 30_000,
        reconnectDelayMs: 1_000,
        inboundMaxBytes: 1_048_576,
        inboundMaxMessages: 16,
      },
    })
  })
})
