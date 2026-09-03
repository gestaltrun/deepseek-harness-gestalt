import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import type { AndroidPreparationPlan, PhoneAndroidState } from '@deepseek-ai/dsh-phone-environment'
import { AndroidEnvironmentManager } from '../src/environment.ts'
import type {
  AndroidCommandResult, AndroidCommandRunner, AndroidOwnedProcess,
} from '../src/process.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-coverage-'))
  roots.push(root)
  return root
}

function result(overrides: Partial<AndroidCommandResult> = {}): AndroidCommandResult {
  return {
    exitCode: 0, signal: null, timedOut: false, callerAborted: false, stdout: '', stderr: '', ...overrides,
  }
}

const PLAN: AndroidPreparationPlan = {
  sdkRoot: '/sdk', sdkSource: 'managed', avdHome: '/avd', avdName: 'Pixel_6_API_35_Gestalt',
  abi: 'arm64-v8a', commandLineToolsVersion: '15859902', commandLineToolsBytes: 0,
  packageIds: ['platform-tools', 'emulator', 'system-images;android-35;google_apis;arm64-v8a'],
  minimumFreeBytes: 16 * 1024 ** 3, licenseUrl: 'https://developer.android.com/studio/terms',
  components: { commandLineTools: true, platformTools: true, emulator: true, systemImage: true, avd: true },
}

function planFor(root: string): AndroidPreparationPlan {
  return { ...PLAN, sdkRoot: join(root, 'sdk'), avdHome: join(root, 'avd') }
}

function runner(run: AndroidCommandRunner['run'] = async () => result()): AndroidCommandRunner {
  return {
    run,
    spawn: () => ({ pid: 42, exit: new Promise(() => {}), stop: async () => {} }),
  }
}

function manager(
  root: string,
  overrides: Partial<ConstructorParameters<typeof AndroidEnvironmentManager>[0]> = {},
) {
  return new AndroidEnvironmentManager({
    phoneRoot: root,
    platform: 'darwin',
    architecture: 'arm64',
    environment: { PATH: '' },
    homeDirectory: root,
    runner: runner(),
    freeBytes: async () => 32 * 1024 ** 3,
    ...overrides,
  })
}

interface ManagerInternals {
  plan: AndroidPreparationPlan | undefined
  asset: { platform: 'darwin'; architecture: 'arm64'; name: string; url: string; bytes: number; sha256: string } | undefined
  architecture: string
  operationTask: Promise<PhoneAndroidState> | undefined
  emulator: AndroidOwnedProcess | undefined
  current: PhoneAndroidState
  publish(state: PhoneAndroidState): void
  publishFailure(error: unknown): never
  publishStopped(): void
  publishStopFailure(error: unknown): void
  requireProcessFacts(result: AndroidCommandResult, signal: AbortSignal | undefined, code: string, command: string): void
  compatibleExistingSdkRoot(root: string, signal?: AbortSignal): Promise<boolean>
  waitForBoot(plan: AndroidPreparationPlan, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string>
  startEmulator(signal: AbortSignal): Promise<PhoneAndroidState>
  refreshOwned(signal: AbortSignal): Promise<PhoneAndroidState>
  freeBytes(path: string): Promise<number>
  removePath(path: string, recursive: boolean): Promise<void>
}

function assetFor(bytes: Uint8Array) {
  return {
    platform: 'darwin' as const,
    architecture: 'arm64' as const,
    name: 'commandlinetools.zip',
    url: 'https://dl.google.com/android/repository/commandlinetools.zip',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  return body
}

function internals(value: AndroidEnvironmentManager): ManagerInternals {
  return value as unknown as ManagerInternals
}

async function compatibleRoot(root: string, platform: NodeJS.Platform = 'darwin'): Promise<string> {
  const sdk = join(root, 'sdk')
  for (const name of ['sdkmanager', 'avdmanager']) {
    const path = join(sdk, 'cmdline-tools', 'latest', 'bin', platform === 'win32' ? `${name}.bat` : name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'fixture')
  }
  return sdk
}

describe('Android environment defensive outcomes', () => {
  it('uses production defaults, reports subscriber failures, and removes a subscriber', async () => {
    const root = await tempRoot()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = new AndroidEnvironmentManager({ phoneRoot: root })
    const following = vi.fn()
    value.onChanged(() => { throw new Error('subscriber failed') })
    const unsubscribe = value.onChanged(following)
    internals(value).publish({ kind: 'unsupported', reason: 'unsupported' })
    expect(report).toHaveBeenCalledWith(expect.any(Error))
    expect(following).toHaveBeenCalledOnce()
    unsubscribe()
    internals(value).publish({ kind: 'checking' })
    expect(following).toHaveBeenCalledOnce()
    internals(value).publish({ kind: 'checking' })
    expect(value.runtimeEnvironment()).toEqual({})
    expect(await internals(value).freeBytes(join(root, 'missing', 'sdk'))).toBeGreaterThan(0)
    await expect(internals(value).removePath(join(root, 'missing'), true)).resolves.toBeUndefined()
  })

  it('publishes unsupported detection and normalizes cancelled and failed refreshes', async () => {
    const root = await tempRoot()
    const unsupported = manager(root, { platform: 'freebsd', architecture: 'ia32' })
    await expect(unsupported.refresh()).resolves.toMatchObject({ kind: 'unsupported' })

    const cancelled = manager(root)
    const controller = new AbortController()
    controller.abort(new Error('cancel detection'))
    await expect(cancelled.refresh(controller.signal)).rejects.toMatchObject({ code: 'PHONE_ANDROID_ABORTED' })

    const failed = manager(root)
    ;(failed as unknown as { refreshOwned(): Promise<PhoneAndroidState> }).refreshOwned = async () => {
      throw new Error('detection failed')
    }
    await expect(failed.refresh()).rejects.toMatchObject({ code: 'PHONE_ANDROID_PREPARE' })
    expect(failed.snapshot()).toMatchObject({ kind: 'failed', message: 'detection failed' })
  })

  it('prepares without a prior refresh and preserves a plan-less unsupported failure', async () => {
    const root = await tempRoot()
    const value = manager(root, { platform: 'freebsd', architecture: 'ia32' })
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({
      code: 'PHONE_ANDROID_UNSUPPORTED',
    })
    expect(value.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_UNSUPPORTED' })
  })

  it('cancels preparation before detection owns a plan', async () => {
    const root = await tempRoot()
    const value = manager(root)
    const controller = new AbortController()
    internals(value).refreshOwned = async () => {
      controller.abort(new Error('cancel before plan'))
      throw new Error('detection stopped')
    }
    await expect(value.prepare({ licenseAccepted: true }, controller.signal)).rejects.toMatchObject({
      code: 'PHONE_ANDROID_ABORTED',
    })
    expect(value.snapshot()).toMatchObject({ kind: 'checking' })
  })

  it('normalizes every command termination fact before parsing output', async () => {
    const root = await tempRoot()
    const value = internals(manager(root))
    for (const [facts, code] of [
      [result({ terminationError: 'tree stop failed' }), 'CHECK_TERMINATION'],
      [result({ callerAborted: true }), 'PHONE_ANDROID_ABORTED'],
      [result({ timedOut: true }), 'CHECK_TIMEOUT'],
      [result({ signal: 'SIGTERM' }), 'CHECK_SIGNAL'],
    ] as const) {
      let thrown: unknown
      try { value.requireProcessFacts(facts, undefined, 'CHECK', 'tool') } catch (error) { thrown = error }
      expect(thrown).toMatchObject({ code })
    }
    const controller = new AbortController()
    controller.abort(new Error('owner cancelled'))
    expect(() => { value.requireProcessFacts(result({ callerAborted: true }), controller.signal, 'CHECK', 'tool') })
      .toThrow('owner cancelled')
  })

  it.each([
    [result({ timedOut: true }), result({ stdout: 'pixel_6\n' })],
    [result({ signal: 'SIGTERM' }), result({ stdout: 'pixel_6\n' })],
    [result({ exitCode: 1 }), result({ stdout: 'pixel_6\n' })],
    [result({ stdout: 'not-a-version' }), result({ stdout: 'pixel_6\n' })],
    [result({ stdout: '11.0\n' }), result({ stdout: 'pixel_6\n' })],
    [result({ stdout: '20.0\n' }), result({ timedOut: true, stdout: 'pixel_6\n' })],
    [result({ stdout: '20.0\n' }), result({ signal: 'SIGTERM', stdout: 'pixel_6\n' })],
    [result({ stdout: '20.0\n' }), result({ exitCode: 1, stdout: 'pixel_6\n' })],
    [result({ stdout: '20.0\n' }), result({ stdout: 'pixel_5\n' })],
  ])('rejects incompatible SDK manager facts %#', async (version, devices) => {
    const root = await tempRoot()
    const sdk = await compatibleRoot(root)
    let call = 0
    const value = manager(root, { runner: runner(async () => (call++ === 0 ? version : devices)) })
    await expect(internals(value).compatibleExistingSdkRoot(sdk)).resolves.toBe(false)
  })

  it('accepts a compatible SDK and contains an ordinary compatibility probe failure', async () => {
    const root = await tempRoot()
    const sdk = await compatibleRoot(root)
    const valid = manager(root, { runner: runner(async (_command, args) => (
      args.includes('--version') ? result({ stdout: '20.0\n' }) : result({ stdout: 'pixel_6\n' })
    )) })
    await expect(internals(valid).compatibleExistingSdkRoot(sdk)).resolves.toBe(true)

    const broken = manager(root, { runner: runner(async () => { throw new Error('Java missing') }) })
    await expect(internals(broken).compatibleExistingSdkRoot(sdk)).resolves.toBe(false)
  })

  it('rejects SDK roots missing write access or either manager executable', async () => {
    const root = await tempRoot()
    const value = manager(root)
    await expect(internals(value).compatibleExistingSdkRoot(join(root, 'missing'))).resolves.toBe(false)
    const sdk = join(root, 'sdk')
    await mkdir(sdk)
    await expect(internals(value).compatibleExistingSdkRoot(sdk)).resolves.toBe(false)
    const sdkmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
    await mkdir(join(sdkmanager, '..'), { recursive: true })
    await writeFile(sdkmanager, 'fixture')
    await expect(internals(value).compatibleExistingSdkRoot(sdk)).resolves.toBe(false)
  })

  it('propagates caller cancellation from either compatibility probe', async () => {
    const root = await tempRoot()
    const sdk = await compatibleRoot(root)
    for (const cancelAt of [0, 1]) {
      const controller = new AbortController()
      let call = 0
      const value = manager(root, { runner: runner(async () => {
        if (call++ === cancelAt) {
          controller.abort(new Error('compatibility cancelled'))
          return result({ callerAborted: true })
        }
        return call === 1 ? result({ stdout: '20.0\n' }) : result({ stdout: 'pixel_6\n' })
      }) })
      await expect(internals(value).compatibleExistingSdkRoot(sdk, controller.signal))
        .rejects.toThrow('compatibility cancelled')
    }
  })

  it('rejects start before preparation and renders the macOS acceleration instruction', async () => {
    const root = await tempRoot()
    const unprepared = manager(root)
    await unprepared.refresh()
    await expect(unprepared.start()).rejects.toMatchObject({ code: 'PHONE_ANDROID_NOT_PREPARED' })

    const accelerated = manager(root, {
      runner: runner(async (_command, args) => args.includes('-accel-check')
        ? result({ exitCode: 1, stderr: 'Hypervisor unavailable' })
        : result()),
    })
    internals(accelerated).plan = PLAN
    await expect(accelerated.start()).resolves.toMatchObject({ kind: 'manual-required', code: 'virtualization' })
  })

  it('ignores a superseded Emulator exit and contains an exit promise rejection', async () => {
    const root = await tempRoot()
    const firstExit = Promise.withResolvers<AndroidCommandResult>()
    const secondExit = Promise.withResolvers<AndroidCommandResult>()
    let spawned = 0
    const value = manager(root, {
      runner: {
        run: async () => result(),
        spawn: () => ({
          pid: 42,
          exit: spawned++ === 0 ? firstExit.promise : secondExit.promise,
          stop: async () => {},
        }),
      },
    })
    const owned = internals(value)
    owned.plan = PLAN
    owned.waitForBoot = async () => 'emulator-5554'
    await owned.startEmulator(new AbortController().signal)
    await owned.startEmulator(new AbortController().signal)
    const replacement = owned.emulator
    firstExit.resolve(result({ exitCode: 1 }))
    secondExit.reject(new Error('exit observer failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(owned.emulator).toBe(replacement)
    expect(value.snapshot()).toMatchObject({ kind: 'ready', running: true })
  })

  it('rejects a non-zero package command with a bounded diagnostic tail', async () => {
    const root = await tempRoot()
    const value = manager(root, {
      runner: runner(async () => result({ exitCode: 7, stderr: `prefix${'x'.repeat(1_200)}` })),
    })
    const owned = internals(value)
    owned.plan = planFor(root)
    owned.asset = assetFor(new Uint8Array())
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_LICENSES' })
    const state = value.snapshot()
    expect(state).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_LICENSES' })
    if (state.kind !== 'failed') throw new Error('failed command did not publish its state')
    expect(state.message).not.toContain('prefix')
    expect(state.message.endsWith('x'.repeat(1_000))).toBe(true)
  })

  it('rejects an AVD whose generated config does not name the pinned ABI', async () => {
    const root = await tempRoot()
    const partial = { ...planFor(root), components: { ...PLAN.components, avd: false } }
    const value = manager(root, {
      runner: runner(async (_command, args) => {
        if (args.includes('create')) {
          const avd = join(partial.avdHome, `${partial.avdName}.avd`)
          await mkdir(avd, { recursive: true })
          await writeFile(join(avd, 'config.ini'), 'image.sysdir.1=system-images/android-35/google_apis/x86_64/\n')
        }
        return result()
      }),
    })
    const owned = internals(value)
    owned.plan = partial
    owned.asset = assetFor(new Uint8Array())
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_AVD' })
  })

  it('rejects an installed plan when the Host tuple becomes unsupported', async () => {
    const root = await tempRoot()
    const value = manager(root, {
      runner: runner(async (_command, args) => {
        if (args.includes('--install')) internals(value).architecture = 'ia32'
        return result()
      }),
    })
    const owned = internals(value)
    owned.plan = planFor(root)
    owned.asset = assetFor(new Uint8Array())
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_UNSUPPORTED' })
  })

  it('aggregates an ordinary AVD creation failure with its cleanup failure', async () => {
    const root = await tempRoot()
    const partial = { ...planFor(root), components: { ...PLAN.components, avd: false } }
    let removals = 0
    const value = manager(root, {
      runner: runner(async (_command, args) => args.includes('create') ? result({ exitCode: 1 }) : result()),
      removePath: async () => {
        removals += 1
        if (removals > 2) throw 'cleanup string failure'
      },
    })
    const owned = internals(value)
    owned.plan = partial
    owned.asset = assetFor(new Uint8Array())
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_CLEANUP' })
    expect(value.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_CLEANUP' })
  })

  it.each([
    [new Response(null, { status: 503 }), 'PHONE_ANDROID_DOWNLOAD'],
    [new Response(null, { status: 200 }), 'PHONE_ANDROID_DOWNLOAD'],
  ])('rejects command-line tool response %#', async (response, code) => {
    const root = await tempRoot()
    const bytes = zipSync({ 'cmdline-tools/bin/sdkmanager': new Uint8Array([1]) })
    const value = manager(root, {
      commandLineToolsAsset: assetFor(bytes),
      fetch: async () => response,
    })
    await value.refresh()
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code })
  })

  it.each([
    ['declared length', (bytes: Uint8Array) => ({
      asset: assetFor(bytes), response: new Response(responseBody(bytes), { headers: { 'content-length': String(bytes.byteLength + 1) } }),
    })],
    ['excess body', (bytes: Uint8Array) => ({
      asset: { ...assetFor(bytes), bytes: bytes.byteLength - 1 }, response: new Response(responseBody(bytes)),
    })],
    ['truncated body', (bytes: Uint8Array) => ({
      asset: assetFor(bytes), response: new Response(responseBody(bytes.slice(0, -1))),
    })],
  ])('rejects command-line tool %s', async (_name, arrange) => {
    const root = await tempRoot()
    const bytes = zipSync({ 'cmdline-tools/bin/sdkmanager': new Uint8Array([1]) })
    const arranged = arrange(bytes)
    const value = manager(root, {
      commandLineToolsAsset: arranged.asset,
      fetch: async () => arranged.response,
    })
    await value.refresh()
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_LENGTH' })
  })

  it.each([
    ['root escape', { 'cmdline-tools/../escape': new Uint8Array([1]), 'cmdline-tools/bin/sdkmanager': new Uint8Array([1]) }],
    ['missing sdkmanager', { 'cmdline-tools/source.properties': new Uint8Array([1]) }],
  ])('rejects command-line tool archive %s', async (_name, entries) => {
    const root = await tempRoot()
    const bytes = zipSync(entries)
    const value = manager(root, {
      commandLineToolsAsset: assetFor(bytes),
      fetch: async () => new Response(responseBody(bytes)),
    })
    await value.refresh()
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_ARCHIVE' })
  })

  it('skips archive directory entries before validating the extracted SDK', async () => {
    const root = await tempRoot()
    const bytes = zipSync({
      'cmdline-tools/bin/': new Uint8Array(),
      'cmdline-tools/bin/sdkmanager': new Uint8Array([1]),
    })
    const value = manager(root, {
      commandLineToolsAsset: assetFor(bytes),
      fetch: async () => new Response(responseBody(bytes)),
    })
    await value.refresh()
    await expect(value.prepare({ licenseAccepted: true })).rejects.toMatchObject({ code: 'PHONE_ANDROID_AVD' })
  })

  it('publishes stopped and stop-failure outcomes for prepared and partial plans', async () => {
    const root = await tempRoot()
    const value = manager(root)
    const owned = internals(value)
    owned.plan = PLAN
    owned.current = { kind: 'failed', plan: PLAN, code: 'PHONE_ANDROID_EMULATOR_STOP', message: 'stop failed', retryable: true }
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'ready', running: false })
    owned.publishStopped()
    owned.current = { kind: 'booting', plan: PLAN }
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'ready', running: false })

    const partial = { ...PLAN, components: { ...PLAN.components, emulator: false } }
    owned.plan = partial
    owned.current = { kind: 'checking-acceleration', plan: partial }
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'missing' })
    owned.current = {
      kind: 'failed', plan: partial, code: 'PHONE_ANDROID_EMULATOR_STOP', message: 'stop failed', retryable: true,
    }
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'missing' })
    owned.current = { kind: 'unsupported', reason: 'not available' }
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'unsupported' })
    owned.publishStopFailure('stop string failure')
    expect(value.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_STOP' })

    owned.plan = undefined
    owned.publishStopFailure(new Error('ignored without a plan'))
    owned.publishStopped()
    expect(value.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_ANDROID_EMULATOR_STOP' })
  })

  it('retains the operation failure when Emulator teardown also fails', async () => {
    const root = await tempRoot()
    const value = manager(root)
    const owned = internals(value)
    owned.plan = PLAN
    owned.operationTask = Promise.reject(new Error('operation failed'))
    owned.emulator = {
      pid: 42, exit: new Promise(() => {}), stop: async () => { throw new Error('stop failed') },
    }
    await expect(value.deactivate()).rejects.toThrow('operation failed')
    expect(value.snapshot()).toMatchObject({ kind: 'failed', message: 'operation failed' })
  })

  it('times out boot discovery and aborts a pending retry delay', async () => {
    vi.useFakeTimers()
    const root = await tempRoot()
    const value = manager(root, { runner: runner(async () => result({ stdout: 'List of devices attached\n' })) })
    const boot = internals(value).waitForBoot(PLAN, {}, new AbortController().signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(181_000)
    expect(await boot).toMatchObject({ code: 'PHONE_ANDROID_BOOT_TIMEOUT' })

    const controller = new AbortController()
    const cancelled = internals(value).waitForBoot(PLAN, {}, controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort('stop boot')
    expect(await cancelled).toEqual(expect.objectContaining({ message: 'stop boot' }))
  })

  it('waits past the wrong AVD name and an incomplete boot property', async () => {
    vi.useFakeTimers()
    const root = await tempRoot()
    let names = 0
    let boots = 0
    const value = manager(root, { runner: runner(async (_command, args) => {
      if (args[0] === 'devices') return result({ stdout: 'emulator-5554\tdevice\n' })
      if (args.includes('name')) return result({ stdout: `${names++ === 0 ? 'Other' : PLAN.avdName}\n` })
      return result({ stdout: `${boots++ === 0 ? '0' : '1'}\n` })
    }) })
    const boot = internals(value).waitForBoot(PLAN, {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(boot).resolves.toBe('emulator-5554')
  })

  it.each([
    [result({ terminationError: 'stop failed' }), 'teardown failed'],
    [result({ callerAborted: true }), 'cancelled by its caller'],
    [result({ timedOut: true }), 'exceeded its deadline'],
    [result({ signal: 'SIGKILL' }), 'exited by SIGKILL'],
    [result({ exitCode: 9 }), 'exited with code 9'],
  ] as const)('publishes the owned Emulator exit fact %#', async (outcome, message) => {
    const root = await tempRoot()
    const exit = Promise.withResolvers<AndroidCommandResult>()
    const value = manager(root, { runner: {
      run: async () => result(),
      spawn: () => ({ pid: 42, exit: exit.promise, stop: async () => {} }),
    } })
    const owned = internals(value)
    owned.plan = PLAN
    owned.waitForBoot = async () => 'emulator-5554'
    await owned.startEmulator(new AbortController().signal)
    exit.resolve(outcome)
    await vi.waitFor(() => {
      const state = value.snapshot()
      expect(state.kind).toBe('failed')
      if (state.kind === 'failed') expect(state.message).toContain(message)
    })
  })

  it('builds an SDK PATH without an ambient PATH entry', async () => {
    const root = await tempRoot()
    const value = manager(root, { environment: {} })
    const owned = internals(value)
    owned.plan = PLAN
    expect(value.runtimeEnvironment().PATH).not.toMatch(/:$/u)
    await value.refresh()
    expect(value.snapshot().kind).not.toBe('checking')
  })

  it.each(['cmdline-tools/latest/bin', 'tools/bin'])('discovers an existing SDK from PATH ending in %s', async (suffix) => {
    const root = await tempRoot()
    const sdk = await compatibleRoot(root, process.platform)
    const value = manager(root, {
      platform: process.platform,
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      environment: { PATH: join(sdk, ...suffix.split('/')) },
      runner: runner(async (_command, args) => args.includes('--version')
        ? result({ stdout: '20.0\n' })
        : result({ stdout: 'pixel_6\n' })),
    })
    await value.refresh()
    expect(value.snapshot()).toMatchObject({ plan: { sdkRoot: sdk, sdkSource: 'existing' } })
  })

  it('exhausts cleanup when a private AVD path is continuously recreated', async () => {
    const root = await tempRoot()
    const target = join(root, 'android', 'avd', 'Pixel_6_API_35_Gestalt.avd')
    await mkdir(target, { recursive: true })
    const value = manager(root, {
      removalRaceHook: async (path) => { await mkdir(path, { recursive: true }) },
    })
    await expect(internals(value).removePath(target, true)).rejects.toThrow(/changed during cleanup/)
  })
})
