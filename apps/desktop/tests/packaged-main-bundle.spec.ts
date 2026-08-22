import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')

describe('packaged Desktop main bundle', () => {
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

  it('inlines workspace packages and leaves only Electron externals', () => {
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
    expect(source).not.toMatch(/from\s+['"]ws['"]/)
    expect(source).not.toContain('DSH_PLATFORM_ORIGIN')
    expect(JSON.parse(readFileSync(join(desktop, 'out', 'operated-platform.json'), 'utf8'))).toEqual({
      environment: 'production',
      origin: 'https://platform.fixture.example',
      callbackUrl: 'https://platform.fixture.example/v1/account/oauth/github/callback',
      githubClientId: 'desktop-packaged-fixture',
      credentialReference: 'credentials://github-oauth/desktop-packaged-fixture',
      databaseIdentity: 'desktop-packaged-fixture',
      identityNamespace: 'desktop-packaged-fixture',
    })
  })
})
