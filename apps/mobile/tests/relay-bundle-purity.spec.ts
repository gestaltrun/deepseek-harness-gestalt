import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

const MOBILE_ROOT = fileURLToPath(new URL('..', import.meta.url))

// The real bundle resolves workspace package entries to their built lib/ artifacts.
// Coverage does not build them; the snapshots job builds first and includes this file.
const builtClientLibsPresent = existsSync(
  fileURLToPath(new URL('../../../packages/platform/platform-account-client/lib/index.js', import.meta.url)),
)

describe.skipIf(!builtClientLibsPresent)('Mobile Relay bundle purity', () => {
  it('builds the real Vite entry without importing a Node builtin', async () => {
    const result = await build({
      root: MOBILE_ROOT,
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      build: { write: false },
      logLevel: 'silent',
    })
    const outputs = Array.isArray(result) ? result : [result]
    const artifacts = outputs.flatMap(output => 'output' in output ? output.output : [])
    const chunks = artifacts.filter(artifact => artifact.type === 'chunk')
    const assets = artifacts.filter(artifact => artifact.type === 'asset')
    const emitted = [
      ...chunks.flatMap(chunk => [chunk.code, ...chunk.imports, ...chunk.dynamicImports]),
      ...assets.map(asset => typeof asset.source === 'string' ? asset.source : ''),
    ].join('\n')

    expect(chunks.some(chunk => chunk.isEntry)).toBe(true)
    expect(emitted).not.toMatch(/(?:from\s*["']|import\s*\()["']node:/u)
  }, 30_000)
})
