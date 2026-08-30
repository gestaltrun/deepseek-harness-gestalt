import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseDesktopSub2ApiSources, resolveSub2ApiSourcesPath, SUB2API_SOURCES_ENV,
} from '../src/sub2api-sources.ts'

const VALID = {
  bundleUrl: 'https://example.test/bundle.tgz',
  bundleSha256SumsUrl: 'https://example.test/SHA256SUMS',
  runtimePackUrl: 'https://example.test/runtime-pack.tar.gz',
  runtimePackSha256SumsUrl: 'https://example.test/runtime-SHA256SUMS',
}

describe('parseDesktopSub2ApiSources', () => {
  it('accepts a complete http(s) sources document', () => {
    expect(parseDesktopSub2ApiSources(VALID)).toEqual(VALID)
  })

  it('rejects non-object documents, unknown fields, missing fields, and non-http URLs', () => {
    expect(() => parseDesktopSub2ApiSources(null)).toThrow('must be a JSON object')
    expect(() => parseDesktopSub2ApiSources([])).toThrow('must be a JSON object')
    expect(() => parseDesktopSub2ApiSources({ ...VALID, extra: 1 })).toThrow('unknown fields: extra')
    const { bundleUrl: _dropped, ...missing } = VALID
    expect(() => parseDesktopSub2ApiSources(missing)).toThrow('require bundleUrl')
    expect(() => parseDesktopSub2ApiSources({ ...VALID, runtimePackUrl: 'not a url' }))
      .toThrow('not an absolute URL')
    expect(() => parseDesktopSub2ApiSources({ ...VALID, bundleSha256SumsUrl: 'ftp://example.test/x' }))
      .toThrow('must be an http(s) URL')
  })
})

describe('resolveSub2ApiSourcesPath', () => {
  it('prefers the environment override over the file beside the main entry', () => {
    const original = process.env[SUB2API_SOURCES_ENV]
    try {
      delete process.env.DSH_DESKTOP_SUB2API_SOURCES
      const moduleUrl = 'file:///app/out/main.mjs'
      expect(resolveSub2ApiSourcesPath(moduleUrl)).toBe('/app/out/sub2api-sources.json')
      process.env[SUB2API_SOURCES_ENV] = '/custom/sources.json'
      expect(resolveSub2ApiSourcesPath(moduleUrl)).toBe('/custom/sources.json')
    } finally {
      if (original === undefined) delete process.env.DSH_DESKTOP_SUB2API_SOURCES
      else process.env[SUB2API_SOURCES_ENV] = original
    }
  })
})

describe('readDesktopSub2ApiSources', () => {
  it('returns undefined when no sources file exists (placeholder state)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sub2api-sources-'))
    const original = process.env[SUB2API_SOURCES_ENV]
    try {
      process.env[SUB2API_SOURCES_ENV] = join(dir, 'missing.json')
      await expect(readSources()).resolves.toBeUndefined()
    } finally {
      restore(original)
    }
  })

  it('parses a valid file and fails loud on an invalid one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sub2api-sources-'))
    const file = join(dir, 'sources.json')
    const original = process.env[SUB2API_SOURCES_ENV]
    try {
      process.env[SUB2API_SOURCES_ENV] = file
      await writeFile(file, JSON.stringify(VALID))
      await expect(readSources()).resolves.toEqual(VALID)

      await writeFile(file, JSON.stringify({ ...VALID, bundleUrl: 42 }))
      await expect(readSources()).rejects.toThrow('bundleUrl')
    } finally {
      restore(original)
    }
  })

  it('fails loud on a file that is not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sub2api-sources-'))
    const file = join(dir, 'sources.json')
    const original = process.env[SUB2API_SOURCES_ENV]
    try {
      process.env[SUB2API_SOURCES_ENV] = file
      await writeFile(file, '{nope')
      await expect(readSources()).rejects.toThrow('not valid JSON')
    } finally {
      restore(original)
    }
  })

  /** Import lazily so the env override applies per call. */
  async function readSources(): Promise<unknown> {
    const module = await import('../src/sub2api-sources.ts')
    return module.readDesktopSub2ApiSources('file:///app/out/main.mjs')
  }

  function restore(original: string | undefined): void {
    if (original === undefined) delete process.env.DSH_DESKTOP_SUB2API_SOURCES
    else process.env[SUB2API_SOURCES_ENV] = original
  }
})
