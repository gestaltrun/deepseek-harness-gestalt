import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AddressInfo } from 'node:net'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadToFile, installSub2Api, parseSha256Sums, verifyExtractedPack, verifyFileAgainstSums,
} from '../src/sub2api-install.ts'
import { manifestListsBundle, readSub2ApiProfileManifest, SUB2API_BUNDLE_NAME } from '../src/sub2api-profile.ts'
import type { Sub2ApiInstallProgress } from '../src/sub2api-install.ts'

const BUNDLE_VERSION = '0.1.0'
const BUNDLE_ARCHIVE = `dsh-sub2api-sidecar-${BUNDLE_VERSION}.tgz`
const PACK_ARCHIVE = 'runtime-pack-0.1.183-darwin-arm64.tar.gz'

const dirs: string[] = []
const percents: (number | undefined)[] = []
let root: string
let server: Server
let baseUrl: string
let routes: Map<string, () => Buffer>

beforeEach(async () => {
  percents.length = 0
  root = await mkdtemp(join(tmpdir(), 'sub2api-install-'))
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
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Build a valid bundle tarball (npm pack layout) plus its sums. */
async function bundleFixture(): Promise<{ bundleUrl: string; bundleSha256SumsUrl: string }> {
  const staging = join(root, 'bundle-src')
  await mkdir(join(staging, 'package'), { recursive: true })
  await writeFile(join(staging, 'package', 'package.json'), JSON.stringify({
    name: SUB2API_BUNDLE_NAME,
    version: BUNDLE_VERSION,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(staging, 'package', 'cordis.patch.yml'), '- insert:\n    - id: dsh-sub2api-sidecar\n')
  const archive = join(root, BUNDLE_ARCHIVE)
  await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
  const served_ = await served(archive, `bundle/${BUNDLE_ARCHIVE}`, 'bundle/SHA256SUMS')
  return { bundleUrl: served_.archiveUrl, bundleSha256SumsUrl: served_.sumsUrl }
}

/** Build a valid runtime pack tarball (one top-level dir, inner sums) plus its sums. */
async function packFixture(): Promise<{ runtimePackUrl: string; runtimePackSha256SumsUrl: string }> {
  const packName = PACK_ARCHIVE.replace(/\.tar\.gz$/, '')
  const staging = join(root, 'pack-src', packName)
  await mkdir(join(staging, 'bin'), { recursive: true })
  const binary = join(staging, 'bin', 'sub2api')
  await writeFile(binary, '#!/bin/sh\necho sub2api\n')
  await chmod(binary, 0o755)
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex')
  await writeFile(join(staging, 'SHA256SUMS'), `${digest}  bin/sub2api\n`)
  const archive = join(root, PACK_ARCHIVE)
  await tar.c({ gzip: true, file: archive, cwd: join(root, 'pack-src') }, [packName])
  const served_ = await served(archive, `pack/${PACK_ARCHIVE}`, 'pack/SHA256SUMS')
  return { runtimePackUrl: served_.archiveUrl, runtimePackSha256SumsUrl: served_.sumsUrl }
}

/** Serve one archive under `archivePath` and its sums under `sumsPath`. */
async function served(
  archive: string,
  archivePath: string,
  sumsPath: string,
): Promise<{ archiveUrl: string; sumsUrl: string }> {
  const bytes = await readFile(archive)
  const sums = `${createHash('sha256').update(bytes).digest('hex')}  ${archive.split('/').pop()}\n`
  routes.set(`/${archivePath}`, () => bytes)
  routes.set(`/${sumsPath}`, () => Buffer.from(sums))
  return { archiveUrl: `${baseUrl}/${archivePath}`, sumsUrl: `${baseUrl}/${sumsPath}` }
}

async function layout() {
  const profileDir = join(root, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n')
  return {
    profileDir,
    runtimeDir: join(root, 'sub2api', 'runtime'),
    dataDir: join(root, 'sub2api', 'data'),
    sources: { ...await bundleFixture(), ...await packFixture() },
  }
}

const fetchImpl: typeof fetch = (input, init) => fetch(input, init)

describe('installSub2Api', () => {
  it('installs the bundle and runtime pack, patching only the bundles row', async () => {
    const env = await layout()
    const progress: Parameters<Sub2ApiInstallProgress>[0][] = []
    const result = await installSub2Api({
      sources: env.sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
      onProgress: (phase) => { progress.push(phase) },
    })
    expect(result).toEqual({ bundleName: SUB2API_BUNDLE_NAME, bundleVersion: BUNDLE_VERSION })
    expect(progress).toContain('downloading')
    expect(progress).toContain('verifying')

    // The manifest gains exactly one row; every other entry is untouched.
    const manifest = await readSub2ApiProfileManifest(env.profileDir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', SUB2API_BUNDLE_NAME])
    expect(manifest.name).toBe('dsh-profile-web')

    // The bundle package sits where profile resolution finds it.
    const packageManifest = JSON.parse(
      await readFile(join(env.profileDir, 'node_modules', SUB2API_BUNDLE_NAME, 'package.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(packageManifest).toMatchObject({ name: SUB2API_BUNDLE_NAME, version: BUNDLE_VERSION })

    // The pack is stripped of its top-level directory and executables keep modes.
    const runtimeListing = await readdir(env.runtimeDir)
    expect(runtimeListing.sort()).toEqual(['SHA256SUMS', 'bin'])
    const binary = join(env.runtimeDir, 'bin', 'sub2api')
    if (process.platform !== 'win32') {
      expect((await stat(binary)).mode & 0o111).not.toBe(0)
    }
  })

  it('rejects a corrupt archive before touching the profile', async () => {
    const env = await layout()
    const corrupt = Buffer.from('not a tarball')
    routes.set('/pack/corrupt.tar.gz', () => corrupt)
    // The sums name the archive with a wrong digest: verification must reject
    // before anything touches the profile.
    routes.set('/pack/corrupt-SHA256SUMS', () => Buffer.from(
      `${'0'.repeat(64)}  corrupt.tar.gz\n`,
    ))
    const sources = {
      ...env.sources,
      runtimePackUrl: `${baseUrl}/pack/corrupt.tar.gz`,
      runtimePackSha256SumsUrl: `${baseUrl}/pack/corrupt-SHA256SUMS`,
    }
    await expect(installSub2Api({
      sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('SHA-256 mismatch')

    expect(manifestListsBundle(await readSub2ApiProfileManifest(env.profileDir), SUB2API_BUNDLE_NAME)).toBe(false)
    await expect(stat(join(env.profileDir, 'node_modules', SUB2API_BUNDLE_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(env.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a sums document that does not name the archive', async () => {
    const env = await layout()
    routes.set('/pack/SHA256SUMS', () => Buffer.from(`${'a'.repeat(64)}  some-other-file.tar.gz\n`))
    const sources = { ...env.sources, runtimePackSha256SumsUrl: `${baseUrl}/pack/SHA256SUMS` }
    await expect(installSub2Api({
      sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('does not list')
    expect(manifestListsBundle(await readSub2ApiProfileManifest(env.profileDir), SUB2API_BUNDLE_NAME)).toBe(false)
  })

  it('fails loud on a bundle-less package with nothing written', async () => {
    const env = await layout()
    const staging = join(root, 'no-bundle-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'package.json'), JSON.stringify({ name: 'plain-lib', version: '1.0.0' }))
    const archive = join(root, 'plain-lib.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const servedArchive = await served(archive, 'plain/plain-lib.tgz', 'plain/SHA256SUMS')
    const sources = { ...env.sources, bundleUrl: servedArchive.archiveUrl, bundleSha256SumsUrl: servedArchive.sumsUrl }
    await expect(installSub2Api({
      sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('declares no dsh.bundle')
    expect(manifestListsBundle(await readSub2ApiProfileManifest(env.profileDir), SUB2API_BUNDLE_NAME)).toBe(false)
  })

  it('rolls the bundles row back when the runtime pack cannot install', async () => {
    const env = await layout()
    // A tarball whose only member is a directory: valid gzip, zero payload files.
    const emptyDir = join(root, 'empty-pack')
    await mkdir(join(emptyDir, 'runtime-pack-empty'), { recursive: true })
    const emptyArchive = join(root, 'empty.tar.gz')
    await tar.c({ gzip: true, file: emptyArchive, cwd: emptyDir }, ['runtime-pack-empty'])
    const servedArchive = await served(emptyArchive, 'pack/empty.tar.gz', 'pack/empty-SHA256SUMS')
    const sources = {
      ...env.sources,
      runtimePackUrl: servedArchive.archiveUrl,
      runtimePackSha256SumsUrl: servedArchive.sumsUrl,
    }

    await expect(installSub2Api({
      sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow()

    expect(manifestListsBundle(await readSub2ApiProfileManifest(env.profileDir), SUB2API_BUNDLE_NAME)).toBe(false)
    await expect(stat(join(env.profileDir, 'node_modules', SUB2API_BUNDLE_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(env.runtimeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an already-installed profile', async () => {
    const env = await layout()
    await writeFile(join(env.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SUB2API_BUNDLE_NAME] } },
    }))
    await expect(installSub2Api({
      sources: env.sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('already installed')
  })

  it('reports HTTP failures with the source URL status', async () => {
    const env = await layout()
    const sources = { ...env.sources, bundleUrl: `${baseUrl}/missing.tgz` }
    await expect(installSub2Api({
      sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('status 404')
  })
})

describe('SHA256SUMS helpers', () => {
  it('parses standard checksum lines and skips comments and blanks', () => {
    const text = '# comment\n'
      + `${'b'.repeat(64)}  runtime-pack.tar.gz\n`
      + `${'c'.repeat(64)} *binary\n`
      + '\n'
    expect(parseSha256Sums(text)).toEqual([
      { digest: 'b'.repeat(64), filename: 'runtime-pack.tar.gz' },
      { digest: 'c'.repeat(64), filename: 'binary' },
    ])
    expect(() => parseSha256Sums('nonsense')).toThrow('unparseable SHA256SUMS line')
  })

  it('verifies a file digest and rejects a mismatch', async () => {
    const file = join(root, 'payload')
    await writeFile(file, 'payload')
    const digest = createHash('sha256').update('payload').digest('hex')
    await expect(verifyFileAgainstSums(file, `${digest}  payload\n`, 'payload')).resolves.toBeUndefined()
    await expect(verifyFileAgainstSums(file, `${'0'.repeat(64)}  payload\n`, 'payload'))
      .rejects.toThrow('SHA-256 mismatch')
    await expect(verifyFileAgainstSums(file, `${digest}  other\n`, 'payload')).rejects.toThrow('does not list')
  })
})

describe('download robustness', () => {
  /** A web ReadableStream over the given chunks. */
  function streamOf(...chunks: Buffer[]): ReadableStream {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
  }

  it('downloads with progress against content-length', async () => {
    const file = join(root, 'out-a')
    const body = Buffer.alloc(100, 7)
    await downloadToFile('https://example.test/a', file, async () => new Response(streamOf(body), {
      headers: { 'content-length': String(body.length) },
    }), (percent) => { percents.push(percent) }, undefined)
    expect((await readFile(file)).equals(body)).toBe(true)
    expect(percents.at(-1)).toBe(100)
  })

  it('skips progress when no content-length accompanies the download', async () => {
    const file = join(root, 'out-b')
    const body = Buffer.from('payload')
    await downloadToFile('https://example.test/b', file, async () => new Response(streamOf(body)), (percent) => {
      percents.push(percent)
    }, undefined)
    expect(percents).toEqual([])
  })

  it('deduplicates repeated integer percent points', async () => {
    const file = join(root, 'out-c')
    const body = Buffer.alloc(100, 1)
    const tiny = Array.from({ length: 100 }, () => Buffer.from([1]))
    await downloadToFile('https://example.test/c', file, async () => new Response(streamOf(...tiny), {
      headers: { 'content-length': String(body.length) },
    }), (percent) => { percents.push(percent) }, undefined)
    expect(new Set(percents).size).toBe(percents.length)
    expect(percents.length).toBeLessThan(tiny.length)
  })

  it('rejects a truncated download', async () => {
    const file = join(root, 'out-d')
    await expect(downloadToFile('https://example.test/d', file, async () => new Response(streamOf(Buffer.alloc(10, 1)), {
      headers: { 'content-length': '1000' },
    }), () => {}, undefined)).rejects.toThrow('truncated download')
  })

  it('rejects non-2xx and empty-body responses', async () => {
    const file = join(root, 'out-e')
    await expect(downloadToFile('https://example.test/e', file, async () => new Response(null, { status: 404 }), () => {}, undefined))
      .rejects.toThrow('status 404')
    await expect(downloadToFile('https://example.test/f', file, async () => new Response(null, { status: 200 }), () => {}, undefined))
      .rejects.toThrow('status 200')
  })
})

describe('runtime pack inner sums verification', () => {
  it('rejects a pack without sums, with a missing file, or with a bad digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pack-empty-'))
    dirs.push(dir)
    await expect(verifyExtractedPack(dir)).rejects.toThrow('has no inner SHA256SUMS')

    await writeFile(join(dir, 'SHA256SUMS'), `${'a'.repeat(64)}  missing.bin\n`)
    await expect(verifyExtractedPack(dir)).rejects.toThrow('is missing "missing.bin"')

    await writeFile(join(dir, 'missing.bin'), 'x')
    await expect(verifyExtractedPack(dir)).rejects.toThrow('failed its SHA-256 check')
  })
})

describe('bundle manifest validation', () => {
  it('fails loud on a bundle tarball without a package.json', async () => {
    const env = await layout()
    const staging = join(root, 'no-manifest-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'index.js'), 'export const name = 1\n')
    const archive = join(root, 'no-manifest.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const served_ = await served(archive, 'plain/no-manifest.tgz', 'plain/no-manifest-SHA256SUMS')
    await expect(installSub2Api({
      sources: { ...env.sources, bundleUrl: served_.archiveUrl, bundleSha256SumsUrl: served_.sumsUrl },
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('no package.json at its root')
  })

  it('fails loud on a package.json that does not parse', async () => {
    const env = await layout()
    const staging = join(root, 'bad-json-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'package.json'), '{bad')
    const archive = join(root, 'bad-json.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const served_ = await served(archive, 'plain/bad-json.tgz', 'plain/bad-SHA256SUMS')
    await expect(installSub2Api({
      sources: { ...env.sources, bundleUrl: served_.archiveUrl, bundleSha256SumsUrl: served_.sumsUrl },
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('does not parse')
  })

  it('fails loud on an unnamed or non-string-version package', async () => {
    const env = await layout()
    const staging = join(root, 'unnamed-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'package.json'), JSON.stringify({
      name: '',
      dsh: { bundle: { patch: './x.yml' } },
    }))
    const archive = join(root, 'unnamed.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const served_ = await served(archive, 'plain/unnamed.tgz', 'plain/unnamed-SHA256SUMS')
    await expect(installSub2Api({
      sources: { ...env.sources, bundleUrl: served_.archiveUrl, bundleSha256SumsUrl: served_.sumsUrl },
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('declares no name')

    // A non-string version degrades to "unknown" instead of failing the install.
    const staging2 = join(root, 'weird-version-src')
    await mkdir(join(staging2, 'package'), { recursive: true })
    await writeFile(join(staging2, 'package', 'package.json'), JSON.stringify({
      name: SUB2API_BUNDLE_NAME,
      version: 42,
      dsh: { bundle: { patch: './x.yml' } },
    }))
    const archive2 = join(root, 'weird.tgz')
    await tar.c({ gzip: true, file: archive2, cwd: staging2 }, ['package'])
    const served2 = await served(archive2, 'plain/weird.tgz', 'plain/weird-SHA256SUMS')
    const result = await installSub2Api({
      sources: { ...env.sources, bundleUrl: served2.archiveUrl, bundleSha256SumsUrl: served2.sumsUrl },
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })
    expect(result.bundleVersion).toBe('unknown')
  })

  it('rejects a bundle package under an unexpected name', async () => {
    const env = await layout()
    const staging = join(root, 'other-name-src')
    await mkdir(join(staging, 'package'), { recursive: true })
    await writeFile(join(staging, 'package', 'package.json'), JSON.stringify({
      name: 'dsh-some-other-bundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './x.yml' } },
    }))
    const archive = join(root, 'other.tgz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
    const served_ = await served(archive, 'plain/other.tgz', 'plain/other-SHA256SUMS')
    await expect(installSub2Api({
      sources: { ...env.sources, bundleUrl: served_.archiveUrl, bundleSha256SumsUrl: served_.sumsUrl },
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('unexpected bundle package')
    expect(manifestListsBundle(await readSub2ApiProfileManifest(env.profileDir), SUB2API_BUNDLE_NAME)).toBe(false)
  })
})

describe('staging cleanup', () => {
  it('leaves no staging directories behind on success or failure', async () => {
    const env = await layout()
    const stagingDirs = async (): Promise<string[]> =>
      (await readdir(tmpdir())).filter(name => name.startsWith('dsh-sub2api-')).sort()
    const before = await stagingDirs()
    await installSub2Api({
      sources: env.sources,
      layout: { profileDir: env.profileDir, runtimeDir: env.runtimeDir },
      fetchImpl,
    })
    expect(await stagingDirs()).toEqual(before)

    // A failing run against a fresh profile leaves the same empty staging set.
    const env2 = await layout()
    routes.set('/bundle/SHA256SUMS-wrong', () => Buffer.from(`${'0'.repeat(64)}  ${BUNDLE_ARCHIVE}\n`))
    await expect(installSub2Api({
      sources: { ...env2.sources, bundleSha256SumsUrl: `${baseUrl}/bundle/SHA256SUMS-wrong` },
      layout: { profileDir: env2.profileDir, runtimeDir: env2.runtimeDir },
      fetchImpl,
    })).rejects.toThrow('SHA-256 mismatch')
    expect(await stagingDirs()).toEqual(before)
  })
})
