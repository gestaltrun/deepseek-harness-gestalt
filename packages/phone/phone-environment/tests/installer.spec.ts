import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import {
  installManagedMobilecli, PhoneEnvironmentError, probeMobilecliVersion, readManagedMobilecli,
} from '../src/installer.ts'
import type { MobilecliReleaseAsset } from '../src/types.ts'

const diskFault = vi.hoisted(() => ({ enabled: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (diskFault.enabled && String(args[0]).endsWith('/mobilecli')) {
        const error = new Error('no space left on device') as NodeJS.ErrnoException
        error.code = 'ENOSPC'
        throw error
      }
      return await actual.open(...args)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  diskFault.enabled = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-environment-'))
  roots.push(root)
  return root
}

function archiveOf(version = '1.0.5', name = 'mobilecli', body?: string): Uint8Array {
  const script = new TextEncoder().encode(body ?? `#!/bin/sh\necho "mobilecli version ${version}"\n`)
  return zipSync({ [name]: script })
}

function assetOf(bytes: Uint8Array, overrides: Partial<MobilecliReleaseAsset> = {}): MobilecliReleaseAsset {
  return {
    platform: 'darwin',
    architecture: 'arm64',
    name: 'mobilecli-1.0.5-macos-arm64.zip',
    url: 'https://github.com/mobile-next/mobilecli/releases/download/1.0.5/mobilecli-1.0.5-macos-arm64.zip',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executable: 'mobilecli',
    ...overrides,
  }
}

function responseOf(bytes: Uint8Array, declaredBytes = bytes.byteLength): Response {
  const body = new Uint8Array(bytes).buffer
  return new Response(body, { status: 200, headers: { 'content-length': String(declaredBytes) } })
}

describe('managed mobilecli installer', () => {
  it('follows only the GitHub release-asset redirect, verifies, probes, and atomically publishes current', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const progress: number[] = []
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/mobilecli.zip' },
      }))
      .mockResolvedValueOnce(responseOf(bytes))
    const installed = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      fetch: fetcher,
      onProgress: value => progress.push(value.receivedBytes),
    })
    expect(await probeMobilecliVersion(installed.executablePath)).toBe('1.0.5')
    expect(progress.at(-1)).toBe(bytes.byteLength)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await readManagedMobilecli(root, 'darwin', 'arm64')).toEqual({
      source: 'managed', executablePath: installed.executablePath,
    })
    expect(JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))).toMatchObject({
      version: '1.0.5', platform: 'darwin', architecture: 'arm64',
    })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await readdir(root)).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('keeps the installation root, executable, and pointer private', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const installed = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(installed.executablePath)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'current.json'))).mode & 0o777).toBe(0o600)
  })

  it('bounds the allowlisted redirect chain', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/mobilecli.zip' },
    }))
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, { fetch: fetcher }))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('scrubs host credentials from the version probe child', async () => {
    const root = await tempRoot()
    const bytes = archiveOf('1.0.5', 'mobilecli', [
      '#!/bin/sh',
      'if [ -n "$DSH_PHONE_PROBE_SENTINEL" ] || [ -n "$PHONE_SECRET" ]; then exit 42; fi',
      'echo "mobilecli version 1.0.5"',
      '',
    ].join('\n'))
    process.env.DSH_PHONE_PROBE_SENTINEL = 'must-not-leak'
    process.env.PHONE_SECRET = 'must-not-leak'
    try {
      await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
      })).resolves.toMatchObject({ version: '1.0.5' })
    } finally {
      delete process.env.DSH_PHONE_PROBE_SENTINEL
      delete process.env.PHONE_SECRET
    }
  })

  it.each([
    ['length header', (bytes: Uint8Array) => ({ asset: assetOf(bytes, { bytes: bytes.byteLength + 1 }), response: responseOf(bytes) })],
    ['digest', (bytes: Uint8Array) => ({ asset: assetOf(bytes, { sha256: '0'.repeat(64) }), response: responseOf(bytes) })],
    ['truncation', (bytes: Uint8Array) => ({
      asset: assetOf(bytes),
      response: responseOf(bytes.slice(0, -1), bytes.byteLength),
    })],
  ])('rejects a %s mismatch without publishing current', async (_name, arrange) => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const { asset, response } = arrange(bytes)
    await expect(installManagedMobilecli(root, asset, new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).rejects.toBeInstanceOf(PhoneEnvironmentError)
    await expect(readFile(join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects redirect escape, zip-slip entries, and the wrong probed version', async () => {
    const redirectRoot = await tempRoot()
    const bytes = archiveOf()
    await expect(installManagedMobilecli(redirectRoot, assetOf(bytes), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
        status: 302, headers: { location: 'https://example.com/mobilecli.zip' },
      })),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })

    const slipRoot = await tempRoot()
    const slip = archiveOf('1.0.5', '../mobilecli')
    await expect(installManagedMobilecli(slipRoot, assetOf(slip), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(slip)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ARCHIVE' })

    const versionRoot = await tempRoot()
    const wrong = archiveOf('9.9.9')
    await expect(installManagedMobilecli(versionRoot, assetOf(wrong), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(wrong)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_VERSION' })
  })

  it('cancels through the download signal and rejects unsafe current pointers', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(installManagedMobilecli(root, assetOf(bytes), controller.signal, {
      fetch: vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        if (init?.signal?.aborted === true) throw init.signal.reason
        return responseOf(bytes)
      }),
    })).rejects.toThrow('cancelled')

    await writeFile(join(root, 'current.json'), JSON.stringify({
      version: '1.0.5', platform: 'darwin', architecture: 'arm64', executable: '../outside/mobilecli',
    }))
    await expect(readManagedMobilecli(root, 'darwin', 'arm64'))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_CURRENT' })
    await chmod(root, 0o700)
  })

  it('cancels an in-progress response body without publishing current', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const controller = new AbortController()
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes.slice(0, 10))
        started()
        controller.signal.addEventListener('abort', () => {
          stream.error(controller.signal.reason)
        }, { once: true })
      },
    })
    const operation = installManagedMobilecli(root, assetOf(bytes), controller.signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
        status: 200, headers: { 'content-length': String(bytes.byteLength) },
      })),
    })
    await reading
    controller.abort(new Error('cancelled during download'))
    await expect(operation).rejects.toThrow('cancelled during download')
    await expect(readFile(join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it('rejects a version probe whose executable exits non-zero', async () => {
    const root = await tempRoot()
    const executable = join(root, 'mobilecli')
    await writeFile(executable, '#!/bin/sh\nexit 7\n')
    await chmod(executable, 0o700)
    await expect(probeMobilecliVersion(executable)).rejects.toMatchObject({
      code: 'PHONE_ENVIRONMENT_VERSION',
    })
  })

  it('preserves the prior current pointer when the filesystem runs out of space', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const first = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })
    const before = await readFile(join(root, 'current.json'), 'utf8')

    diskFault.enabled = true
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DISK' })
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before)
    expect(await readManagedMobilecli(root, 'darwin', 'arm64')).toEqual({
      source: 'managed', executablePath: first.executablePath,
    })
  })
})
