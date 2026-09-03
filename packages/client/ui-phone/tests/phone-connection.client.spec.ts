/**
 * The phone connection state machine on a fake stream gateway and a manual
 * scheduler: mint→socket-open→live, interruption→bounded auto-reconnect,
 * terminal error arms (device offline, unauthorized, refused), visible
 * suspend/resume, and the touch/keyboard io frames with their coordinates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneConnectionController } from '../src/client/phone-connection.ts'
import type { PhoneStreamGateway } from '../src/client/phone-connection.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import { FakeGateway, flush, ManualScheduler, SESSION_A } from './phone-fakes.client.ts'

function controllerOn(gateway: FakeGateway, scheduler: ManualScheduler): PhoneConnectionController {
  return new PhoneConnectionController({
    gateway,
    deviceId: 'emulator-5554',
    schedule: scheduler.schedule,
  })
}

afterEach(() => { vi.useRealTimers() })

function parseSentFrame(value: string): unknown {
  return JSON.parse(value)
}

/** Drive one full connect cycle to the live phase. */
async function connectToLive(gateway: FakeGateway, scheduler: ManualScheduler): Promise<PhoneConnectionController> {
  const controller = controllerOn(gateway, scheduler)
  controller.connect()
  await flush()
  gateway.lastSocket!.accept()
  return controller
}

describe('PhoneConnectionController lifecycle', () => {
  it('walks idle → connecting → live and exposes the signed stream URL', async () => {
    const gateway = new FakeGateway()
    const controller = controllerOn(gateway, new ManualScheduler())
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
    controller.connect()
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    expect(gateway.mintedDevices).toEqual(['emulator-5554'])
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot()).toEqual({
      kind: 'live',
      streamUrl: SESSION_A.h264.url,
      format: 'h264',
      expiresAt: SESSION_A.h264.expiresAt,
    })
  })

  it('starts directly on MJPEG when the Host marks AVC unsupported for the device', async () => {
    const gateway = new FakeGateway()
    gateway.queueMint({ session: { ...SESSION_A, preferredFormat: 'mjpeg' } })
    const controller = controllerOn(gateway, new ManualScheduler())
    controller.connect()
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot()).toEqual({
      kind: 'live',
      streamUrl: SESSION_A.mjpeg.url,
      format: 'mjpeg',
      expiresAt: SESSION_A.mjpeg.expiresAt,
    })
  })

  it('ignores duplicate connect requests and uses the default retry scheduler', async () => {
    vi.useFakeTimers()
    const gateway = new FakeGateway()
    const controller = new PhoneConnectionController({
      gateway,
      deviceId: 'emulator-5554',
      retryLimit: 1,
      retryBaseDelayMs: 5,
    })
    controller.connect()
    controller.connect()
    expect(gateway.mintedDevices).toEqual(['emulator-5554'])
    await vi.advanceTimersByTimeAsync(0)
    gateway.lastSocket!.accept()
    controller.connect()
    expect(gateway.mintedDevices).toHaveLength(1)

    gateway.lastSocket!.closeFromRemote()
    expect(controller.snapshot()).toEqual({ kind: 'reconnecting', attempt: 1, streamUrl: SESSION_A.h264.url })
    await vi.advanceTimersByTimeAsync(5)
    expect(gateway.mintedDevices).toHaveLength(2)
    controller.dispose()
  })

  it('cancels the default retry timer when the controller disposes', async () => {
    vi.useFakeTimers()
    const gateway = new FakeGateway()
    const controller = new PhoneConnectionController({
      gateway,
      deviceId: 'emulator-5554',
      retryBaseDelayMs: 5,
    })
    controller.connect()
    await vi.advanceTimersByTimeAsync(0)
    gateway.lastSocket!.accept()
    gateway.lastSocket!.closeFromRemote()
    controller.dispose()
    await vi.advanceTimersByTimeAsync(5)
    expect(gateway.mintedDevices).toEqual(['emulator-5554'])
  })

  it('reconnects with a fresh session after a live socket drop', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    gateway.lastSocket!.drop()
    expect(controller.snapshot()).toEqual({ kind: 'reconnecting', attempt: 1, streamUrl: SESSION_A.h264.url })
    scheduler.runNext()
    await flush()
    expect(gateway.mintedDevices).toHaveLength(2)
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
  })

  it('forgets the old coordinate surface until the reconnected stream paints a frame', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteSurface('h264', 360, 720)
    expect(controller.tap(0.5, 0.5)).toBe(true)

    gateway.lastSocket!.drop()
    scheduler.runNext()
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
    expect(controller.tap(0.5, 0.5)).toBe(false)
    expect(gateway.lastSocket!.sent).toEqual([])

    controller.noteSurface('h264', 390, 844)
    expect(controller.tap(0.5, 0.5)).toBe(true)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toMatchObject({
      method: 'tap',
      params: { x: 195, y: 422 },
    })
  })

  it('exhausts the bounded retries into the interrupted error arm', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      gateway.lastSocket!.drop()
      expect(controller.snapshot()).toEqual({
        kind: 'reconnecting', attempt, streamUrl: SESSION_A.h264.url,
      })
      scheduler.runNext()
      await flush()
      gateway.lastSocket!.accept()
      expect(controller.snapshot().kind).toBe('live')
    }
    // The retry budget is spent: the next interruption is terminal.
    gateway.lastSocket!.drop()
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'interrupted' } })
    expect(scheduler.scheduledCount).toBe(3)
    // A stale close after the terminal error must not restart the loop.
    gateway.lastSocket!.drop()
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'interrupted' } })
  })

  it('survives a mint failure racing a suspend', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    gateway.queueMint({ error: new TypeError('network down') })
    const controller = controllerOn(gateway, scheduler)
    controller.connect()
    controller.setVisible(false)
    expect(controller.snapshot()).toEqual({ kind: 'suspended' })
    expect(scheduler.scheduledCount).toBe(0)
    // Flush the in-flight mint rejection: the suspended epoch must drop it.
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'suspended' })
  })

  it('drops a successful mint continuation after an explicit disconnect', async () => {
    let resolveMint!: (session: typeof SESSION_A) => void
    const pending = new Promise<typeof SESSION_A>((resolve) => { resolveMint = resolve })
    let socketAttempts = 0
    const gateway: PhoneStreamGateway = {
      mintSession: () => pending,
      agentStatus: async () => ({ deviceId: 'emulator-5554', installed: true }),
      installAgent: async () => ({ deviceId: 'emulator-5554', installed: true }),
      connectIo: () => {
        socketAttempts += 1
        throw new Error('a stale mint must not open io')
      },
    }
    const controller = new PhoneConnectionController({ gateway, deviceId: 'emulator-5554' })
    controller.connect()
    controller.disconnect()
    resolveMint(SESSION_A)
    await Promise.resolve()
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
    expect(socketAttempts).toBe(0)
  })

  it('maps mint status codes onto the terminal error arms', async () => {
    const cases: readonly {
      readonly name: string
      readonly error: unknown
      readonly failure: object
    }[] = [
      {
        name: 'device removed from the listing (404)',
        error: new PhoneStreamHttpError(404, 'not-found', 'absent from the latest device listing'),
        failure: { kind: 'device-offline' },
      },
      {
        name: 'real-device debugging unauthorized (upstream message)',
        error: new PhoneStreamHttpError(502, 'upstream', 'device unauthorized: allow USB debugging'),
        failure: { kind: 'unauthorized' },
      },
      {
        name: 'session refused by the trust fence (403)',
        error: new PhoneStreamHttpError(403, 'forbidden', 'forbidden'),
        failure: { kind: 'refused' },
      },
      {
        name: 'iOS real-device agent is missing',
        error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent is missing'),
        failure: { kind: 'agent-missing', agentRecovery: 'install' },
      },
      {
        name: 'Android rejected USB agent installation',
        error: new PhoneStreamHttpError(
          502, 'PHONE_UPSTREAM', 'adb install failed: INSTALL_FAILED_USER_RESTRICTED',
        ),
        failure: { kind: 'agent-install-restricted', agentRecovery: 'install' },
      },
      {
        name: 'iPhone is locked',
        error: new PhoneStreamHttpError(
          502, 'PHONE_REAL_DEVICE_ISSUE', 'unlock the device', 'device-locked',
        ),
        failure: { kind: 'device-locked' },
      },
      {
        name: 'Host has no provisioning profile',
        error: new PhoneStreamHttpError(
          409, 'PHONE_AGENT_PROFILE_REQUIRED', 'configure a provisioning profile',
        ),
        failure: { kind: 'agent-profile-required' },
      },
      {
        name: 'free profile expired',
        error: new PhoneStreamHttpError(
          502, 'PHONE_REAL_DEVICE_ISSUE', 'profile expired', 'profile-expired',
        ),
        failure: { kind: 'profile-expired', agentRecovery: 'reinstall' },
      },
    ]
    for (const testCase of cases) {
      const gateway = new FakeGateway()
      gateway.queueMint({ error: testCase.error })
      const scheduler = new ManualScheduler()
      const controller = controllerOn(gateway, scheduler)
      controller.connect()
      await flush()
      expect(controller.snapshot()).toEqual({ kind: 'error', failure: testCase.failure })
      expect(scheduler.scheduledCount).toBe(0)
    }
  })

  it('installs a missing iOS real-device agent and reconnects into GUI control', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    gateway.queueMint({ error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent is missing') })
    gateway.queueMint({ session: {
      ...SESSION_A,
      deviceId: 'UDID-9',
      agentManaged: true,
    } })
    const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9', schedule: scheduler.schedule })
    controller.connect()
    await flush()
    expect(controller.snapshot()).toEqual({
      kind: 'error', failure: { kind: 'agent-missing', agentRecovery: 'install' },
    })

    controller.recoverAgent(false)
    expect(controller.snapshot()).toEqual({ kind: 'repairing-agent', force: false })
    await flush()
    gateway.lastSocket!.accept()
    controller.noteSurface('h264', 390, 844)
    expect(controller.button('HOME')).toBe(true)
    expect(gateway.agentInstallCalls).toEqual([{ deviceId: 'UDID-9', force: false }])
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toMatchObject({
      method: 'button', params: { deviceId: 'UDID-9', button: 'HOME' },
    })
  })

  it('keeps agent recovery within an error generation and preserves a failed install result', async () => {
    const gateway = new FakeGateway()
    const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9' })
    controller.recoverAgent(false)
    expect(gateway.agentInstallCalls).toEqual([])

    gateway.queueMint({ error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent missing') })
    gateway.queueAgentInstall({ installed: false })
    controller.connect()
    await flush()
    controller.recoverAgent(false)
    await flush()
    expect(controller.snapshot()).toEqual({
      kind: 'error', failure: { kind: 'agent-missing', agentRecovery: 'install' },
    })

    gateway.queueAgentInstall({
      error: new PhoneStreamHttpError(409, 'PHONE_AGENT_PROFILE_REQUIRED', 'configure profile'),
    })
    controller.recoverAgent(false)
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'agent-profile-required' } })
  })

  it('drops stale agent install success and failure after disconnect', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const gateway = new FakeGateway()
      gateway.queueMint({ error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent missing') })
      const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9' })
      controller.connect()
      await flush()
      const pending = Promise.withResolvers<{ readonly deviceId: string; readonly installed: boolean }>()
      vi.spyOn(gateway, 'installAgent').mockReturnValue(pending.promise)
      controller.recoverAgent(false)
      controller.disconnect()
      if (outcome === 'success') pending.resolve({ deviceId: 'UDID-9', installed: true })
      else pending.reject(new Error('late install failure'))
      await flush()
      expect(controller.snapshot()).toEqual({ kind: 'idle' })
    }
  })

  it('re-checks the agent after a managed real-device picture exhausts retries', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const managed = { ...SESSION_A, deviceId: 'UDID-9', agentManaged: true }
    for (let attempt = 0; attempt < 4; attempt += 1) gateway.queueMint({ session: managed })
    gateway.queueAgentStatus({
      error: new PhoneStreamHttpError(
        502, 'PHONE_REAL_DEVICE_ISSUE', 'device tunnel failed', 'tunnel-failed',
      ),
    })
    const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9', schedule: scheduler.schedule })
    controller.connect()
    await flush()
    gateway.lastSocket!.accept()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      gateway.lastSocket!.drop()
      scheduler.runNext()
      await flush()
      gateway.lastSocket!.accept()
    }
    gateway.lastSocket!.drop()
    expect(controller.snapshot()).toEqual({ kind: 'checking-agent' })
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'tunnel-failed' } })
    expect(gateway.agentStatusDevices).toEqual(['UDID-9'])
  })

  it('checks the managed Android agent immediately after a real io rejection', async () => {
    const gateway = new FakeGateway()
    gateway.queueMint({ session: { ...SESSION_A, agentManaged: true } })
    gateway.queueAgentStatus({ installed: false })
    const controller = controllerOn(gateway, new ManualScheduler())
    controller.connect()
    await flush()
    gateway.lastSocket!.accept()
    gateway.lastSocket!.receive(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'input command failed' },
    }))
    expect(controller.snapshot()).toEqual({ kind: 'checking-agent' })
    await flush()
    expect(controller.snapshot()).toEqual({
      kind: 'error', failure: { kind: 'agent-missing', agentRecovery: 'install' },
    })
    expect(gateway.agentStatusDevices).toEqual(['emulator-5554'])
  })

  it('offers install or reinstall after a managed picture failure based on agent status', async () => {
    for (const installed of [false, true]) {
      const gateway = new FakeGateway()
      const scheduler = new ManualScheduler()
      const managed = { ...SESSION_A, deviceId: 'UDID-9', agentManaged: true }
      for (let attempt = 0; attempt < 4; attempt += 1) gateway.queueMint({ session: managed })
      gateway.queueAgentStatus({ installed })
      const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9', schedule: scheduler.schedule })
      controller.connect()
      await flush()
      gateway.lastSocket!.accept()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        gateway.lastSocket!.drop()
        scheduler.runNext()
        await flush()
        gateway.lastSocket!.accept()
      }
      gateway.lastSocket!.drop()
      await flush()
      expect(controller.snapshot()).toEqual({
        kind: 'error',
        failure: installed
          ? { kind: 'interrupted', agentRecovery: 'reinstall' }
          : { kind: 'agent-missing', agentRecovery: 'install' },
      })
    }
  })

  it('drops stale agent status success and failure after disconnect', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const gateway = new FakeGateway()
      const scheduler = new ManualScheduler()
      const managed = { ...SESSION_A, deviceId: 'UDID-9', agentManaged: true }
      for (let attempt = 0; attempt < 4; attempt += 1) gateway.queueMint({ session: managed })
      const pending = Promise.withResolvers<{ readonly deviceId: string; readonly installed: boolean }>()
      vi.spyOn(gateway, 'agentStatus').mockReturnValue(pending.promise)
      const controller = new PhoneConnectionController({ gateway, deviceId: 'UDID-9', schedule: scheduler.schedule })
      controller.connect()
      await flush()
      gateway.lastSocket!.accept()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        gateway.lastSocket!.drop()
        scheduler.runNext()
        await flush()
        gateway.lastSocket!.accept()
      }
      gateway.lastSocket!.drop()
      expect(controller.snapshot()).toEqual({ kind: 'checking-agent' })
      controller.disconnect()
      if (outcome === 'success') pending.resolve({ deviceId: 'UDID-9', installed: true })
      else pending.reject(new Error('late status failure'))
      await flush()
      expect(controller.snapshot()).toEqual({ kind: 'idle' })
    }
  })

  it('classifies a non-authorization upstream failure as unavailable', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    gateway.queueMint({ error: new PhoneStreamHttpError(502, 'upstream', 'upstream unavailable') })
    const controller = controllerOn(gateway, scheduler)
    controller.connect()
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'reconnecting', attempt: 1 })
  })

  it('exhausts transient mint failures into the unavailable error arm', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    // Initial mint plus the three scheduled retries: four transient rounds.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      gateway.queueMint({ error: new TypeError('network down') })
    }
    const controller = controllerOn(gateway, scheduler)
    controller.connect()
    await flush()
    scheduler.runNext()
    await flush()
    scheduler.runNext()
    await flush()
    scheduler.runNext()
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'unavailable' } })
  })

  it('suspends pulling while hidden and reconnects on re-show', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.setVisible(false)
    expect(controller.snapshot()).toEqual({ kind: 'suspended' })
    // The controller-initiated close must not trigger the reconnect loop.
    expect(scheduler.scheduledCount).toBe(0)
    controller.setVisible(true)
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
  })

  it('keeps a terminal error visible while the tab hides', async () => {
    const gateway = new FakeGateway()
    gateway.queueMint({ error: new PhoneStreamHttpError(404, 'not-found', 'gone') })
    const controller = controllerOn(gateway, new ManualScheduler())
    controller.connect()
    await flush()
    controller.setVisible(false)
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'device-offline' } })
  })

  it('ignores capture failures before a stream is live', () => {
    const controller = controllerOn(new FakeGateway(), new ManualScheduler())
    controller.noteCaptureFailure('h264')
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
  })

  it('reconnects when the visible live capture element fails', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteCaptureFailure('h264')
    controller.noteCaptureFailure('mjpeg')
    expect(controller.snapshot().kind).toBe('reconnecting')
    scheduler.runNext()
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
  })

  it('falls back from H264 to the same session MJPEG URL before spending a reconnect', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    const socket = gateway.lastSocket

    controller.noteCaptureFailure('h264')

    expect(controller.snapshot()).toEqual({
      kind: 'live',
      streamUrl: SESSION_A.mjpeg.url,
      format: 'mjpeg',
      expiresAt: SESSION_A.mjpeg.expiresAt,
    })
    expect(gateway.mintedDevices).toEqual(['emulator-5554'])
    expect(gateway.lastSocket).toBe(socket)
    expect(scheduler.scheduledCount).toBe(0)
  })

  it('uses the existing bounded retry only after the MJPEG fallback fails', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteCaptureFailure('h264')
    controller.noteCaptureFailure('mjpeg')
    expect(controller.snapshot()).toEqual({
      kind: 'reconnecting', attempt: 1, streamUrl: SESSION_A.mjpeg.url,
    })
    expect(scheduler.scheduledCount).toBe(1)
  })

  it('ignores a stale capture callback from the encoding already replaced', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    controller.noteCaptureFailure('h264')
    controller.noteCaptureFailure('h264')
    expect(controller.snapshot()).toMatchObject({ kind: 'live', format: 'mjpeg' })
  })

  it('disconnects to idle and refresh starts a brand-new cycle', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.disconnect()
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
    controller.refresh()
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    expect(gateway.mintedDevices).toHaveLength(2)
  })

  it('drops stale socket callbacks after refresh replaces the generation', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    const stale = gateway.lastSocket!
    controller.refresh()
    stale.accept()
    stale.fail()
    stale.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32010 } }))
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
  })

  it('notifies subscribers on every phase change until unsubscribed', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = controllerOn(gateway, scheduler)
    const phases: string[] = []
    const unsubscribe = controller.subscribe(() => { phases.push(controller.snapshot().kind) })
    controller.connect()
    await flush()
    gateway.lastSocket!.accept()
    controller.disconnect()
    unsubscribe()
    controller.connect()
    expect(phases).toEqual(['connecting', 'live', 'idle'])
  })

  it('stops every timer and socket on dispose', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    gateway.lastSocket!.drop()
    controller.dispose()
    expect(controller.snapshot()).toEqual({ kind: 'idle' })
    expect(() => { scheduler.runNext() }).toThrow('no pending retry')
  })
})

describe('PhoneConnectionController io', () => {
  it('keeps the last valid surface when an invalid size is reported', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    controller.noteSurface('h264', 360, 720)
    controller.noteSurface('h264', Number.NaN, 720)
    controller.noteSurface('h264', 360, Number.POSITIVE_INFINITY)
    controller.noteSurface('h264', 0, 720)
    controller.noteSurface('h264', 360, -1)
    expect(controller.tap(0.5, 0.5)).toBe(true)
    expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toMatchObject({
      method: 'tap', params: { x: 180, y: 360 },
    })
  })

  it('drops swipes until a surface exists and drops an empty path afterward', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    expect(controller.swipe([{ u: 0, v: 0 }])).toBe(false)
    controller.noteSurface('h264', 360, 720)
    expect(controller.swipe([])).toBe(false)
    expect(gateway.lastSocket!.sent).toEqual([])
  })

  it('maps a normalized tap through the learned surface onto integer device coordinates', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    // No surface yet: the touch is dropped instead of guessing coordinates.
    expect(controller.tap(0.5, 0.25)).toBe(false)
    expect(gateway.lastSocket!.sent).toHaveLength(0)
    controller.noteSurface('h264', 360, 720)
    expect(controller.tap(0.5, 0.25)).toBe(true)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 180, y: 180 },
    })
  })

  it('uses MJPEG natural dimensions after fallback and ignores stale H264 dimensions', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    controller.noteCaptureFailure('h264')
    controller.noteSurface('h264', 390, 844)
    expect(controller.tap(0.5, 0.5)).toBe(false)
    controller.noteSurface('mjpeg', 1080, 2400)
    expect(controller.tap(0.5, 0.5)).toBe(true)
    expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toMatchObject({
      method: 'tap', params: { x: 540, y: 1200 },
    })
  })

  it('maps a drag onto the WDA positioning, destination move, and travel pause list', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteSurface('h264', 360, 720)
    expect(controller.swipe([{ u: 0, v: 0 }, { u: 0.5, v: 0.5 }, { u: 1, v: 1 }])).toBe(true)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [
          { type: 'pointerMove', x: 0, y: 0 },
          { type: 'pointerDown' },
          { type: 'pointerMove', x: 360, y: 720 },
          { type: 'pause', duration: 150 },
          { type: 'pointerUp' },
        ],
      },
    })
  })

  it('sends keyboard input as text and toolbar actions as buttons', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteSurface('h264', 360, 720)
    controller.text('验证码')
    controller.button('HOME')
    const [textFrame, buttonFrame] = gateway.lastSocket!.sent.map(parseSentFrame)
    expect(textFrame).toEqual({
      jsonrpc: '2.0', id: 1, method: 'text', params: { deviceId: 'emulator-5554', text: '验证码' },
    })
    expect(buttonFrame).toEqual({
      jsonrpc: '2.0', id: 2, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' },
    })
    expect(controller.text('')).toBe(false)
  })

  it('drops touches unless the phase is live', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = controllerOn(gateway, scheduler)
    controller.noteSurface('h264', 360, 720)
    expect(controller.tap(0.5, 0.5)).toBe(false)
    controller.connect()
    await flush()
    expect(controller.tap(0.5, 0.5)).toBe(false)
    expect(gateway.lastSocket!.sent).toHaveLength(0)
  })

  it('drops io after both capture formats move a surfaced connection into retry', async () => {
    const gateway = new FakeGateway()
    const controller = await connectToLive(gateway, new ManualScheduler())
    controller.noteSurface('h264', 360, 720)
    controller.noteCaptureFailure('h264')
    controller.noteSurface('mjpeg', 360, 720)
    controller.noteCaptureFailure('mjpeg')
    expect(controller.snapshot().kind).toBe('reconnecting')
    expect(controller.button('HOME')).toBe(false)
    expect(gateway.lastSocket!.sent).toEqual([])
  })

  it('moves to the offline error arm when the device stops answering io', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.tap(0.5, 0.5)
    gateway.lastSocket!.receive(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'PHONE_DEVICE_NOT_FOUND' },
    }))
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'device-offline' } })
  })

  it('moves to the unauthorized error arm on an upstream authorization failure', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    gateway.lastSocket!.receive(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'device unauthorized: allow USB debugging' },
    }))
    expect(controller.snapshot()).toEqual({ kind: 'error', failure: { kind: 'unauthorized' } })
  })

  it('keeps living through malformed frames and successful replies', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    gateway.lastSocket!.receive('not json')
    gateway.lastSocket!.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } }))
    gateway.lastSocket!.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000 } }))
    gateway.lastSocket!.receive(JSON.stringify({
      jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'upstream rejected input' },
    }))
    expect(controller.snapshot().kind).toBe('live')
  })
})
