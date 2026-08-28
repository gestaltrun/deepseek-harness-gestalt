/**
 * The phone connection state machine on a fake stream gateway and a manual
 * scheduler: mint→socket-open→live, interruption→bounded auto-reconnect,
 * terminal error arms (device offline, unauthorized, refused), visible
 * suspend/resume, and the touch/keyboard io frames with their coordinates.
 */
import { describe, expect, it } from 'vitest'
import { PhoneConnectionController } from '../src/client/phone-connection.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import { FakeGateway, flush, ManualScheduler, SESSION_A } from './phone-fakes.client.ts'

function controllerOn(gateway: FakeGateway, scheduler: ManualScheduler): PhoneConnectionController {
  return new PhoneConnectionController({
    gateway,
    deviceId: 'emulator-5554',
    schedule: scheduler.schedule,
  })
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
      streamUrl: SESSION_A.mjpeg.url,
      format: 'mjpeg',
      expiresAt: SESSION_A.mjpeg.expiresAt,
    })
  })

  it('reconnects with a fresh session after a live socket drop', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    gateway.lastSocket!.drop()
    expect(controller.snapshot()).toEqual({ kind: 'reconnecting', attempt: 1, streamUrl: SESSION_A.mjpeg.url })
    scheduler.runNext()
    await flush()
    expect(gateway.mintedDevices).toHaveLength(2)
    expect(controller.snapshot()).toEqual({ kind: 'connecting' })
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
  })

  it('exhausts the bounded retries into the interrupted error arm', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      gateway.lastSocket!.drop()
      expect(controller.snapshot()).toEqual({
        kind: 'reconnecting', attempt, streamUrl: SESSION_A.mjpeg.url,
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

  it('reconnects when the visible live capture element fails', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteCaptureFailure()
    expect(controller.snapshot().kind).toBe('reconnecting')
    scheduler.runNext()
    await flush()
    gateway.lastSocket!.accept()
    expect(controller.snapshot().kind).toBe('live')
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
    expect(() => scheduler.runNext()).toThrow('no pending retry')
  })
})

describe('PhoneConnectionController io', () => {
  it('maps a normalized tap through the learned surface onto integer device coordinates', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    // No surface yet: the touch is dropped instead of guessing coordinates.
    expect(controller.tap(0.5, 0.25)).toBe(false)
    expect(gateway.lastSocket!.sent).toHaveLength(0)
    controller.noteSurface(360, 720)
    expect(controller.tap(0.5, 0.25)).toBe(true)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 180, y: 180 },
    })
  })

  it('maps a drag onto a pointerDown/move/up gesture action list', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteSurface(360, 720)
    expect(controller.swipe([{ u: 0, v: 0 }, { u: 0.5, v: 0.5 }, { u: 1, v: 1 }])).toBe(true)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [
          { type: 'pointerDown', x: 0, y: 0 },
          { type: 'pointerMove', x: 180, y: 360 },
          { type: 'pointerUp', x: 360, y: 720 },
        ],
      },
    })
  })

  it('sends keyboard input as text and toolbar actions as buttons', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = await connectToLive(gateway, scheduler)
    controller.noteSurface(360, 720)
    controller.text('验证码')
    controller.button('HOME')
    const [textFrame, buttonFrame] = gateway.lastSocket!.sent.map(frame => JSON.parse(frame))
    expect(textFrame).toEqual({
      jsonrpc: '2.0', id: 1, method: 'text', params: { deviceId: 'emulator-5554', text: '验证码' },
    })
    expect(buttonFrame).toEqual({
      jsonrpc: '2.0', id: 2, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' },
    })
  })

  it('drops touches unless the phase is live', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const controller = controllerOn(gateway, scheduler)
    controller.noteSurface(360, 720)
    expect(controller.tap(0.5, 0.5)).toBe(false)
    controller.connect()
    await flush()
    expect(controller.tap(0.5, 0.5)).toBe(false)
    expect(gateway.lastSocket!.sent).toHaveLength(0)
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
    expect(controller.snapshot().kind).toBe('live')
  })
})
