import { describe, expect, it } from 'vitest'
import { IosEnvironmentManager } from '../src/environment.ts'
import type { IosCommandOptions, IosCommandResult, IosCommandRunner } from '../src/process.ts'
import type { PhoneIosState } from '../src/types.ts'

type Call = { readonly command: string; readonly args: readonly string[] }

class FixtureRunner implements IosCommandRunner {
  readonly calls: Call[] = []
  runtimeInstalled = false
  simulatorCreated = false
  simulatorBooted = false
  deviceIdentifier = '8294A429-4C99-411F-A46D-0AD9499B7FDD'

  constructor(readonly mode: 'ready' | 'xcode-missing' | 'license' | 'first-launch' | 'runtime' | 'no-simulator' | 'failed') {}

  async run(command: string, args: readonly string[], _options: IosCommandOptions): Promise<IosCommandResult> {
    this.calls.push({ command, args })
    if (this.mode === 'failed' && args[0] === '-downloadPlatform') return result(1, '', 'download failed')
    if (command === 'xcode-select') {
      return this.mode === 'xcode-missing'
        ? result(1, '', 'unable to get active developer directory')
        : result(0, '/Applications/Xcode.app/Contents/Developer\n')
    }
    if (command === 'xcodebuild' && args[0] === '-version') return result(0, 'Xcode 17.0\nBuild version 17A1\n')
    if (command === 'xcodebuild' && args[0] === '-license') return this.mode === 'license' ? result(69, '', 'license') : result(0)
    if (command === 'xcodebuild' && args[0] === '-checkFirstLaunchStatus') {
      return this.mode === 'first-launch' ? result(69, '', 'components') : result(0)
    }
    if (command === 'xcodebuild' && args[0] === '-downloadPlatform') {
      this.runtimeInstalled = true
      return result(0)
    }
    if (command === 'xcrun' && args.slice(0, 3).join(' ') === 'simctl list runtimes') {
      const available = this.runtimeInstalled || !['runtime', 'failed'].includes(this.mode)
      return result(0, JSON.stringify({ runtimes: available ? [{
        identifier: 'runtime-26-0', name: 'iOS 26.0', version: '26.0', isAvailable: true,
      }] : [] }))
    }
    if (command === 'xcrun' && args.slice(0, 3).join(' ') === 'simctl list devicetypes') {
      return result(0, JSON.stringify({ devicetypes: [{ identifier: 'type-iphone-17', name: 'iPhone 17' }] }))
    }
    if (command === 'xcrun' && args.slice(0, 4).join(' ') === 'simctl list devices available') {
      const existing = this.mode === 'ready' || this.simulatorCreated
      return result(0, JSON.stringify({ devices: {
        'runtime-26-0': existing ? [{
          udid: this.deviceIdentifier, name: 'DSH Gestalt iPhone',
          state: this.simulatorBooted || this.mode === 'ready' ? 'Booted' : 'Shutdown', isAvailable: true,
        }] : [],
      } }))
    }
    if (command === 'xcrun' && args[1] === 'create') {
      this.simulatorCreated = true
      return result(0, `${this.deviceIdentifier}\n`)
    }
    if (command === 'xcrun' && args[1] === 'boot') {
      this.simulatorBooted = true
      return result(0)
    }
    if (command === 'xcrun' && args[1] === 'bootstatus') return result(0)
    if (command === 'xcrun' && args[1] === 'shutdown') {
      this.simulatorBooted = false
      return result(0)
    }
    throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`)
  }
}

function result(code = 0, stdout = '', stderr = ''): IosCommandResult {
  return { code, signal: null, timedOut: false, stdout, stderr }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error('fixture command was cancelled', { cause: reason })
}

describe('iOS environment manager', () => {
  it('constructs the production defaults without running a Host command', () => {
    expect(new IosEnvironmentManager().snapshot()).toMatchObject({
      kind: process.platform === 'darwin' ? 'xcode-missing' : 'unsupported',
    })
  })

  it('reserves operation ownership before checking-state notification', async () => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner('ready') })
    let reentry: Promise<unknown> | undefined
    manager.onChanged((state) => {
      if (state.kind !== 'checking' || reentry !== undefined) return
      reentry = manager.refresh()
      void reentry.catch(() => {})
    })
    await manager.refresh()
    await expect(reentry).rejects.toMatchObject({ code: 'PHONE_IOS_BUSY' })
  })
  it.each([
    ['win32', 'Windows'],
    ['linux', 'Linux'],
  ])('never spawns iOS commands on %s', async (platform, family) => {
    const runner = new FixtureRunner('ready')
    const manager = new IosEnvironmentManager({ platform, runner })
    await expect(manager.refresh()).resolves.toEqual({
      kind: 'unsupported',
      reason: `${family} cannot run iOS Simulator or control iPhone devices; use macOS with a complete Xcode installation.`,
    })
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_UNSUPPORTED' })
    await expect(manager.start()).rejects.toMatchObject({ code: 'PHONE_IOS_UNSUPPORTED' })
    expect(runner.calls).toEqual([])
  })

  it.each([
    ['xcode-missing', { kind: 'xcode-missing' }],
    ['license', { kind: 'license-required' }],
    ['first-launch', { kind: 'manual-required', code: 'first-launch' }],
    ['runtime', { kind: 'runtime-missing' }],
    ['no-simulator', { kind: 'no-simulator' }],
    ['ready', { kind: 'ready', running: true }],
  ] as const)('publishes the %s detection state', async (mode, expected) => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner(mode) })
    await expect(manager.refresh()).resolves.toMatchObject(expected)
  })

  it('downloads an iOS runtime, creates the managed simulator, and starts it separately', async () => {
    const runner = new FixtureRunner('runtime')
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    const states: string[] = []
    manager.onChanged(state => states.push(state.kind === 'preparing' ? `${state.kind}:${state.step}` : state.kind))
    await manager.refresh()
    await expect(manager.prepare()).resolves.toMatchObject({
      kind: 'ready', deviceId: '8294A429-4C99-411F-A46D-0AD9499B7FDD', running: false,
    })
    expect(runner.calls).toEqual(expect.arrayContaining([
      { command: 'xcodebuild', args: ['-downloadPlatform', 'iOS'] },
      { command: 'xcrun', args: ['simctl', 'create', 'DSH Gestalt iPhone', 'type-iphone-17', 'runtime-26-0'] },
    ]))
    expect(states).toEqual(expect.arrayContaining([
      'runtime-missing', 'preparing:downloading-runtime', 'no-simulator',
      'preparing:creating-simulator', 'ready',
    ]))
    await expect(manager.start()).resolves.toMatchObject({ kind: 'ready', running: true })
    expect(runner.calls).toEqual(expect.arrayContaining([
      { command: 'xcrun', args: ['simctl', 'boot', '8294A429-4C99-411F-A46D-0AD9499B7FDD'] },
      { command: 'xcrun', args: ['simctl', 'bootstatus', '8294A429-4C99-411F-A46D-0AD9499B7FDD', '-b'] },
    ]))
    await manager.deactivate()
    expect(runner.calls).toContainEqual({
      command: 'xcrun', args: ['simctl', 'shutdown', '8294A429-4C99-411F-A46D-0AD9499B7FDD'],
    })
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
    await expect(manager.start()).resolves.toMatchObject({ kind: 'ready', running: true })
  })

  it('keeps Xcode license and first-launch authorization manual', async () => {
    for (const mode of ['license', 'first-launch'] as const) {
      const runner = new FixtureRunner(mode)
      const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
      await manager.refresh()
      await expect(manager.prepare()).rejects.toMatchObject({
        code: mode === 'license' ? 'PHONE_IOS_LICENSE_REQUIRED' : 'PHONE_IOS_FIRST_LAUNCH',
      })
      expect(runner.calls.some(call => call.args.includes('-downloadPlatform'))).toBe(false)
    }
  })

  it('keeps a missing Xcode installation manual', async () => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner('xcode-missing') })
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_XCODE_MISSING' })
  })

  it('reports listener failures, removes subscriptions, and uses a private command environment', async () => {
    const fixture = new FixtureRunner('ready')
    const environments: IosCommandOptions[] = []
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        environments.push(options)
        return await fixture.run(command, args, options)
      },
    }
    const reported: unknown[] = []
    const manager = new IosEnvironmentManager({
      platform: 'darwin', runner, environment: {}, homeDirectory: '/private/dsh-home',
      reportError: error => reported.push(error),
    })
    manager.onChanged(() => { throw new Error('broken subscriber') })
    const survivor: PhoneIosState[] = []
    const remove = manager.onChanged(state => survivor.push(state))
    await manager.refresh()
    remove()
    await manager.refresh()
    expect(reported).toHaveLength(4)
    expect(survivor).toHaveLength(2)
    expect(environments[0]?.env).toEqual({
      HOME: '/private/dsh-home', PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    })
    expect(environments.some(options => options.env.DEVELOPER_DIR === '/Applications/Xcode.app/Contents/Developer')).toBe(true)

    const silent = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner('ready') })
    silent.onChanged(() => { throw new Error('ignored subscriber') })
    await expect(silent.refresh()).resolves.toMatchObject({ kind: 'ready' })
  })

  it('rejects an external non-Error cancellation and joins it during deactivate', async () => {
    const fixture = new FixtureRunner('runtime')
    let downloadStarted!: () => void
    const started = new Promise<void>((resolve) => { downloadStarted = resolve })
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command !== 'xcodebuild' || args[0] !== '-downloadPlatform') return await fixture.run(command, args, options)
        downloadStarted()
        return await new Promise<IosCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const reason: unknown = 'external stop'
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise arbitrary command rejection normalization
            reject(reason)
          }, { once: true })
        })
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    const controller = new AbortController()
    const preparing = manager.prepare(controller.signal)
    await started
    controller.abort('owner stopped')
    await expect(preparing).rejects.toMatchObject({ code: 'PHONE_IOS_ABORTED' })
    await expect(manager.deactivate()).resolves.toBeUndefined()
  })

  it('deactivate cancels and joins an active operation', async () => {
    const fixture = new FixtureRunner('runtime')
    let downloadStarted!: () => void
    const started = new Promise<void>((resolve) => { downloadStarted = resolve })
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command !== 'xcodebuild' || args[0] !== '-downloadPlatform') return await fixture.run(command, args, options)
        downloadStarted()
        return await new Promise<IosCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => { reject(abortReason(options.signal)) }, { once: true })
        })
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    const preparing = manager.prepare()
    await started
    await expect(manager.deactivate()).resolves.toBeUndefined()
    await expect(preparing).rejects.toMatchObject({ code: 'PHONE_IOS_ABORTED' })
  })

  it('surfaces shutdown failure when cancellation cleanup cannot stop the owned Simulator', async () => {
    const fixture = new FixtureRunner('no-simulator')
    let bootstatusStarted!: () => void
    const started = new Promise<void>((resolve) => { bootstatusStarted = resolve })
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command === 'xcrun' && args[1] === 'bootstatus') {
          bootstatusStarted()
          return await new Promise<IosCommandResult>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => { reject(abortReason(options.signal)) }, { once: true })
          })
        }
        if (command === 'xcrun' && args[1] === 'shutdown') return result(1, '', 'shutdown blocked')
        return await fixture.run(command, args, options)
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    const starting = manager.start()
    await started
    manager.cancel()
    await expect(starting).rejects.toMatchObject({ code: 'PHONE_IOS_SHUTDOWN' })
  })

  it('fails when a runtime download reports success without installing a runtime', async () => {
    const fixture = new FixtureRunner('runtime')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcodebuild' && args[0] === '-downloadPlatform'
        ? result(0)
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_RUNTIME_DOWNLOAD' })
  })

  it('fails if Xcode becomes unusable after a runtime download', async () => {
    const fixture = new FixtureRunner('runtime')
    let versionChecks = 0
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command === 'xcodebuild' && args[0] === '-version') {
          versionChecks += 1
          if (versionChecks > 1) return result(0, 'Build version only')
        }
        return await fixture.run(command, args, options)
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_STATE' })
  })

  it('rejects an invalid Simulator identifier returned by simctl create', async () => {
    const fixture = new FixtureRunner('no-simulator')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcrun' && args[1] === 'create'
        ? result(0, 'not-a-udid')
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_SIMULATOR_CREATE' })
  })

  it.each([
    ['xcode-missing', /Install or update/u],
    ['runtime', /Prepare an iOS Simulator runtime/u],
  ] as const)('requires preparation before start from %s', async (mode, message) => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner(mode) })
    await expect(manager.start()).rejects.toThrow(message)
  })

  it('does not boot an already running Simulator', async () => {
    const fixture = new FixtureRunner('ready')
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: fixture })
    await expect(manager.start()).resolves.toMatchObject({ kind: 'ready', running: true })
    expect(fixture.calls.some(call => call.args[1] === 'boot')).toBe(false)
  })

  it('preparing an existing Simulator does not create another one', async () => {
    const fixture = new FixtureRunner('ready')
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: fixture })
    await expect(manager.prepare()).resolves.toMatchObject({ kind: 'ready' })
    expect(fixture.calls.some(call => call.args[1] === 'create')).toBe(false)
  })

  it('reports failed boot exit facts with a bounded diagnostic tail', async () => {
    const fixture = new FixtureRunner('no-simulator')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcrun' && args[1] === 'boot'
        ? result(1, '', `prefix-${'x'.repeat(1_100)}`)
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    const failure = await manager.start().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'PHONE_IOS_SIMULATOR_BOOT' })
    expect((failure as Error).message).not.toContain('prefix-')
  })

  it('maps an invalid Xcode version response to the manual update state', async () => {
    const fixture = new FixtureRunner('ready')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcodebuild' && args[0] === '-version'
        ? result(0, 'Build version only')
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.refresh()).resolves.toMatchObject({ kind: 'manual-required', code: 'xcode-update' })
  })

  it.each([
    [new Error('runner exploded'), 'runner exploded'],
    ['non-error runner failure', 'non-error runner failure'],
  ])('normalizes a thrown command failure %#', async (failure, message) => {
    const runner: IosCommandRunner = { run: async () => { throw failure } }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.refresh()).rejects.toMatchObject({ code: 'PHONE_IOS_PREPARE', message })
  })

  it('rejects abnormal xcode-select termination facts', async () => {
    const runner: IosCommandRunner = { run: async () => ({ ...result(0), signal: 'SIGTERM' }) }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.refresh()).rejects.toMatchObject({ code: 'PHONE_IOS_XCODE_SELECT' })
  })

  it.each([
    ['runtimes', '{'],
    ['runtimes', '[]'],
    ['runtimes', '{}'],
    ['runtimes', '{"runtimes":[null]}'],
    ['runtimes', '{"runtimes":[{"identifier":"","name":"iOS 26","version":"26","isAvailable":true}]}'],
    ['runtimes', '{"runtimes":[{"identifier":"runtime","name":"iOS 26","version":"26","isAvailable":"yes"}]}'],
    ['devicetypes', '{}'],
    ['devicetypes', '{"devicetypes":[{"identifier":"type","name":""}]}'],
    ['devices available', '{"devices":[]}'],
    ['devices available', '{"devices":{"runtime":"not-an-array"}}'],
  ])('rejects malformed simctl %s output %#', async (subject, stdout) => {
    const fixture = new FixtureRunner('ready')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcrun' && args.join(' ').includes(`list ${subject}`)
        ? result(0, stdout)
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await expect(manager.refresh()).rejects.toMatchObject({ code: 'PHONE_IOS_PROTOCOL' })
  })

  it('does not clear newer Simulator ownership when an older shutdown settles', async () => {
    const fixture = new FixtureRunner('no-simulator')
    let firstShutdownStarted!: () => void
    const started = new Promise<void>((resolve) => { firstShutdownStarted = resolve })
    let finishFirstShutdown!: (value: IosCommandResult) => void
    const firstShutdown = new Promise<IosCommandResult>((resolve) => { finishFirstShutdown = resolve })
    const shutdownIds: string[] = []
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command === 'xcrun' && args[1] === 'shutdown') {
          shutdownIds.push(String(args[2]))
          if (shutdownIds.length === 1) {
            firstShutdownStarted()
            return await firstShutdown
          }
        }
        return await fixture.run(command, args, options)
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    await manager.start()
    const oldDevice = fixture.deviceIdentifier
    const stoppingOld = manager.deactivate()
    await started
    fixture.deviceIdentifier = '1A294A29-4C99-411F-A46D-0AD9499B7FEE'
    fixture.simulatorBooted = false
    await manager.start()
    finishFirstShutdown(result(0))
    await stoppingOld
    await manager.deactivate()
    expect(shutdownIds).toEqual([oldDevice, fixture.deviceIdentifier])
  })

  it('publishes a retryable failed state when the controlled runtime download fails', async () => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner('failed') })
    await manager.refresh()
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_RUNTIME_DOWNLOAD' })
    expect(manager.snapshot()).toMatchObject({
      kind: 'failed', code: 'PHONE_IOS_RUNTIME_DOWNLOAD', retryable: true,
    })
  })

  it.each([
    [{ code: 0, signal: 'SIGTERM', timedOut: false }, /SIGTERM/u],
    [{ code: 0, signal: null, timedOut: true }, /timed out/u],
    [{ code: 0, signal: null, timedOut: false, terminationError: 'termination facts failed' }, /termination facts failed/u],
  ] as const)('rejects contradictory successful download exit facts', async (facts, message) => {
    const fixture = new FixtureRunner('runtime')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcodebuild' && args[0] === '-downloadPlatform'
        ? { ...result(0), ...facts }
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.refresh()
    await expect(manager.prepare()).rejects.toThrow(message)
    expect(manager.snapshot()).toMatchObject({ kind: 'failed', code: 'PHONE_IOS_RUNTIME_DOWNLOAD' })
  })

  it('cancels the controlled download and restores the last actionable state', async () => {
    const fixture = new FixtureRunner('runtime')
    let downloadStarted!: () => void
    const started = new Promise<void>((resolve) => { downloadStarted = resolve })
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command !== 'xcodebuild' || args[0] !== '-downloadPlatform') {
          return await fixture.run(command, args, options)
        }
        downloadStarted()
        return await new Promise<IosCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => { reject(abortReason(options.signal)) }, { once: true })
        })
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.refresh()
    const preparing = manager.prepare()
    await started
    manager.cancel()
    await expect(preparing).rejects.toMatchObject({ code: 'PHONE_IOS_ABORTED' })
    expect(manager.snapshot()).toMatchObject({ kind: 'runtime-missing' })
  })

  it('joins cancellation during boot and shuts down the Simulator it started', async () => {
    const fixture = new FixtureRunner('no-simulator')
    let bootWaitStarted!: () => void
    const started = new Promise<void>((resolve) => { bootWaitStarted = resolve })
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command !== 'xcrun' || args[1] !== 'bootstatus') return await fixture.run(command, args, options)
        bootWaitStarted()
        return await new Promise<IosCommandResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => { reject(abortReason(options.signal)) }, { once: true })
        })
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    const preparing = manager.start()
    await started
    manager.cancel()
    await expect(preparing).rejects.toMatchObject({ code: 'PHONE_IOS_ABORTED' })
    expect(fixture.calls).toContainEqual({
      command: 'xcrun', args: ['simctl', 'shutdown', '8294A429-4C99-411F-A46D-0AD9499B7FDD'],
    })
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('retains Simulator ownership until a failed shutdown can be retried', async () => {
    const fixture = new FixtureRunner('no-simulator')
    let shutdowns = 0
    const runner: IosCommandRunner = {
      run: async (command, args, options) => {
        if (command !== 'xcrun' || args[1] !== 'shutdown') return await fixture.run(command, args, options)
        shutdowns += 1
        return shutdowns === 1 ? result(1, '', 'shutdown temporarily failed') : await fixture.run(command, args, options)
      },
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    await manager.start()
    await expect(manager.deactivate()).rejects.toMatchObject({ code: 'PHONE_IOS_SHUTDOWN' })
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: true })
    await expect(manager.deactivate()).resolves.toBeUndefined()
    expect(shutdowns).toBe(2)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: false })
  })

  it('does not take ownership when simctl reports that another owner already booted the Simulator', async () => {
    const fixture = new FixtureRunner('no-simulator')
    const runner: IosCommandRunner = {
      run: async (command, args, options) => command === 'xcrun' && args[1] === 'boot'
        ? result(149, '', 'Unable to boot device in current state: Booted')
        : await fixture.run(command, args, options),
    }
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner })
    await manager.prepare()
    await expect(manager.start()).resolves.toMatchObject({ kind: 'ready', running: true })
    await manager.deactivate()
    expect(fixture.calls.some(call => call.command === 'xcrun' && call.args[1] === 'shutdown')).toBe(false)
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: true })
  })

  it('preserves the running fact for a user-owned Simulator during deactivate', async () => {
    const fixture = new FixtureRunner('ready')
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: fixture })
    await manager.refresh()
    await manager.deactivate()
    expect(manager.snapshot()).toMatchObject({ kind: 'ready', running: true })
    expect(fixture.calls.some(call => call.command === 'xcrun' && call.args[1] === 'shutdown')).toBe(false)
  })
})
