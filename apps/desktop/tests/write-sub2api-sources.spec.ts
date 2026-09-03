import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDesktopSub2ApiSources } from '../src/sub2api-sources.ts'
import { writePackagedSub2ApiSources } from '../scripts/write-sub2api-sources.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')
const catalogPath = join(desktop, 'sub2api-sources.catalog.json')

const DARWIN_ARM64 = {
  bundleUrl: 'https://github.com/gestaltrun/dsh-sub2api-sidecar/releases/download/v0.1.25/dsh-sub2api-sidecar-0.1.25.tgz',
  bundleSha256SumsUrl:
    'https://github.com/gestaltrun/dsh-sub2api-sidecar/releases/download/v0.1.25/bundle-sha256sums.txt',
  runtimePackUrl:
    'https://github.com/gestaltrun/dsh-sub2api-sidecar/releases/download/v0.1.25/runtime-pack-0.1.183-dsh.445.13-darwin-arm64.tar.gz',
  runtimePackSha256SumsUrl:
    'https://github.com/gestaltrun/dsh-sub2api-sidecar/releases/download/v0.1.25/runtime-pack-sha256sums.txt',
}

describe('approved Sub2API source catalog', () => {
  it('pins only darwin-arm64 public sidecar v0.1.25 assets', () => {
    expect(JSON.parse(readFileSync(catalogPath, 'utf8'))).toEqual({
      'darwin-arm64': DARWIN_ARM64,
    })
  })
})

describe('writePackagedSub2ApiSources', () => {
  it('writes the four-URL document for a cataloged platform and omits it otherwise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sub2api-sources-write-'))
    writeFileSync(join(root, 'sub2api-sources.catalog.json'), readFileSync(catalogPath))
    try {
      await writePackagedSub2ApiSources({ root, platform: 'darwin', arch: 'arm64' })
      const artifact = join(root, 'out', 'sub2api-sources.json')
      expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual(DARWIN_ARM64)
      expect(readDesktopSub2ApiSources(pathToFileURL(join(root, 'out', 'main.mjs')).href)).toEqual(DARWIN_ARM64)

      await writePackagedSub2ApiSources({ root, platform: 'darwin', arch: 'x64' })
      expect(existsSync(artifact)).toBe(false)
      expect(readDesktopSub2ApiSources(pathToFileURL(join(root, 'out', 'main.mjs')).href)).toBeUndefined()

      await writePackagedSub2ApiSources({ root, platform: 'win32', arch: 'x64' })
      expect(existsSync(artifact)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a catalog entry that is not four public HTTPS URLs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sub2api-sources-invalid-'))
    writeFileSync(join(root, 'sub2api-sources.catalog.json'), JSON.stringify({
      'darwin-arm64': { ...DARWIN_ARM64, bundleUrl: 'http://example.test/bundle.tgz' },
    }))
    try {
      await expect(writePackagedSub2ApiSources({ root, platform: 'darwin', arch: 'arm64' }))
        .rejects.toThrow('must be an https URL')
      expect(existsSync(join(root, 'out', 'sub2api-sources.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('build:main Sub2API sources write path', () => {
  it('never inlines sidecar URLs into Host source', () => {
    expect(readFileSync(join(desktop, 'src', 'sub2api-sources.ts'), 'utf8'))
      .not.toContain('github.com/gestaltrun/dsh-sub2api-sidecar')
    expect(readFileSync(join(desktop, 'src', 'sub2api.ts'), 'utf8'))
      .not.toContain('github.com/gestaltrun/dsh-sub2api-sidecar')
    expect(readFileSync(join(desktop, 'scripts', 'build-main.mjs'), 'utf8'))
      .toContain('writePackagedSub2ApiSources')
  })
})
