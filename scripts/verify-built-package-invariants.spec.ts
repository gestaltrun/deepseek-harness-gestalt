import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const verifier = fileURLToPath(new URL('./verify-built-package-invariants.mjs', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  files?: string[]
  invariantSource?: string
  invariantExport?: string
  runtimeChunks?: Record<string, string>
} = {}): { root: string; loaderUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-built-package-invariants-'))
  roots.push(root)
  const packageDir = join(root, 'packages', 'core', 'probe')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-probe',
    type: 'module',
    files: options.files ?? ['lib/invariant.js'],
    exports: {
      './invariant': {
        default: options.invariantExport ?? './lib/invariant.js',
      },
    },
  }, null, 2)}\n`)
  writeFileSync(
    join(packageDir, 'lib/invariant.js'),
    options.invariantSource ?? "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
  )
  for (const [relativePath, source] of Object.entries(options.runtimeChunks ?? {})) {
    const path = join(packageDir, ...relativePath.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  const loaderPath = join(root, 'loader.mjs')
  writeFileSync(loaderPath, 'export default class Loader { unwrapExports(value) { return value } }\n')
  return { root, loaderUrl: pathToFileURL(loaderPath).href }
}

function verify(root: string, loaderUrl: string) {
  return spawnSync(process.execPath, [
    verifier,
    '--packages-root', root,
    '--loader-url', loaderUrl,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('built package invariant verifier', () => {
  it('loads the staged compiled self-reference through plain Node and Loader normalization', () => {
    const { root, loaderUrl } = fixture()
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 compiled companion(s) passed plain-Node Loader checks')
  })

  it('rejects a default export and a broken invariant export map', () => {
    const withDefault = fixture({
      invariantSource: "export default {}\nexport const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    })
    const defaultResult = verify(withDefault.root, withDefault.loaderUrl)
    expect(defaultResult.status).toBe(1)
    expect(defaultResult.stderr).toContain('companion has a default export')

    const brokenExport = fixture({ invariantExport: './lib/missing.js' })
    const exportResult = verify(brokenExport.root, brokenExport.loaderUrl)
    expect(exportResult.status).toBe(1)
    expect(exportResult.stderr).toContain('@deepseek-ai/dsh-probe')
  })

  it('stages manifest-declared transitive chunks from portable package paths', () => {
    const { root, loaderUrl } = fixture({
      files: ['lib/invariant.js', 'lib/chunks/**/*.js'],
      invariantSource: "export * from './chunks/entry.js'\n",
      runtimeChunks: {
        'lib/chunks/entry.js': "export * from './nested/runtime.js'\n",
        'lib/chunks/nested/runtime.js': "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
      },
    })
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects an invariant bundle whose staged chunk needs an undeclared transitive chunk', () => {
    const { root, loaderUrl } = fixture({
      files: ['lib/invariant.js', 'lib/chunks/entry.js'],
      invariantSource: "export * from './chunks/entry.js'\n",
      runtimeChunks: {
        'lib/chunks/entry.js': "export * from './nested/runtime.js'\n",
        'lib/chunks/nested/runtime.js': "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
      },
    })
    const result = verify(root, loaderUrl)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('runtime.js')
  })
})
