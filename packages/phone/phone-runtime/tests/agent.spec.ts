import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId, FREE_SIGNING_PROFILE_REMINDER } from '@deepseek-ai/dsh-phone-runtime'
import type { Config } from '@deepseek-ai/dsh-phone-runtime'
import { PhoneDevicesError } from '../src/errors.ts'
import { runMobilecliAgent } from '../src/agent-process.ts'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { MobilecliProcessTree, MobilecliServerProcess } from '../src/server-process.ts'
import { stageFake, wireDevice } from './helpers.ts'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const contexts: CordisContext[] = []
const fakes: Array<Awaited<ReturnType<typeof stageFake>>> = []

afterEach(async () => {
  console.error('child diagnostics:', MobilecliServerProcess.diagnostics.splice(0))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

async function errorOf(run: () => Promise<unknown>): Promise<PhoneDevicesError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PhoneDevicesError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

const IOS_REAL = deviceId('REAL-UDID')
const ANDROID_EMULATOR = deviceId('emulator-5554')

const BASE_DEVICES = [
  wireDevice('emulator-5554', 'android', 'emulator', 'online'),
  wireDevice('REAL-UDID', 'ios', 'real', 'online'),
]

const FAST_CONFIG: Partial<Config> = {
  pollIntervalMs: 20,
  readyTimeoutMs: 6_000,
  requestTimeoutMs: 1_500,
  bootTimeoutMs: 2_000,
}

async function mountWith(fake: Awaited<ReturnType<typeof stageFake>>, overrides: Partial<Config> = {}): Promise<CordisContext> {
  await fake.claim()
  const context = new Context()
  contexts.push(context)
  await context.plugin(PhoneDevices, {
    ...FAST_CONFIG,
    executablePath: fake.executablePath,
    serverPort: fake.port,
    ...overrides,
  }).await()
  return context
}

describe('phone runtime on-device agent operations', () => {
  it('refuses agent operations for ids absent from the latest listing before any CLI spawn', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const unknown = await errorOf(() => context.phoneDevices.agentStatus(deviceId('UDID-nope')))
    expect(unknown.code).toBe('PHONE_DEVICE_NOT_FOUND')
    expect((await fake.agentState()).statusCount).toBe(0)
  })

  it('reports a missing agent and installs it idempotently', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })

    const before = await context.phoneDevices.agentStatus(IOS_REAL)
    expect(before.installed).toBe(false)
    expect(before.profileReminder).toBeUndefined()
    expect((await fake.agentState()).statusCount).toBe(1)

    const installed = await context.phoneDevices.installAgent(IOS_REAL)
    expect(installed.installed).toBe(true)
    expect(installed.reinstalled).toBe(false)
    expect(installed.version).toBe('0.0.0-test')
    expect((await fake.agentState()).installCount).toBe(1)

    // The second install answers from the status probe alone: no second spawn.
    const repeated = await context.phoneDevices.installAgent(IOS_REAL)
    expect(repeated.installed).toBe(true)
    expect(repeated.reinstalled).toBe(false)
    expect(repeated.profileReminder).toBe(FREE_SIGNING_PROFILE_REMINDER)
    const state = await fake.agentState()
    expect(state.installCount).toBe(1)
    // One explicit status call plus one probe per installAgent call.
    expect(state.statusCount).toBe(3)
  })

  it('accepts the pretty-printed missing-agent JSON emitted by mobilecli 1.0.5', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      agent: {
        statusAnswer: JSON.stringify({
          status: 'fail', data: { message: 'Agent is not installed on the device' },
        }, null, 2),
      },
    })
    fakes.push(fake)
    const context = await mountWith(fake)

    const status = await context.phoneDevices.agentStatus(IOS_REAL)

    expect(status.installed).toBe(false)
  })

  it('reinstalls on demand with force and passes the configured profile through', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await context.phoneDevices.installAgent(IOS_REAL)

    const reinstalled = await context.phoneDevices.installAgent(IOS_REAL, { force: true })
    expect(reinstalled.reinstalled).toBe(true)
    const state = await fake.agentState()
    expect(state.installCount).toBe(2)
    expect(state.lastInstallArgv).toContain('--force')
    expect(state.lastInstallArgv).toContain('--provisioning-profile')
  })

  it('answers agent status for any listed device without a local kind refusal', async () => {
    const fake = await stageFake({
      devices: BASE_DEVICES,
      agent: { installed: true },
    })
    fakes.push(fake)
    const context = await mountWith(fake)
    const android = await context.phoneDevices.agentStatus(ANDROID_EMULATOR)
    expect(android.installed).toBe(true)
    expect(android.bundleId).toBe('com.mobilenext.devicekit-iosUITests.xctrunner')
  })

  it('installs an agent on a non-real device without a provisioning profile', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)

    const installed = await context.phoneDevices.installAgent(ANDROID_EMULATOR)

    expect(installed.installed).toBe(true)
    expect((await fake.agentState()).lastInstallArgv).toEqual([
      'agent', 'install', '--device', 'emulator-5554',
    ])
  })

  it('attaches the free-signing reminder to answers about a re-signed real handset', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, agent: { installed: true } })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })

    const status = await context.phoneDevices.agentStatus(IOS_REAL)
    expect(status.profileReminder).toBe(FREE_SIGNING_PROFILE_REMINDER)
    const reinstalled = await context.phoneDevices.installAgent(IOS_REAL, { force: true })
    expect(reinstalled.profileReminder).toBe(FREE_SIGNING_PROFILE_REMINDER)
    expect((await fake.agentState()).lastInstallArgv).toEqual([
      'agent', 'install', '--device', 'REAL-UDID', '--force', '--provisioning-profile', fake.profilePath,
    ])
  })

  it('fails loudly at composition when the configured profile path is not a file', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    await fake.claim()
    const context = new Context()
    contexts.push(context)
    await expect(context.plugin(PhoneDevices, {
      ...FAST_CONFIG,
      executablePath: fake.executablePath,
      serverPort: fake.port,
      provisioningProfilePath: '/no-such-directory/profile.mobileprovision',
    }).await()).rejects.toThrow(/provisioningProfilePath/)
  })

  it('rejects a real-iOS install without a profile before spawning agent install', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const refused = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(refused.code).toBe('PHONE_AGENT_PROFILE_REQUIRED')
    expect(refused.message).toContain('provisioningProfilePath')
    expect(refused.issue).toBeUndefined()
    const state = await fake.agentState()
    expect(state.statusCount).toBe(1)
    expect(state.installCount).toBe(0)
  })
  it('classifies locked-device install failures onto the structured arm', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({ installText: 'the device is locked; unlock it and try again' })
    const locked = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(locked.code).toBe('PHONE_REAL_DEVICE_ISSUE')
    expect(locked.issue).toBe('device-locked')
  })

  it('classifies status failures against the same arms', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await fake.setAgent({ statusText: 'the device tunnel could not be established' })
    const tunneled = await errorOf(() => context.phoneDevices.agentStatus(IOS_REAL))
    expect(tunneled.code).toBe('PHONE_REAL_DEVICE_ISSUE')
    expect(tunneled.issue).toBe('tunnel-failed')
  })

  it('keeps an unclassified nonzero agent failure on PHONE_UPSTREAM', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await fake.setAgent({ statusText: 'upstream agent status failed without a known device arm' })

    const upstream = await errorOf(() => context.phoneDevices.agentStatus(IOS_REAL))

    expect(upstream.code).toBe('PHONE_UPSTREAM')
  })

  it('keeps a zero-exit answer without parsable agent JSON a protocol failure', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({ installAnswer: 'not json at all' })
    const protocol = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(protocol.code).toBe('PHONE_PROTOCOL')
  })

  it('recovers from a malformed JSON line when a later line answers', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({
      installAnswer: `{"status": broken\n${JSON.stringify({ status: 'ok', data: { message: 'Agent installed successfully', agent: { version: '0.0.0-test', bundleId: 'com.mobilenext.devicekit-iosUITests.xctrunner' } } })}`,
    })
    const installed = await context.phoneDevices.installAgent(IOS_REAL)
    expect(installed.installed).toBe(true)
    expect(installed.version).toBe('0.0.0-test')
  })

  it('maps an ok:false install answer onto PHONE_UPSTREAM', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({ installAnswer: JSON.stringify({ status: 'fail', data: { message: 'upstream refused' } }) })
    const refused = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(refused.code).toBe('PHONE_UPSTREAM')
    expect(refused.message).toContain('upstream refused')
  })

  it('reports a vanished executable as PHONE_UNAVAILABLE', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    await rename(fake.executablePath, `${fake.executablePath}.moved`)
    const vanished = await errorOf(() => context.phoneDevices.agentStatus(IOS_REAL))
    expect(vanished.code).toBe('PHONE_UNAVAILABLE')
    expect(vanished.message).toContain('could not start')
  })

  it('reports caller abort during a hung agent install as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, agent: { installDelayMs: 2_000 } })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 100)
    const cancelled = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL, { signal: controller.signal }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })

  it.skipIf(process.platform === 'win32')('cancels an official-style launcher and its native agent descendant', async () => {
    const fake = await stageFake({ agent: { statusDelayMs: 5_000 } })
    fakes.push(fake)
    const fixtureDir = dirname(fake.executablePath)
    const launcher = join(fixtureDir, 'mobilecli-agent-launcher')
    const descendantPidFile = join(fixtureDir, 'agent-descendant.pid')
    await writeFile(launcher, `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(${JSON.stringify(fake.executablePath)}, process.argv.slice(2), { stdio: 'inherit' })
writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid))
child.on('close', code => { process.exit(code ?? 1) })
`)
    await chmod(launcher, 0o755)
    const controller = new AbortController()
    const running = runMobilecliAgent({
      executablePath: launcher,
      args: ['agent', 'status', '--device', 'REAL-UDID'],
      signal: controller.signal,
      timeoutMs: 10_000,
    })
    await vi.waitFor(async () => {
      expect(Number(await readFile(descendantPidFile, 'utf8'))).toBeGreaterThan(0)
    })
    const descendantPid = Number(await readFile(descendantPidFile, 'utf8'))

    try {
      controller.abort()
      await expect(running).rejects.toMatchObject({ code: 'PHONE_ABORTED' })
      await vi.waitFor(() => {
        expect(() => { process.kill(descendantPid, 0) }).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      })
    } finally {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })

  it('escalates an ignored SIGTERM to the SIGKILL escape and still times out', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, agent: { installDelayMs: 5_000, ignoreTerm: true } })
    fakes.push(fake)
    const context = await mountWith(fake, { agentTimeoutMs: 300, provisioningProfilePath: fake.profilePath })
    const timedOut = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
  })

  it.each([
    new Error('tree cleanup refused'),
    'non-error tree cleanup refusal',
  ])('preserves timeout while surfacing process-tree cleanup failure (%s)', async (failure) => {
    const fake = await stageFake({ agent: { statusDelayMs: 5_000 } })
    fakes.push(fake)
    const descriptor = Object.getOwnPropertyDescriptor(MobilecliProcessTree.prototype, 'stop')
    if (typeof descriptor?.value !== 'function') throw new Error('process-tree stop method is unavailable')
    const originalStop = descriptor.value as (this: MobilecliProcessTree) => Promise<void>
    const stop = vi.spyOn(MobilecliProcessTree.prototype, 'stop').mockImplementation(async function (this: MobilecliProcessTree) {
      await originalStop.call(this)
      throw failure
    })
    try {
      const rejected = await errorOf(() => runMobilecliAgent({
        executablePath: fake.executablePath,
        args: ['agent', 'status', '--device', 'REAL-UDID'],
        signal: undefined,
        timeoutMs: 100,
      }))
      expect(rejected.code).toBe('PHONE_TIMEOUT')
      expect(rejected.message).toContain(failure instanceof Error ? failure.message : failure)
      expect(rejected.cause).toBeInstanceOf(AggregateError)
    } finally {
      stop.mockRestore()
    }
  })

  it('keeps an empty zero-exit answer a protocol failure naming the missing output', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({ installAnswer: '' })
    const protocol = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(protocol.code).toBe('PHONE_PROTOCOL')
    expect(protocol.message).toContain('(no output)')
  })

  it('scans backward past malformed and status-less lines to the answer', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake, { provisioningProfilePath: fake.profilePath })
    await fake.setAgent({
      // The backward scan meets the trailing malformed and status-less lines
      // before it reaches the answer on the first line.
      installAnswer: ['{"status":"ok"}', '{"nope":1}', '{"broken'].join('\n'),
    })
    const installed = await context.phoneDevices.installAgent(IOS_REAL)
    expect(installed.installed).toBe(true)
    expect(installed.version).toBeUndefined()
  })

  it('bounds a hung agent install with the configured agent ceiling', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES, agent: { installDelayMs: 6_000 } })
    fakes.push(fake)
    // Two seconds also absorbs a loaded host's node cold start, so the status
    // probe always clears its own ceiling and the install is what times out.
    const context = await mountWith(fake, { agentTimeoutMs: 2_000, provisioningProfilePath: fake.profilePath })
    const timedOut = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL))
    expect(timedOut.code).toBe('PHONE_TIMEOUT')
    expect(timedOut.message).toContain('agent install')
  })

  it('reports pre-aborted agent operations as PHONE_ABORTED', async () => {
    const fake = await stageFake({ devices: BASE_DEVICES })
    fakes.push(fake)
    const context = await mountWith(fake)
    const controller = new AbortController()
    controller.abort()
    const cancelled = await errorOf(() => context.phoneDevices.installAgent(IOS_REAL, { signal: controller.signal }))
    expect(cancelled.code).toBe('PHONE_ABORTED')
  })
})
