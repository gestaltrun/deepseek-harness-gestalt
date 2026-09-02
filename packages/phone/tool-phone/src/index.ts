/** Deferred model-facing Consumer of the phone device fleet. @module @deepseek-ai/dsh-tool-phone */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { deviceId, PhoneDevicesError, phoneSwipeActions } from '@deepseek-ai/dsh-phone-runtime'
import type { DeviceId, PhoneDeviceList, PhoneDeviceRef, PhoneIoRequest } from '@deepseek-ai/dsh-phone-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-phone'
/** Phone fleet Service and tool registry required by this Consumer. */
export const inject = ['phoneDevices', 'tools']

/** Consequential tools that default to `tools/pre-execute` ask. */
const ASK_TOOLS: ReadonlySet<string> = new Set(['device_act', 'device_open', 'device_close'])

/** Hardware buttons accepted by `device_act`. */
const BUTTON_NAMES = ['home', 'back', 'recents', 'power', 'volume_up', 'volume_down'] as const

/** Model-facing Consumer configuration. */
export interface Config {
  /** Cooperative timeout budget in milliseconds for each fleet call. */
  readonly timeoutMs?: number
}

/** Runtime configuration schema for the phone tool Consumer. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
})

const DEVICE_ID_PARAMETER = {
  type: 'string' as const,
  required: true as const,
  description: 'Android serial or iOS UDID returned by device_list.',
}

const DEVICE_REF_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true as const },
    name: { type: 'string' as const, required: true as const },
    kind: { type: 'string' as const, required: true as const, enum: ['emulator', 'simulator', 'real'] },
    state: { type: 'string' as const, required: true as const },
    online: { type: 'boolean' as const, required: true as const },
    // Runtime listing refs carry the upstream platform even though the public
    // PhoneDeviceRef type omits it, so the declared output must accept it.
    platform: { type: 'string' as const, required: true as const, enum: ['ios', 'android'] },
  },
} as const

const DEVICE_LIST_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    android: { type: 'array' as const, required: true as const, items: DEVICE_REF_SCHEMA },
    ios: {
      type: 'object' as const,
      required: true as const,
      additionalProperties: false,
      properties: {
        simulators: { type: 'array' as const, required: true as const, items: DEVICE_REF_SCHEMA },
        reals: { type: 'array' as const, required: true as const, items: DEVICE_REF_SCHEMA },
      },
    },
  },
} as const

const OBSERVE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ...DEVICE_REF_SCHEMA.properties,
    platform: { type: 'string' as const, required: true as const, enum: ['android', 'ios'] },
  },
} as const

const MUTATION_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' as const, required: true as const },
    status: { type: 'string' as const, required: true as const, const: 'ok' },
  },
} as const

const TAP_ACTION = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'tap' },
    x: { type: 'integer' as const, required: true as const, description: 'Horizontal pixel coordinate.' },
    y: { type: 'integer' as const, required: true as const, description: 'Vertical pixel coordinate.' },
  },
} as const

const SWIPE_ACTION = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'swipe' },
    x1: { type: 'integer' as const, required: true as const, description: 'Start horizontal pixel coordinate.' },
    y1: { type: 'integer' as const, required: true as const, description: 'Start vertical pixel coordinate.' },
    x2: { type: 'integer' as const, required: true as const, description: 'End horizontal pixel coordinate.' },
    y2: { type: 'integer' as const, required: true as const, description: 'End vertical pixel coordinate.' },
  },
} as const

const TYPE_ACTION = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'type' },
    text: { type: 'string' as const, required: true as const, description: 'Non-empty text to type.' },
  },
} as const

const BUTTON_ACTION = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true as const, const: 'button' },
    name: {
      type: 'string' as const,
      required: true as const,
      enum: [...BUTTON_NAMES],
      description: 'Hardware button to press.',
    },
  },
} as const

const ACT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' as const, required: true as const },
    action: { oneOf: [TAP_ACTION, SWIPE_ACTION, TYPE_ACTION, BUTTON_ACTION], required: true as const },
    status: { type: 'string' as const, required: true as const, const: 'ok' },
  },
} as const

const SCREENSHOT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' as const, required: true as const },
    mediaType: { type: 'string' as const, required: true as const, const: 'image/png' },
    data: { type: 'string' as const, required: true as const },
  },
} as const

interface ObservedDevice extends PhoneDeviceRef {
  readonly platform: 'android' | 'ios'
}

interface DeviceActionTap {
  readonly kind: 'tap'
  readonly x: number
  readonly y: number
}

interface DeviceActionSwipe {
  readonly kind: 'swipe'
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

interface DeviceActionType {
  readonly kind: 'type'
  readonly text: string
}

interface DeviceActionButton {
  readonly kind: 'button'
  readonly name: (typeof BUTTON_NAMES)[number]
}

type DeviceAction = DeviceActionTap | DeviceActionSwipe | DeviceActionType | DeviceActionButton

interface PhoneFleet {
  listDevices(signal?: AbortSignal): Promise<PhoneDeviceList>
  boot(id: DeviceId, signal?: AbortSignal): Promise<void>
  shutdown(id: DeviceId, signal?: AbortSignal): Promise<void>
  io?(request: PhoneIoRequest, signal?: AbortSignal): Promise<void>
  screenshot?(id: DeviceId, signal?: AbortSignal): Promise<{ readonly mediaType: 'image/png'; readonly data: string }>
  isReady?(): boolean
  onReadinessChanged?(listener: (ready: boolean) => void): () => void
}

/** Complete phone facts are rendered into the durable ordinary tool result. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Brand a non-empty device id from model JSON.
 * @param raw - Model-supplied identifier.
 * @returns the branded fleet id.
 */
function requireDeviceId(raw: string): DeviceId {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new HarnessError('deviceId must be a non-empty Android serial or iOS UDID', 'PHONE_DEVICE_NOT_FOUND')
  }
  return deviceId(trimmed)
}

/** Flatten one grouped listing into observed entries carrying their platform. */
function allRefs(list: PhoneDeviceList): readonly ObservedDevice[] {
  return [
    ...list.android.map(device => ({ ...device, platform: 'android' as const })),
    ...list.ios.simulators.map(device => ({ ...device, platform: 'ios' as const })),
    ...list.ios.reals.map(device => ({ ...device, platform: 'ios' as const })),
  ]
}

/**
 * Locate one device in a listing.
 * @param list - Latest grouped fleet listing.
 * @param id - Branded device id.
 * @returns the matching observed device.
 * @throws {@link HarnessError} with `PHONE_DEVICE_NOT_FOUND` when the id is absent.
 */
function findDevice(list: PhoneDeviceList, id: DeviceId): ObservedDevice {
  const found = allRefs(list).find(device => device.id === id)
  if (found === undefined) {
    throw new HarnessError(
      `no device answers ${JSON.stringify(id)} in the latest listing`,
      'PHONE_DEVICE_NOT_FOUND',
    )
  }
  return found
}

/**
 * Re-throw a fleet failure with a structured HarnessError code when the Service
 * already classified it.
 * @param error - Thrown fleet value.
 * @returns never; always throws.
 */
function wrapFleetError(error: unknown): never {
  if (error instanceof PhoneDevicesError) {
    throw new HarnessError(error.message, error.code, { cause: error })
  }
  if (error instanceof HarnessError) throw error
  throw error
}

/**
 * Narrow a schema-validated act payload onto the closed action union.
 * @param raw - Model-supplied action after JSON-schema validation.
 * @returns the closed action forwarded to the fleet.
 */
function parseAction(raw: DeviceAction): DeviceAction {
  if (raw.kind === 'tap') return { kind: 'tap', x: raw.x, y: raw.y }
  if (raw.kind === 'swipe') {
    return { kind: 'swipe', x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2 }
  }
  if (raw.kind === 'type') {
    const text = raw.text.trim()
    if (text.length === 0) {
      throw new HarnessError('device_act type text must be non-empty', 'PHONE_UNSUPPORTED')
    }
    return { kind: 'type', text }
  }
  return { kind: 'button', name: raw.name }
}

const IO_BUTTONS: Record<(typeof BUTTON_NAMES)[number], string> = {
  home: 'HOME',
  back: 'BACK',
  recents: 'APP_SWITCH',
  power: 'POWER',
  volume_up: 'VOLUME_UP',
  volume_down: 'VOLUME_DOWN',
}

/**
 * Map one closed model action onto a branded `device.io.*` request.
 * @param id - Branded device id.
 * @param action - Closed tap, swipe, type, or button action.
 * @returns the Service IO request.
 */
function ioRequestFrom(id: DeviceId, action: DeviceAction): PhoneIoRequest {
  if (action.kind === 'tap') return { deviceId: id, method: 'tap', x: action.x, y: action.y }
  if (action.kind === 'swipe') {
    return {
      deviceId: id,
      method: 'gesture',
      actions: phoneSwipeActions([
        { x: action.x1, y: action.y1 },
        { x: action.x2, y: action.y2 },
      ]),
    }
  }
  if (action.kind === 'type') return { deviceId: id, method: 'text', text: action.text }
  return { deviceId: id, method: 'button', button: IO_BUTTONS[action.name] }
}

/**
 * Register six deferred phone-device tools. Consequential mutations ask through
 * `tools/pre-execute` before the fleet is touched.
 * @param ctx - Consumer context with the phone fleet and tool registry.
 * @param config - Per-call timeout configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tool-phone: config.timeoutMs must be a positive safe integer')
  }
  const fleet = ctx.phoneDevices as unknown as PhoneFleet

  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    return next().then((prior) => {
      if (prior.kind !== 'allow') return prior
      if (!ASK_TOOLS.has(exec.name)) return prior
      return { kind: 'ask' as const, reason: `phone tool "${exec.name}" mutates a real or virtual device` }
    })
  })

  let disposeTools: (() => void) | undefined
  const synchronizeTools = (): void => {
    const ready = fleet.isReady?.() ?? true
    if (ready && disposeTools === undefined) disposeTools = registerPhoneTools(ctx, fleet, timeoutMs)
    if (!ready && disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
  }
  const unsubscribe = fleet.onReadinessChanged?.(() => { synchronizeTools() })
  synchronizeTools()
  ctx.effect(() => () => {
    unsubscribe?.()
    disposeTools?.()
    disposeTools = undefined
  }, 'tool-phone readiness registration')
}

function registerPhoneTools(ctx: Context, fleet: PhoneFleet, timeoutMs: number): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_list',
      description: 'List every Android and iOS device known to the phone fleet, including offline simulators and emulators.',
      timeoutMs,
      parameters: {},
      output: { schema: DEVICE_LIST_SCHEMA, render: renderValue },
      execute: async (_args, exec) => {
        try {
          const list = await fleet.listDevices(exec.signal)
          return {
            android: [...list.android],
            ios: {
              simulators: [...list.ios.simulators],
              reals: [...list.ios.reals],
            },
          }
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_observe',
      description: 'Observe one phone device from the latest fleet listing.',
      timeoutMs,
      parameters: { deviceId: DEVICE_ID_PARAMETER },
      output: { schema: OBSERVE_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const id = requireDeviceId(args.deviceId)
        try {
          return findDevice(await fleet.listDevices(exec.signal), id)
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_open',
      description: 'Boot one iOS simulator or Android emulator. Physical handsets are refused.',
      timeoutMs,
      parameters: { deviceId: DEVICE_ID_PARAMETER },
      output: { schema: MUTATION_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const id = requireDeviceId(args.deviceId)
        try {
          await fleet.boot(id, exec.signal)
          return { deviceId: id, status: 'ok' as const }
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_close',
      description: 'Shut down one iOS simulator or Android emulator. Physical handsets are refused.',
      timeoutMs,
      parameters: { deviceId: DEVICE_ID_PARAMETER },
      output: { schema: MUTATION_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const id = requireDeviceId(args.deviceId)
        try {
          await fleet.shutdown(id, exec.signal)
          return { deviceId: id, status: 'ok' as const }
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_act',
      description: 'Perform one closed tap, swipe, type, or hardware-button action on a phone device. There is no arbitrary shell.',
      timeoutMs,
      parameters: {
        deviceId: DEVICE_ID_PARAMETER,
        action: {
          required: true as const,
          oneOf: [TAP_ACTION, SWIPE_ACTION, TYPE_ACTION, BUTTON_ACTION],
          description: 'Exactly one closed gesture or hardware-button action.',
        },
      },
      output: { schema: ACT_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const id = requireDeviceId(args.deviceId)
        const action = parseAction(args.action)
        if (fleet.io === undefined) {
          throw new HarnessError('the phone fleet does not expose device actions', 'PHONE_UNSUPPORTED')
        }
        try {
          await fleet.io(ioRequestFrom(id, action), exec.signal)
          return { deviceId: id, action, status: 'ok' as const }
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))

  disposers.push(ctx.tools.register({
    ...defineTool({
      name: 'device_screenshot',
      description: 'Capture one PNG screenshot of a phone device.',
      timeoutMs,
      parameters: { deviceId: DEVICE_ID_PARAMETER },
      output: { schema: SCREENSHOT_SCHEMA, render: renderValue },
      execute: async (args, exec) => {
        const id = requireDeviceId(args.deviceId)
        if (fleet.screenshot === undefined) {
          throw new HarnessError('the phone fleet does not expose screenshots', 'PHONE_UNSUPPORTED')
        }
        try {
          const shot = await fleet.screenshot(id, exec.signal)
          return { deviceId: id, mediaType: shot.mediaType, data: shot.data }
        } catch (error) {
          wrapFleetError(error)
        }
      },
    }),
    deferLoading: true,
  }))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
