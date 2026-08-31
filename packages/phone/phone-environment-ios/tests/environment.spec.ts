import { describe, expect, it } from 'vitest'
import { IosEnvironmentManager } from '../src/environment.ts'
import type { IosCommandOptions, IosCommandResult, IosCommandRunner } from '../src/process.ts'

type Call = { readonly command: string; readonly args: readonly string[] }

class FixtureRunner implements IosCommandRunner {
  readonly calls: Call[] = []
  runtimeInstalled = false
  simulatorCreated = false
  simulatorBooted = false

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
          udid: '8294A429-4C99-411F-A46D-0AD9499B7FDD', name: 'DSH Gestalt iPhone',
          state: this.simulatorBooted || this.mode === 'ready' ? 'Booted' : 'Shutdown', isAvailable: true,
        }] : [],
      } }))
    }
    if (command === 'xcrun' && args[1] === 'create') {
      this.simulatorCreated = true
      return result(0, '8294A429-4C99-411F-A46D-0AD9499B7FDD\n')
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

describe('iOS environment manager', () => {
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
      await expect(manager.prepare()).rejects.toMatchObject({ code: expect.stringMatching(/^PHONE_IOS_/u) })
      expect(runner.calls.some(call => call.args.includes('-downloadPlatform'))).toBe(false)
    }
  })

  it('publishes a retryable failed state when the controlled runtime download fails', async () => {
    const manager = new IosEnvironmentManager({ platform: 'darwin', runner: new FixtureRunner('failed') })
    await manager.refresh()
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'PHONE_IOS_RUNTIME_DOWNLOAD' })
    expect(manager.snapshot()).toMatchObject({
      kind: 'failed', code: 'PHONE_IOS_RUNTIME_DOWNLOAD', retryable: true,
    })
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
          options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
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
          options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
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
})
