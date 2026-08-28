import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { DeviceId, PhoneDeviceList, PhoneIoRequest } from '@deepseek-ai/dsh-phone-runtime'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolPhone from '@deepseek-ai/dsh-tool-phone'
import * as ToolPhoneInvariant from '../src/invariant.ts'

const signal = new AbortController().signal
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const DEVICE_TOOLS = [
  'device_act',
  'device_close',
  'device_list',
  'device_observe',
  'device_open',
  'device_screenshot',
] as const

const ANDROID_ID = deviceId('emulator-5554')
const IOS_SIM_ID = deviceId('SIM-UDID')
const IOS_REAL_ID = deviceId('REAL-UDID')

const LISTING: PhoneDeviceList = Object.freeze({
  android: Object.freeze([{
    id: ANDROID_ID,
    name: 'Pixel_6',
    kind: 'emulator' as const,
    state: 'online',
    online: true,
    // Runtime listing refs carry the upstream platform (the public type omits
    // it), so the declared output schema must accept it.
    platform: 'android' as const,
  }]),
  ios: Object.freeze({
    simulators: Object.freeze([{
      id: IOS_SIM_ID,
      name: 'iPhone 16',
      kind: 'simulator' as const,
      state: 'shutdown',
      online: false,
      platform: 'ios' as const,
    }]),
    reals: Object.freeze([{
      id: IOS_REAL_ID,
      name: 'iPhone',
      kind: 'real' as const,
      state: 'online',
      online: true,
      platform: 'ios' as const,
    }]),
  }),
})

interface FakeFleet {
  boots: DeviceId[]
  shutdowns: DeviceId[]
  ioCalls: PhoneIoRequest[]
  screenshots: DeviceId[]
  listCalls: number
  listDevices(signal?: AbortSignal): Promise<PhoneDeviceList>
  boot(id: DeviceId, signal?: AbortSignal): Promise<void>
  shutdown(id: DeviceId, signal?: AbortSignal): Promise<void>
  io(request: PhoneIoRequest, signal?: AbortSignal): Promise<void>
  screenshot(id: DeviceId, signal?: AbortSignal): Promise<{ mediaType: 'image/png'; data: string }>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

function fakeFleet(listing: PhoneDeviceList = LISTING): FakeFleet {
  return {
    boots: [],
    shutdowns: [],
    ioCalls: [],
    screenshots: [],
    listCalls: 0,
    async listDevices() {
      this.listCalls += 1
      return listing
    },
    async boot(id) {
      this.boots.push(id)
    },
    async shutdown(id) {
      this.shutdowns.push(id)
    },
    async io(request) {
      this.ioCalls.push(request)
    },
    async screenshot(id) {
      this.screenshots.push(id)
      return { mediaType: 'image/png', data: PNG_1X1 }
    },
  }
}

async function harness(fleet: object = fakeFleet()): Promise<{ ctx: Context; fleet: object }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('phoneDevices', fleet as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536, maxResults: 10 } })
  await ctx.plugin(ToolPhone)
  return { ctx, fleet }
}

function fakeAgent(): Agent {
  return {
    session: { events: [{ type: 'turn/start' }], append: () => ({}) },
  } as unknown as Agent
}

describe('deferred phone device Consumer', () => {
  it('keeps device schemas out of the initial request until tool_search reconstructs them', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
    expect(ctx.tools.catalogSchemas().map(schema => schema.name).sort()).toEqual([...DEVICE_TOOLS])

    const session = Session.create(SessionId('phone-discovery'))
    const agent = { session } as Agent
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Find phone device tools.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect((await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(schema => schema.name))
      .toEqual(['tool_search'])

    const discovery = await ctx.tools.execute({
      callId: CallId('search-device'),
      name: 'tool_search',
      arguments: { query: 'device', limit: 8 },
      agent,
      signal,
    })
    expect(discovery.isError).toBe(false)
    if (discovery.isError) throw new Error('expected device tool discovery to succeed')
    expect(discovery.loadedTools?.map(schema => schema.name).sort()).toEqual([...DEVICE_TOOLS])
    for (const schema of discovery.loadedTools ?? []) {
      const serialized = JSON.stringify(schema.parameters)
      expect(serialized).not.toMatch(/adb|shell|exec/i)
    }

    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('search-device'),
        content: discovery.content,
        isError: false,
        loadedTools: discovery.loadedTools ?? [],
      }),
    }, { surfaceOp: 'append' })
    expect((await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(schema => schema.name).sort())
      .toEqual([...DEVICE_TOOLS, 'tool_search'])
  })

  it('lists, observes, and screenshots through the injected fleet without asking', async () => {
    const fleet = fakeFleet()
    const { ctx } = await harness(fleet)

    const listed = await ctx.tools.execute({
      callId: CallId('list'),
      name: 'device_list',
      arguments: {},
      signal,
    })
    expect(listed).toMatchObject({ isError: false, value: LISTING })
    expect(listed.content).toEqual([{
      type: 'text',
      text: JSON.stringify(LISTING, null, 2),
    }])

    const observed = await ctx.tools.execute({
      callId: CallId('observe'),
      name: 'device_observe',
      arguments: { deviceId: 'emulator-5554' },
      signal,
    })
    expect(observed).toMatchObject({
      isError: false,
      value: { id: 'emulator-5554', name: 'Pixel_6', kind: 'emulator', online: true, platform: 'android' },
    })

    const missing = await ctx.tools.execute({
      callId: CallId('observe-missing'),
      name: 'device_observe',
      arguments: { deviceId: 'no-such-device' },
      signal,
    })
    expect(missing).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_DEVICE_NOT_FOUND' } },
    })

    const shot = await ctx.tools.execute({
      callId: CallId('shot'),
      name: 'device_screenshot',
      arguments: { deviceId: 'emulator-5554' },
      signal,
    })
    expect(shot).toMatchObject({
      isError: false,
      value: { deviceId: 'emulator-5554', mediaType: 'image/png', data: PNG_1X1 },
    })
    expect(fleet.boots).toEqual([])
    expect(fleet.shutdowns).toEqual([])
    expect(fleet.ioCalls).toEqual([])
  })

  it('asks before a consequential act, runs once when allowed, and leaves the device untouched when rejected', async () => {
    const fleet = fakeFleet()
    const { ctx } = await harness(fleet)
    await ctx.plugin(ApprovalService)
    const agent = fakeAgent()
    const tap = {
      deviceId: 'emulator-5554',
      action: { kind: 'tap', x: 12, y: 40 },
    }

    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const opened = await ctx.tools.execute({
      callId: CallId('open-allow'),
      name: 'device_open',
      arguments: { deviceId: 'SIM-UDID' },
      agent,
      signal,
    })
    expect(opened).toMatchObject({ isError: false, value: { deviceId: 'SIM-UDID', status: 'ok' } })
    expect(fleet.boots).toEqual([IOS_SIM_ID])

    const allowed = await ctx.tools.execute({
      callId: CallId('act-allow'),
      name: 'device_act',
      arguments: tap,
      agent,
      signal,
    })
    expect(allowed).toMatchObject({
      isError: false,
      value: { deviceId: 'emulator-5554', action: { kind: 'tap', x: 12, y: 40 }, status: 'ok' },
    })
    expect(fleet.ioCalls).toEqual([{ deviceId: ANDROID_ID, method: 'tap', x: 12, y: 40 }])

    await expect(ctx.tools.execute({
      callId: CallId('act-swipe'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4 } },
      agent,
      signal,
    })).resolves.toMatchObject({ isError: false, value: { action: { kind: 'swipe' } } })
    await expect(ctx.tools.execute({
      callId: CallId('act-type'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'type', text: 'hello' } },
      agent,
      signal,
    })).resolves.toMatchObject({ isError: false, value: { action: { kind: 'type', text: 'hello' } } })
    await expect(ctx.tools.execute({
      callId: CallId('act-button'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'button', name: 'home' } },
      agent,
      signal,
    })).resolves.toMatchObject({ isError: false, value: { action: { kind: 'button', name: 'home' } } })
    expect(fleet.ioCalls).toEqual([
      { deviceId: ANDROID_ID, method: 'tap', x: 12, y: 40 },
      {
        deviceId: ANDROID_ID,
        method: 'gesture',
        actions: [
          { type: 'pointerDown', x: 1, y: 2 },
          { type: 'pointerMove', x: 3, y: 4 },
          { type: 'pointerUp' },
        ],
      },
      { deviceId: ANDROID_ID, method: 'text', text: 'hello' },
      { deviceId: ANDROID_ID, method: 'button', button: 'HOME' },
    ])

    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'), { prepend: true })
    const denied = await ctx.tools.execute({
      callId: CallId('act-deny'),
      name: 'device_act',
      arguments: tap,
      agent,
      signal,
    })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]).toMatchObject({ text: 'Error: the user rejected tool "device_act"' })
    expect(fleet.ioCalls).toHaveLength(4)

    const closed = await ctx.tools.execute({
      callId: CallId('close-deny'),
      name: 'device_close',
      arguments: { deviceId: 'SIM-UDID' },
      agent,
      signal,
    })
    expect(closed.isError).toBe(true)
    expect(fleet.shutdowns).toEqual([])

    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'), { prepend: true })
    const closedOk = await ctx.tools.execute({
      callId: CallId('close-allow'),
      name: 'device_close',
      arguments: { deviceId: 'SIM-UDID' },
      agent,
      signal,
    })
    expect(closedOk).toMatchObject({ isError: false, value: { deviceId: 'SIM-UDID', status: 'ok' } })
    expect(fleet.shutdowns).toEqual([IOS_SIM_ID])
  })

  it('asks before open and close, and surfaces structured fleet error codes', async () => {
    const fleet = {
      async listDevices() {
        throw new PhoneDevicesError('PHONE_UNAVAILABLE', 'the mobilecli server socket refused the listing')
      },
      async boot() {
        throw new PhoneDevicesError('PHONE_REAL_DEVICE', 'cannot boot a physical handset')
      },
      async shutdown() {
        throw new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', 'missing')
      },
    }
    const { ctx } = await harness(fleet)
    await ctx.plugin(ApprovalService)
    const agent = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    const listed = await ctx.tools.execute({
      callId: CallId('list-fail'),
      name: 'device_list',
      arguments: {},
      signal,
    })
    expect(listed).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_UNAVAILABLE' } },
    })

    const opened = await ctx.tools.execute({
      callId: CallId('open-fail'),
      name: 'device_open',
      arguments: { deviceId: 'REAL-UDID' },
      agent,
      signal,
    })
    expect(opened).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_REAL_DEVICE' } },
    })

    const closed = await ctx.tools.execute({
      callId: CallId('close-fail'),
      name: 'device_close',
      arguments: { deviceId: 'missing' },
      agent,
      signal,
    })
    expect(closed).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_DEVICE_NOT_FOUND' } },
    })
  })

  it('refuses screenshot and act when the injected fleet has no such operation', async () => {
    const { ctx } = await harness({
      async listDevices() { return LISTING },
      async boot() {},
      async shutdown() {},
    })
    await ctx.plugin(ApprovalService)
    const agent = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    const shot = await ctx.tools.execute({
      callId: CallId('shot-unsupported'),
      name: 'device_screenshot',
      arguments: { deviceId: 'emulator-5554' },
      signal,
    })
    expect(shot).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_UNSUPPORTED' } },
    })

    const acted = await ctx.tools.execute({
      callId: CallId('act-unsupported'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'button', name: 'home' } },
      agent,
      signal,
    })
    expect(acted).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_UNSUPPORTED' } },
    })
  })

  it('rejects blank ids, unknown act kinds, and empty typed text before touching the fleet', async () => {
    const fleet = fakeFleet()
    const { ctx } = await harness(fleet)
    await ctx.plugin(ApprovalService)
    const agent = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    await expect(ctx.tools.execute({
      callId: CallId('blank-id'),
      name: 'device_observe',
      arguments: { deviceId: '  ' },
      signal,
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_DEVICE_NOT_FOUND' } },
    })

    await expect(ctx.tools.execute({
      callId: CallId('empty-type'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'type', text: '   ' } },
      agent,
      signal,
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_UNSUPPORTED' } },
    })
    expect(fleet.ioCalls).toEqual([])
    expect(fleet.listCalls).toBe(0)
  })

  it('surfaces structured act and screenshot fleet errors after approval', async () => {
    const { ctx } = await harness({
      async listDevices() { return LISTING },
      async boot() {},
      async shutdown() {},
      async io() {
        throw new PhoneDevicesError('PHONE_TIMEOUT', 'the tap exceeded its ceiling')
      },
      async screenshot() {
        throw new PhoneDevicesError('PHONE_UPSTREAM', 'screenshot rejected upstream')
      },
    })
    await ctx.plugin(ApprovalService)
    const agent = fakeAgent()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    const acted = await ctx.tools.execute({
      callId: CallId('act-timeout'),
      name: 'device_act',
      arguments: { deviceId: 'emulator-5554', action: { kind: 'tap', x: 1, y: 2 } },
      agent,
      signal,
    })
    expect(acted).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_TIMEOUT' } },
    })

    const shot = await ctx.tools.execute({
      callId: CallId('shot-upstream'),
      name: 'device_screenshot',
      arguments: { deviceId: 'emulator-5554' },
      signal,
    })
    expect(shot).toMatchObject({
      isError: true,
      error: { info: { name: 'HarnessError', code: 'PHONE_UPSTREAM' } },
    })
  })

  it('lets a later pre-execute denial win after the default allow/ask listener', async () => {
    const fleet = fakeFleet()
    const { ctx } = await harness(fleet)
    ctx.on('tools/pre-execute', (): Promise<PreToolDecision> =>
      Promise.resolve({ kind: 'deny', reason: 'later deny' }))
    const listed = await ctx.tools.execute({
      callId: CallId('later-deny-list'),
      name: 'device_list',
      arguments: {},
      signal,
    })
    expect(listed.isError).toBe(true)
    expect(listed.content[0]).toMatchObject({ text: 'Error: later deny' })
    expect(fleet.listCalls).toBe(0)
  })

  it('lets a prior pre-execute denial win over the default ask', async () => {
    const fleet = fakeFleet()
    const { ctx } = await harness(fleet)
    ctx.on('tools/pre-execute', (): Promise<PreToolDecision> =>
      Promise.resolve({ kind: 'deny', reason: 'owner denied first' }), { prepend: true })
    const result = await ctx.tools.execute({
      callId: CallId('denied-open'),
      name: 'device_open',
      arguments: { deviceId: 'SIM-UDID' },
      signal,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: owner denied first' })
    expect(fleet.boots).toEqual([])
  })

  it('fails loud without deferred discovery and rolls back every partial registration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('phoneDevices', fakeFleet() as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: false })
    await expect(ctx.plugin(ToolPhone)).rejects.toThrow(/sets deferLoading but dsh-tools toolSearch is disabled/)
    expect(ctx.tools.catalogSchemas()).toEqual([])
  })

  it('removes every deferred phone definition when the Consumer fiber disposes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('phoneDevices', fakeFleet() as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })
    const fiber = await ctx.plugin(ToolPhone)
    expect(ctx.tools.catalogSchemas()).toHaveLength(6)
    await fiber.dispose()
    expect(ctx.tools.catalogSchemas()).toEqual([])
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
  })

  it('uses the direct-call timeout default and disposes its empty invariant companion', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('phoneDevices', fakeFleet() as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { toolSearch: { maxResultBytes: 65_536 } })
    ToolPhone.apply(ctx, {})
    expect(ctx.tools.catalogSchemas()).toHaveLength(6)
    expect(() => { ToolPhone.apply(new Context(), { timeoutMs: 0 }) }).toThrow(/positive safe integer/)
    expect(() => { ToolPhone.apply(new Context(), { timeoutMs: 1.5 }) }).toThrow(/positive safe integer/)

    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ToolPhoneInvariant)
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })

  it('keeps PhoneDevicesError codes on the HarnessError wrapper', () => {
    const wrapped = new HarnessError('lost', 'PHONE_UNAVAILABLE', {
      cause: new PhoneDevicesError('PHONE_UNAVAILABLE', 'lost'),
    })
    expect(wrapped).toBeInstanceOf(HarnessError)
    expect(wrapped.code).toBe('PHONE_UNAVAILABLE')
  })

  it('surfaces a plain fleet throw as an ordinary tool error', async () => {
    const { ctx } = await harness({
      async listDevices() { throw new Error('socket melted') },
      async boot() {},
      async shutdown() {},
    })
    const listed = await ctx.tools.execute({
      callId: CallId('plain-fail'),
      name: 'device_list',
      arguments: {},
      signal,
    })
    expect(listed.isError).toBe(true)
    expect(listed.content[0]).toMatchObject({ text: 'Error: socket melted' })
  })
})
