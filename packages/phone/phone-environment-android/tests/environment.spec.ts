import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { AndroidEnvironmentManager } from '../src/environment.ts'
import type {
  AndroidCommandOptions, AndroidCommandResult, AndroidCommandRunner, AndroidOwnedProcess,
} from '../src/process.ts'
import type { AndroidCommandLineToolsAsset } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-environment-'))
  roots.push(root)
  return root
}

function archiveAsset(): { asset: AndroidCommandLineToolsAsset; bytes: Uint8Array } {
  const bytes = zipSync({
    'cmdline-tools/bin/sdkmanager': new TextEncoder().encode('#!/bin/sh\n'),
    'cmdline-tools/bin/avdmanager': new TextEncoder().encode('#!/bin/sh\n'),
    'cmdline-tools/source.properties': new TextEncoder().encode('Pkg.Revision=20.0\n'),
  })
  return {
    bytes,
    asset: {
      platform: 'darwin', architecture: 'arm64', name: 'commandlinetools-test.zip',
      url: 'https://dl.google.com/android/repository/commandlinetools-test.zip',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  return body
}

class FixtureRunner implements AndroidCommandRunner {
  readonly calls: { command: string; args: readonly string[]; input?: string }[] = []
  stops = 0

  constructor(private readonly phoneRoot: string) {}

  async run(command: string, args: readonly string[], options: AndroidCommandOptions): Promise<AndroidCommandResult> {
    this.calls.push({ command, args, ...(options.input === undefined ? {} : { input: options.input }) })
    const sdkRoot = options.env.ANDROID_SDK_ROOT as string
    if (command.endsWith('sdkmanager') && args.includes('--install')) {
      for (const path of [
        join(sdkRoot, 'platform-tools', 'adb'),
        join(sdkRoot, 'emulator', 'emulator'),
        join(sdkRoot, 'system-images', 'android-35', 'google_apis', 'arm64-v8a', 'package.xml'),
      ]) {
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, path.endsWith('package.xml') ? '<localPackage />\n' : '#!/bin/sh\n')
        if (!path.endsWith('package.xml')) await chmod(path, 0o700)
      }
    }
    if (command.endsWith('avdmanager')) {
      const avd = join(this.phoneRoot, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd')
      await mkdir(avd, { recursive: true })
      await writeFile(join(avd, 'config.ini'), 'image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n')
    }
    if (args[0] === 'devices') return { code: 0, stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' }
    if (args.includes('avd') && args.includes('name')) return { code: 0, stdout: 'Pixel_6_API_35_Gestalt\nOK\n', stderr: '' }
    if (args.includes('getprop')) return { code: 0, stdout: '1\n', stderr: '' }
    return { code: 0, stdout: 'accel:\n0\nHypervisor.Framework\n', stderr: '' }
  }

  spawn(): AndroidOwnedProcess {
    const result = { code: null, stdout: '', stderr: '' }
    return {
      pid: 42,
      exit: new Promise(() => {}),
      stop: async () => { this.stops += 1; void result },
    }
  }
}

describe('Android environment manager', () => {
  it('requires explicit Android SDK license acceptance before any command or download', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const runner = new FixtureRunner(root)
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { PATH: '' }, homeDirectory: join(root, 'home'), runner,
      commandLineToolsAsset: fixture.asset, freeBytes: async () => 32 * 1024 ** 3,
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    await expect(manager.prepare({} as { licenseAccepted: true })).rejects.toMatchObject({
      code: 'PHONE_ANDROID_LICENSE_REQUIRED',
    })
    expect(runner.calls).toEqual([])
  })

  it('downloads the pinned tools, accepts licenses, installs fixed packages, creates one AVD, and boots it', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const runner = new FixtureRunner(root)
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { PATH: '/usr/bin' }, homeDirectory: join(root, 'home'), runner,
      commandLineToolsAsset: fixture.asset, freeBytes: async () => 32 * 1024 ** 3,
      fetch: async (url, init) => {
        expect(url).toBe(fixture.asset.url)
        expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) })
        return new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } })
      },
    })
    const states: string[] = []
    manager.onChanged((state) => { states.push(state.kind) })
    await manager.refresh()
    const ready = await manager.prepare({ licenseAccepted: true })
    expect(ready).toMatchObject({
      kind: 'ready', running: true, deviceId: 'emulator-5554',
      plan: {
        sdkSource: 'managed', abi: 'arm64-v8a',
        components: { commandLineTools: true, platformTools: true, emulator: true, systemImage: true, avd: true },
      },
    })
    expect(states).toEqual(expect.arrayContaining([
      'downloading', 'installing', 'creating-avd', 'checking-acceleration', 'booting', 'ready',
    ]))
    expect(runner.calls.find(call => call.args.includes('--licenses'))?.input).toContain('y\n')
    expect(runner.calls.find(call => call.args.includes('--install'))?.args).toEqual(expect.arrayContaining([
      'platform-tools', 'emulator', 'system-images;android-35;google_apis;arm64-v8a',
    ]))
    expect(await readFile(join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd', 'config.ini'), 'utf8')).toContain('android-35')
    await manager.prepare({ licenseAccepted: true })
    expect(runner.calls.filter(call => call.command.endsWith('avdmanager'))).toHaveLength(1)
    await manager.deactivate()
    expect(runner.stops).toBe(2)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('stops before download when the target volume has less than 16 GB free', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    let fetched = false
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: join(root, 'home'), runner: new FixtureRunner(root), commandLineToolsAsset: fixture.asset,
      freeBytes: async () => 13 * 1024 ** 3,
      fetch: async () => { fetched = true; return new Response(bodyOf(fixture.bytes)) },
    })
    await manager.refresh()
    await expect(manager.prepare({ licenseAccepted: true })).resolves.toMatchObject({
      kind: 'manual-required', code: 'disk-space',
    })
    expect(fetched).toBe(false)
  })

  it('reads Windows environment names case-insensitively and emits one explicit PATH', async () => {
    const root = await tempRoot()
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'win32', architecture: 'x64',
      environment: { Path: 'C:\\Windows\\System32', LocalAppData: join(root, 'local') },
      homeDirectory: join(root, 'home'), runner: new FixtureRunner(root),
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    expect(manager.runtimeEnvironment()).toMatchObject({
      ANDROID_HOME: join(root, 'android', 'sdk'),
      ANDROID_SDK_ROOT: join(root, 'android', 'sdk'),
      PATH: expect.stringMatching(/;C:\\Windows\\System32$/u),
    })
  })

  it('rejects a digest mismatch without publishing a prepared state', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner: new FixtureRunner(root), freeBytes: async () => 32 * 1024 ** 3,
      commandLineToolsAsset: { ...fixture.asset, sha256: '0'.repeat(64) },
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    await expect(manager.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_DIGEST' })
    expect(manager.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_DIGEST' })
  })

  it('rejects archive entries outside the official cmdline-tools root', async () => {
    const root = await tempRoot()
    const bytes = zipSync({
      'cmdline-tools/bin/sdkmanager': new TextEncoder().encode('fixture'),
      '../outside': new TextEncoder().encode('escape'),
    })
    const asset = {
      ...archiveAsset().asset,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner: new FixtureRunner(root), freeBytes: async () => 32 * 1024 ** 3,
      commandLineToolsAsset: asset,
      fetch: async () => new Response(bodyOf(bytes), { headers: { 'content-length': String(bytes.byteLength) } }),
    })
    await manager.refresh()
    await expect(manager.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_ARCHIVE' })
  })

  it.each([
    ['win32', 'windows-hypervisor'],
    ['linux', 'linux-kvm'],
  ] as const)('surfaces %s acceleration as manual-required', async (platform, code) => {
    const root = await tempRoot()
    const sdkRoot = join(root, 'sdk')
    const avdHome = join(root, 'android', 'avd')
    for (const path of [
      join(sdkRoot, 'cmdline-tools', 'latest', 'bin', platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'),
      join(sdkRoot, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb'),
      join(sdkRoot, 'emulator', platform === 'win32' ? 'emulator.exe' : 'emulator'),
      join(sdkRoot, 'system-images', 'android-35', 'google_apis', 'x86_64', 'package.xml'),
      join(avdHome, 'Pixel_6_API_35_Gestalt.avd', 'config.ini'),
    ]) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, path.endsWith('config.ini')
        ? 'image.sysdir.1=system-images/android-35/google_apis/x86_64/\n'
        : 'fixture\n')
    }
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => args[0] === '-accel-check'
        ? { code: 1, stdout: '', stderr: 'acceleration unavailable' }
        : { code: 0, stdout: '', stderr: '' },
      spawn: () => { throw new Error('emulator must not start') },
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform, architecture: 'x64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    await expect(manager.prepare({ licenseAccepted: true })).resolves.toMatchObject({
      kind: 'manual-required', code,
    })
  })

  it('cancels a direct emulator start and joins the owned process', async () => {
    const root = await tempRoot()
    const sdkRoot = join(root, 'sdk')
    const avdHome = join(root, 'android', 'avd')
    for (const path of [
      join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
      join(sdkRoot, 'platform-tools', 'adb'),
      join(sdkRoot, 'emulator', 'emulator'),
      join(sdkRoot, 'system-images', 'android-35', 'google_apis', 'arm64-v8a', 'package.xml'),
      join(avdHome, 'Pixel_6_API_35_Gestalt.avd', 'config.ini'),
    ]) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, path.endsWith('config.ini')
        ? 'image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n'
        : 'fixture\n')
    }
    let bootProbeStarted!: () => void
    const bootProbe = new Promise<void>((resolve) => { bootProbeStarted = resolve })
    let stops = 0
    const runner: AndroidCommandRunner = {
      run: async (_command, args, options) => {
        if (args[0] === '-accel-check') return { code: 0, stdout: 'accel ok', stderr: '' }
        bootProbeStarted()
        return await new Promise<AndroidCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('cancelled'))
          }, { once: true })
        })
      },
      spawn: () => ({
        pid: 42,
        exit: new Promise(() => {}),
        stop: async () => { stops += 1 },
      }),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    const starting = manager.start()
    await bootProbe
    manager.cancel()
    await expect(starting).rejects.toMatchObject({ code: 'PHONE_ANDROID_ABORTED' })
    expect(stops).toBe(1)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })
})
