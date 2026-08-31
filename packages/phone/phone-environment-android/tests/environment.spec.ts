import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

async function stageReadySdk(root: string): Promise<string> {
  const sdkRoot = join(root, 'sdk')
  const avdHome = join(root, 'android', 'avd')
  for (const path of [
    join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
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
  return sdkRoot
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

function commandResult(overrides: Partial<AndroidCommandResult> = {}): AndroidCommandResult {
  return {
    exitCode: 0, signal: null, timedOut: false, callerAborted: false, stdout: '', stderr: '', ...overrides,
  }
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
      if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
      const avd = join(this.phoneRoot, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd')
      await mkdir(avd, { recursive: true })
      await writeFile(join(avd, 'config.ini'), 'image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n')
    }
    if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
    if (args[0] === 'devices') return commandResult({ stdout: 'List of devices attached\nemulator-5554\tdevice\n' })
    if (args.includes('avd') && args.includes('name')) return commandResult({ stdout: 'Pixel_6_API_35_Gestalt\nOK\n' })
    if (args.includes('getprop')) return commandResult({ stdout: '1\n' })
    return commandResult({ stdout: 'accel:\n0\nHypervisor.Framework\n' })
  }

  spawn(): AndroidOwnedProcess {
    const result = commandResult({ exitCode: null })
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

  it('reserves one preparation owner before disk preflight and keeps cancellation on that owner', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    let releaseFree!: () => void
    const free = new Promise<number>((resolve) => { releaseFree = () => { resolve(32 * 1024 ** 3) } })
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: join(root, 'home'), runner: new FixtureRunner(root), commandLineToolsAsset: fixture.asset,
      freeBytes: async () => await free,
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    const first = manager.prepare({ licenseAccepted: true })
    await expect(manager.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_BUSY' })
    manager.cancel()
    releaseFree()
    await expect(first).rejects.toMatchObject({ code: 'PHONE_ANDROID_ABORTED' })
  })

  it('keeps initial detection under one joinable Provider transaction owner', async () => {
    const root = await tempRoot()
    const sdkRoot = await stageReadySdk(root)
    const probeStarted = Promise.withResolvers<undefined>()
    const releaseProbe = Promise.withResolvers<undefined>()
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => {
        if (args.includes('--version')) {
          probeStarted.resolve(undefined)
          await releaseProbe.promise
          return commandResult({ stdout: '20.0\n' })
        }
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        return commandResult()
      },
      spawn: () => { throw new Error('busy detection must not start an emulator') },
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })

    const refreshing = manager.refresh()
    await probeStarted.promise
    await expect(manager.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_BUSY' })
    await expect(manager.start()).rejects.toMatchObject({ code: 'PHONE_ANDROID_BUSY' })
    let deactivated = false
    const deactivating = manager.deactivate().then(() => { deactivated = true })
    await Promise.resolve()
    expect(deactivated).toBe(false)
    releaseProbe.resolve(undefined)

    await expect(refreshing).rejects.toMatchObject({ code: 'PHONE_ANDROID_ABORTED' })
    await deactivating
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
    const prepared = await manager.prepare({ licenseAccepted: true })
    expect(prepared).toMatchObject({
      kind: 'ready', running: false,
      plan: {
        sdkSource: 'managed', abi: 'arm64-v8a',
        components: { commandLineTools: true, platformTools: true, emulator: true, systemImage: true, avd: true },
      },
    })
    const ready = await manager.start()
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
    await manager.start()
    await manager.deactivate()
    expect(runner.stops).toBe(2)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('removes a cancelled partial AVD before a retry creates the private default', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const base = new FixtureRunner(root)
    const createStarted = Promise.withResolvers<undefined>()
    let blockCreate = true
    const runner: AndroidCommandRunner = {
      run: async (command, args, options) => {
        if (command.endsWith('avdmanager') && args.includes('create') && blockCreate) {
          const avdHome = options.env.ANDROID_AVD_HOME as string
          const avd = join(avdHome, 'Pixel_6_API_35_Gestalt.avd')
          await mkdir(avd, { recursive: true })
          await writeFile(join(avd, 'config.ini'), 'partial\n')
          await writeFile(join(avdHome, 'Pixel_6_API_35_Gestalt.ini'), 'partial\n')
          createStarted.resolve(undefined)
          return await new Promise<AndroidCommandResult>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
          })
        }
        return await base.run(command, args, options)
      },
      spawn: () => base.spawn(),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner, freeBytes: async () => 32 * 1024 ** 3,
      commandLineToolsAsset: fixture.asset,
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    const staleAvd = join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd')
    await mkdir(staleAvd, { recursive: true })
    await writeFile(join(staleAvd, 'config.ini'), 'crash-partial\n')
    const preparing = manager.prepare({ licenseAccepted: true })
    await createStarted.promise
    manager.cancel()
    await expect(preparing).rejects.toMatchObject({ code: 'PHONE_ANDROID_ABORTED' })
    await expect(access(join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.ini'))).rejects.toMatchObject({ code: 'ENOENT' })

    blockCreate = false
    await expect(manager.prepare({ licenseAccepted: true })).resolves.toMatchObject({ kind: 'ready', running: false })
  })

  it('unlinks an AVD junction without recursively deleting its external target', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const runner = new FixtureRunner(root)
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner, freeBytes: async () => 32 * 1024 ** 3,
      commandLineToolsAsset: fixture.asset,
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    const external = join(root, 'external-avd-target')
    const sentinel = join(external, 'keep.txt')
    const avd = join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd')
    await mkdir(external, { recursive: true })
    await writeFile(sentinel, 'keep\n')
    await mkdir(join(avd, '..'), { recursive: true })
    await symlink(external, avd, 'junction')

    await expect(manager.prepare({ licenseAccepted: true })).resolves.toMatchObject({ kind: 'ready', running: false })

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep\n')
    await expect(readFile(join(avd, 'config.ini'), 'utf8')).resolves.toContain('android-35')
  })

  it('keeps cancellation and AVD cleanup failure facts in the terminal state', async () => {
    const root = await tempRoot()
    const fixture = archiveAsset()
    const base = new FixtureRunner(root)
    const createStarted = Promise.withResolvers<undefined>()
    const cleanupFailure = new Error('private AVD cleanup was denied')
    const reportError = vi.fn()
    let removals = 0
    const runner: AndroidCommandRunner = {
      run: async (command, args, options) => {
        if (command.endsWith('avdmanager') && args.includes('create')) {
          const avd = join(options.env.ANDROID_AVD_HOME as string, 'Pixel_6_API_35_Gestalt.avd')
          await mkdir(avd, { recursive: true })
          await writeFile(join(avd, 'config.ini'), 'partial\n')
          createStarted.resolve(undefined)
          return await new Promise<AndroidCommandResult>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
          })
        }
        return await base.run(command, args, options)
      },
      spawn: () => base.spawn(),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner, freeBytes: async () => 32 * 1024 ** 3,
      commandLineToolsAsset: fixture.asset, reportError,
      removePath: async (path, recursive) => {
        removals += 1
        if (removals > 2) throw cleanupFailure
        await rm(path, { recursive, force: true })
      },
      fetch: async () => new Response(bodyOf(fixture.bytes), { headers: { 'content-length': String(fixture.bytes.byteLength) } }),
    })
    await manager.refresh()
    const preparing = manager.prepare({ licenseAccepted: true })
    await createStarted.promise
    manager.cancel()

    await expect(preparing).rejects.toMatchObject({
      code: 'PHONE_ANDROID_ABORTED',
      message: expect.stringMatching(/cancelled; private AVD cleanup failed: private AVD cleanup was denied/u),
      cause: expect.any(AggregateError),
    })
    expect(reportError).toHaveBeenCalledWith(cleanupFailure)
    expect(manager.snapshot()).toMatchObject({
      kind: 'failed', code: 'PHONE_ANDROID_ABORTED',
      message: expect.stringMatching(/cleanup failed/u), retryable: true,
    })
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

  it.each([
    ['obsolete', commandResult({ stdout: '11.0\n' })],
    ['broken', commandResult({ exitCode: 1, stderr: 'Java runtime failed' })],
  ])('falls back to the private SDK when an existing sdkmanager is %s', async (_label, versionResult) => {
    const root = await tempRoot()
    const existing = join(root, 'existing-sdk')
    for (const name of ['sdkmanager', 'avdmanager']) {
      const path = join(existing, 'cmdline-tools', 'latest', 'bin', name)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, 'fixture\n')
    }
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => args.includes('--version')
        ? versionResult
        : commandResult({ stdout: 'pixel_6\n' }),
      spawn: () => { throw new Error('an incompatible SDK must not start an emulator') },
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: existing, PATH: '' }, homeDirectory: join(root, 'home'), runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    expect(manager.snapshot()).toMatchObject({
      kind: 'missing', plan: { sdkSource: 'managed', sdkRoot: join(root, 'android', 'sdk') },
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
      join(sdkRoot, 'cmdline-tools', 'latest', 'bin', platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'),
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
      run: async (_command, args) => {
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        return args[0] === '-accel-check'
          ? commandResult({ exitCode: 1, stderr: 'acceleration unavailable' })
          : commandResult()
      },
      spawn: () => { throw new Error('emulator must not start') },
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform, architecture: 'x64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    await expect(manager.start()).resolves.toMatchObject({
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
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
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

  it('does not parse partial stdout from failed adb boot probes', async () => {
    vi.useFakeTimers()
    try {
      const root = await tempRoot()
      const sdkRoot = await stageReadySdk(root)
      let devices = 0
      let names = 0
      let boots = 0
      const runner: AndroidCommandRunner = {
        run: async (_command, args) => {
          if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
          if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
          if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
          if (args[0] === 'devices') {
            devices += 1
            return commandResult({
              exitCode: devices === 1 ? 1 : 0,
              stdout: 'emulator-5554\tdevice\n',
            })
          }
          if (args.includes('name')) {
            names += 1
            return commandResult({ exitCode: names === 1 ? 1 : 0, stdout: 'Pixel_6_API_35_Gestalt\n' })
          }
          boots += 1
          return commandResult({ exitCode: boots === 1 ? 1 : 0, stdout: '1\n' })
        },
        spawn: () => ({ pid: 42, exit: new Promise(() => {}), stop: async () => {} }),
      }
      const manager = new AndroidEnvironmentManager({
        phoneRoot: root, platform: 'darwin', architecture: 'arm64',
        environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
        freeBytes: async () => 32 * 1024 ** 3,
      })
      await manager.refresh()
      const starting = manager.start()
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(starting).resolves.toMatchObject({ kind: 'ready', running: true })
      expect({ devices, names, boots }).toEqual({ devices: 4, names: 3, boots: 2 })
      await manager.deactivate()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one pending Emulator stop across cancel and deactivate', async () => {
    const root = await tempRoot()
    const sdkRoot = await stageReadySdk(root)
    const stopStarted = Promise.withResolvers<undefined>()
    const releaseStop = Promise.withResolvers<undefined>()
    let stops = 0
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => {
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
        if (args[0] === 'devices') return commandResult({ stdout: 'emulator-5554\tdevice\n' })
        if (args.includes('name')) return commandResult({ stdout: 'Pixel_6_API_35_Gestalt\n' })
        return commandResult({ stdout: '1\n' })
      },
      spawn: () => ({
        pid: 42,
        exit: new Promise(() => {}),
        stop: async () => {
          stops += 1
          stopStarted.resolve(undefined)
          await releaseStop.promise
        },
      }),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    await manager.start()

    manager.cancel()
    await stopStarted.promise
    let deactivated = false
    const deactivating = manager.deactivate().then(() => { deactivated = true })
    await Promise.resolve()
    expect(deactivated).toBe(false)
    expect(stops).toBe(1)
    releaseStop.resolve(undefined)
    await deactivating
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('keeps a failed Emulator stop visible and retries the retained process on deactivate', async () => {
    const root = await tempRoot()
    const sdkRoot = await stageReadySdk(root)
    const stopFailure = new Error('taskkill refused the process tree')
    const reportError = vi.fn()
    let stopAttempts = 0
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => {
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
        if (args[0] === 'devices') return commandResult({ stdout: 'emulator-5554\tdevice\n' })
        if (args.includes('name')) return commandResult({ stdout: 'Pixel_6_API_35_Gestalt\n' })
        return commandResult({ stdout: '1\n' })
      },
      spawn: () => ({
        pid: 42,
        exit: new Promise(() => {}),
        stop: async () => {
          stopAttempts += 1
          if (stopAttempts === 1) throw stopFailure
        },
      }),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3, reportError,
    })
    await manager.refresh()
    await manager.start()

    manager.cancel()
    await vi.waitFor(() => { expect(reportError).toHaveBeenCalledWith(stopFailure) })
    expect(manager.snapshot()).toMatchObject({
      kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_STOP', retryable: true,
    })
    await expect(manager.deactivate()).resolves.toBeUndefined()
    expect(stopAttempts).toBe(2)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('contains and reports a subscriber failure before notifying the next subscriber', async () => {
    const root = await tempRoot()
    const reportError = vi.fn()
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64', environment: { PATH: '' },
      homeDirectory: root, runner: new FixtureRunner(root), freeBytes: async () => 32 * 1024 ** 3,
      reportError,
    })
    const failure = new Error('subscriber failed')
    const following = vi.fn()
    manager.onChanged(() => { throw failure })
    manager.onChanged(following)

    await manager.refresh()

    expect(reportError).toHaveBeenCalledWith(failure)
    expect(following).toHaveBeenCalled()
  })

  it('fails immediately when the owned Emulator exits during boot', async () => {
    const root = await tempRoot()
    const sdkRoot = await stageReadySdk(root)
    const exit = Promise.withResolvers<AndroidCommandResult>()
    const spawned = Promise.withResolvers<undefined>()
    const runner: AndroidCommandRunner = {
      run: async (_command, args, options) => {
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
        return await new Promise<AndroidCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
        })
      },
      spawn: () => {
        spawned.resolve(undefined)
        return { pid: 42, exit: exit.promise, stop: async () => { exit.resolve(commandResult({ callerAborted: true })) } }
      },
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    const starting = manager.start()
    await spawned.promise
    exit.resolve(commandResult({ exitCode: 1, stderr: 'emulator crash' }))
    await expect(starting).rejects.toMatchObject({ code: 'PHONE_ANDROID_EMULATOR_EXIT' })
    expect(manager.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_EXIT' })
  })

  it('revokes running readiness when the owned Emulator exits after boot', async () => {
    const root = await tempRoot()
    const sdkRoot = await stageReadySdk(root)
    const exit = Promise.withResolvers<AndroidCommandResult>()
    const runner: AndroidCommandRunner = {
      run: async (_command, args) => {
        if (args.includes('--version')) return commandResult({ stdout: '20.0\n' })
        if (args[0] === 'list') return commandResult({ stdout: 'pixel_6\n' })
        if (args[0] === '-accel-check') return commandResult({ stdout: 'accel ok' })
        if (args[0] === 'devices') return commandResult({ stdout: 'emulator-5554\tdevice\n' })
        if (args.includes('name')) return commandResult({ stdout: 'Pixel_6_API_35_Gestalt\n' })
        return commandResult({ stdout: '1\n' })
      },
      spawn: () => ({
        pid: 42, exit: exit.promise,
        stop: async () => { exit.resolve(commandResult({ callerAborted: true })) },
      }),
    }
    const manager = new AndroidEnvironmentManager({
      phoneRoot: root, platform: 'darwin', architecture: 'arm64',
      environment: { ANDROID_HOME: sdkRoot, PATH: '' }, homeDirectory: root, runner,
      freeBytes: async () => 32 * 1024 ** 3,
    })
    await manager.refresh()
    await expect(manager.start()).resolves.toMatchObject({ kind: 'ready', running: true })
    exit.resolve(commandResult({ exitCode: null, signal: 'SIGABRT' }))
    await vi.waitFor(() => {
      expect(manager.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_EXIT' })
    })
  })
})
