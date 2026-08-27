import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSub2Api } from '../src/sub2api-install.ts'
import { manifestListsBundle, readSub2ApiProfileManifest, SUB2API_BUNDLE_NAME } from '../src/sub2api-profile.ts'

// The cross-device fallback: the bundle rename out of staging always fails,
// so the installer must complete via a recursive copy. The rename is limited
// to node_modules destinations; the atomic manifest writer keeps its rename.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to.includes('node_modules')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
      return actual.rename(from, to)
    },
  }
})

let root: string
let server: Server
let baseUrl: string
let routes: Map<string, () => Buffer>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sub2api-exdev-'))
  routes = new Map()
  server = createServer((request, response) => {
    const handler = routes.get(request.url ?? '')
    if (handler === undefined) {
      response.writeHead(404).end()
      return
    }
    const body = handler()
    response.writeHead(200, { 'content-length': String(body.length) }).end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(root, { recursive: true, force: true })
})

describe('installSub2Api cross-device fallback', () => {
  it('completes the bundle install through a recursive copy when rename crosses devices', async () => {
    const profileDir = join(root, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    const staging = join(root, 'bundle-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'package.json'), JSON.stringify({
      name: SUB2API_BUNDLE_NAME,
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(staging, 'package', 'cordis.patch.yml'), '- insert: []\n')
    const archive = join(root, 'bundle.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const bytes = await readFile(archive)
    const { createHash } = await import('node:crypto')
    const sums = `${createHash('sha256').update(bytes).digest('hex')}  bundle.tgz\n`
    routes.set('/bundle/bundle.tgz', () => bytes)
    routes.set('/bundle/SHA256SUMS', () => Buffer.from(sums))
    // A minimal valid pack: one binary plus its inner sums.
    const packDir = join(root, 'pack-src', 'pack-1')
    await mkdir(join(packDir, 'bin'), { recursive: true })
    const binary = join(packDir, 'bin', 'sub2api')
    await writeFile(binary, 'binary')
    const digest = createHash('sha256').update(await readFile(binary)).digest('hex')
    await writeFile(join(packDir, 'SHA256SUMS'), `${digest}  bin/sub2api\n`)
    const packArchive = join(root, 'pack.tar.gz')
    await tar.c({ gzip: true, file: packArchive, cwd: join(root, 'pack-src') }, ['pack-1'])
    const packBytes = await readFile(packArchive)
    routes.set('/pack/pack.tar.gz', () => packBytes)
    routes.set('/pack/SHA256SUMS', () => Buffer.from(`${createHash('sha256').update(packBytes).digest('hex')}  pack.tar.gz\n`))

    const result = await installSub2Api({
      sources: {
        bundleUrl: `${baseUrl}/bundle/bundle.tgz`,
        bundleSha256SumsUrl: `${baseUrl}/bundle/SHA256SUMS`,
        runtimePackUrl: `${baseUrl}/pack/pack.tar.gz`,
        runtimePackSha256SumsUrl: `${baseUrl}/pack/SHA256SUMS`,
      },
      layout: { profileDir, runtimeDir: join(root, 'sub2api', 'runtime') },
      fetchImpl: (input, init) => fetch(input, init),
    })
    expect(result.bundleName).toBe(SUB2API_BUNDLE_NAME)
    expect(manifestListsBundle(await readSub2ApiProfileManifest(profileDir), SUB2API_BUNDLE_NAME)).toBe(true)
    expect(await readFile(join(profileDir, 'node_modules', SUB2API_BUNDLE_NAME, 'package.json'), 'utf8')).toContain('dsh-sub2api-sidecar')
  })
})
