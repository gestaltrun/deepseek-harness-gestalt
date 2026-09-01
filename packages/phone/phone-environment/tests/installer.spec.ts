import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zipSync } from 'fflate'
import {
  createMobilecliVersionProbe, installManagedMobilecli, PhoneEnvironmentError,
  probeMobilecliVersion, readManagedMobilecli,
} from '../src/installer.ts'
import type { MobilecliInstallerOptions, MobilecliVersionExec } from '../src/installer.ts'
import type { MobilecliReleaseAsset } from '../src/types.ts'

const fsFault = vi.hoisted(() => ({ openCode: undefined as string | undefined, rename: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsFault.openCode !== undefined && basename(String(args[0])) === 'mobilecli') {
        const error = new Error('no space left on device') as NodeJS.ErrnoException
        error.code = fsFault.openCode
        throw error
      }
      return await actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFault.rename) {
        const error = new Error('rename failed') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      await actual.rename(...args)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  fsFault.openCode = undefined
  fsFault.rename = false
  vi.unstubAllGlobals()
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

function installerOptions(
  options: Omit<MobilecliInstallerOptions, 'probeVersion'>
  & Partial<Pick<MobilecliInstallerOptions, 'probeVersion'>> = {},
): MobilecliInstallerOptions {
  return { probeVersion: async () => '1.0.5', ...options }
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
      ...installerOptions(),
      fetch: fetcher,
      onProgress: value => progress.push(value.receivedBytes),
    })
    if (process.platform === 'win32') expect(installed.version).toBe('1.0.5')
    else expect(await probeMobilecliVersion(installed.executablePath)).toBe('1.0.5')
    expect(progress.at(-1)).toBe(bytes.byteLength)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await readManagedMobilecli(root, 'darwin', 'arm64')).toEqual({
      source: 'managed', executablePath: installed.executablePath,
    })
    expect(JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))).toMatchObject({
      version: '1.0.5', platform: 'darwin', architecture: 'arm64',
    })
    if (process.platform !== 'win32') expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await readdir(root)).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it('uses the ambient fetch boundary when no installer override is supplied', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)))
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, installerOptions()))
      .resolves.toMatchObject({ version: '1.0.5' })
  })

  it.runIf(process.platform !== 'win32')('keeps the installation root, executable, and pointer private', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const installed = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
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
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(), fetch: fetcher,
    }))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('runs a bounded version command with a scrubbed environment and parses its answer', async () => {
    process.env.DSH_PHONE_PROBE_SENTINEL = 'must-not-leak'
    process.env.PHONE_SECRET = 'must-not-leak'
    try {
      const command = vi.fn<MobilecliVersionExec>().mockResolvedValue({
        stdout: 'mobilecli version 1.0.5\n', stderr: '',
      })
      const probe = createMobilecliVersionProbe(command)
      await expect(probe('/managed/mobilecli')).resolves.toBe('1.0.5')
      expect(command).toHaveBeenCalledWith('/managed/mobilecli', ['--version'], expect.objectContaining({
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      }))
      const options = command.mock.calls[0]?.[2]
      expect(options?.env).not.toHaveProperty('DSH_PHONE_PROBE_SENTINEL')
      expect(options?.env).not.toHaveProperty('PHONE_SECRET')
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
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).rejects.toBeInstanceOf(PhoneEnvironmentError)
    await expect(readFile(join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects redirect escape, zip-slip entries, and the wrong probed version', async () => {
    const redirectRoot = await tempRoot()
    const bytes = archiveOf()
    await expect(installManagedMobilecli(redirectRoot, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
        status: 302, headers: { location: 'https://example.com/mobilecli.zip' },
      })),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })

    const slipRoot = await tempRoot()
    const slip = archiveOf('1.0.5', '../mobilecli')
    await expect(installManagedMobilecli(slipRoot, assetOf(slip), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(slip)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ARCHIVE' })

    const versionRoot = await tempRoot()
    const wrong = archiveOf('9.9.9')
    await expect(installManagedMobilecli(versionRoot, assetOf(wrong), new AbortController().signal, {
      ...installerOptions({ probeVersion: async () => '9.9.9' }),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(wrong)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_VERSION' })
  })

  it('rejects an empty executable and a redirect without a Location header', async () => {
    const emptyRoot = await tempRoot()
    const empty = zipSync({ mobilecli: new Uint8Array() })
    await expect(installManagedMobilecli(emptyRoot, assetOf(empty), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(empty)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ARCHIVE' })

    const redirectRoot = await tempRoot()
    const bytes = archiveOf()
    await expect(installManagedMobilecli(redirectRoot, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 })),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })
  })

  it.each([
    ['HTTP failure', new Response('not found', { status: 404 })],
    ['missing body', new Response(null, { status: 200 })],
  ])('rejects a %s before opening the archive', async (_name, response) => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(), fetch: fetcher,
    }))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DOWNLOAD' })
  })

  it('rejects a response body that exceeds the pinned byte length', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const response = new Response(new Uint8Array([...bytes, 0]), { status: 200 })
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_LENGTH' })
  })

  it('reuses a verified existing version and rejects a conflicting existing version', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responseOf(bytes))
    const first = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(), fetch: fetcher,
    })
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(), fetch: fetcher,
    })).resolves.toEqual(first)

    const probeVersion = vi.fn()
      .mockResolvedValueOnce('1.0.5')
      .mockResolvedValueOnce('9.9.9')
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions({ probeVersion }), fetch: fetcher,
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_VERSION' })
  })

  it('preserves a non-filesystem preparation failure', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const failure = new Error('network unavailable')
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockRejectedValue(failure),
    })).rejects.toBe(failure)
  })

  it('preserves rename failure when no published version exists', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    fsFault.rename = true
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(), fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })).rejects.toMatchObject({ code: 'EIO' })
  })

  it('cancels through the download signal and rejects unsafe current pointers', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(installManagedMobilecli(root, assetOf(bytes), controller.signal, {
      ...installerOptions(),
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
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
        status: 200, headers: { 'content-length': String(bytes.byteLength) },
      })),
    })
    await reading
    controller.abort(new Error('cancelled during download'))
    await expect(operation).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
    await expect(readFile(join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter(name => name.startsWith('.staging-'))).toEqual([])
  })

  it('rejects a failed version command', async () => {
    const probe = createMobilecliVersionProbe(vi.fn<MobilecliVersionExec>()
      .mockRejectedValue(new Error('exit 7')))
    await expect(probe('/managed/mobilecli')).rejects.toMatchObject({
      code: 'PHONE_ENVIRONMENT_VERSION',
    })
  })

  it('rejects version probe output outside the mobilecli format', async () => {
    const probe = createMobilecliVersionProbe(vi.fn<MobilecliVersionExec>().mockResolvedValue({
      stdout: 'version unknown\n', stderr: '',
    }))
    await expect(probe('/managed/mobilecli')).rejects.toMatchObject({
      code: 'PHONE_ENVIRONMENT_VERSION',
    })
  })

  it('normalizes cancellation during the version probe', async () => {
    const controller = new AbortController()
    const command = vi.fn<MobilecliVersionExec>().mockImplementation(async (_path, _args, options) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const reason: unknown = options.signal?.reason
          reject(reason instanceof Error ? reason : new Error('version probe cancelled', { cause: reason }))
        }, { once: true })
      })
      return { stdout: '', stderr: '' }
    })
    const operation = createMobilecliVersionProbe(command)('/managed/mobilecli', controller.signal)
    controller.abort(new Error('cancel probe'))
    await expect(operation).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
  })

  it('normalizes cancellation while reading the managed current pointer', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'current.json'), '{}\n')
    const controller = new AbortController()
    controller.abort(new Error('cancel current read'))
    await expect(readManagedMobilecli(root, 'darwin', 'arm64', controller.signal))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_ABORTED' })
  })

  it('rejects invalid JSON and ignores pointers for another host tuple', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'current.json'), '{')
    await expect(readManagedMobilecli(root, 'darwin', 'arm64'))
      .rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_CURRENT' })

    for (const pointer of [
      null,
      [],
      {},
      { version: 1, platform: 'darwin', architecture: 'arm64', executable: 'versions/current/mobilecli' },
      { version: '1.0.5', platform: 1, architecture: 'arm64', executable: 'versions/current/mobilecli' },
      { version: '1.0.5', platform: 'darwin', architecture: 1, executable: 'versions/current/mobilecli' },
      { version: '1.0.5', platform: 'darwin', architecture: 'arm64', executable: 1 },
      { version: '1.0.5', platform: 'linux', architecture: 'arm64', executable: 'versions/current/mobilecli' },
      { version: '1.0.5', platform: 'darwin', architecture: 'x64', executable: 'versions/current/mobilecli' },
    ]) {
      await writeFile(join(root, 'current.json'), JSON.stringify(pointer))
      await expect(readManagedMobilecli(root, 'darwin', 'arm64')).resolves.toBeUndefined()
    }
  })

  it('preserves a managed-current read failure other than a missing pointer', async () => {
    await expect(readManagedMobilecli('\0', 'darwin', 'arm64', new AbortController().signal))
      .rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('treats a missing current pointer as absent with a live cancellation owner', async () => {
    const root = await tempRoot()
    await expect(readManagedMobilecli(root, 'darwin', 'arm64', new AbortController().signal))
      .resolves.toBeUndefined()
  })

  it('preserves the prior current pointer when the filesystem runs out of space', async () => {
    const root = await tempRoot()
    const bytes = archiveOf()
    const first = await installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })
    const before = await readFile(join(root, 'current.json'), 'utf8')

    fsFault.openCode = 'ENOSPC'
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DISK' })
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before)
    expect(await readManagedMobilecli(root, 'darwin', 'arm64')).toEqual({
      source: 'managed', executablePath: first.executablePath,
    })
  })

  it.each(['EDQUOT', 'EROFS', 'EACCES', 'EPERM'])('normalizes %s as a private-installation disk failure', async (code) => {
    const root = await tempRoot()
    const bytes = archiveOf()
    fsFault.openCode = code
    await expect(installManagedMobilecli(root, assetOf(bytes), new AbortController().signal, {
      ...installerOptions(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(responseOf(bytes)),
    })).rejects.toMatchObject({ code: 'PHONE_ENVIRONMENT_DISK' })
  })
})
