import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-phone-runtime'
import type {} from '@deepseek-ai/dsh-phone-stream'
import { PHONE_IO_PATH } from '@deepseek-ai/dsh-phone-stream'

/** Cordis name for the keyless Android capture-source Host wire scenario. */
export const name = 'phone-capture-wire-keyless-scenario'
/** Scenario dependencies assembled before the runner executes. */
export const inject = ['phoneDevices', 'phoneStream', 'webServer']

const DEVICE_ID = 'emulator-5554'
const COMPATIBLE = { width: 1_124, height: 540, x: 562, y: 270 } as const
const WRONG = { width: 1_080, height: 2_248, x: 540, y: 1_124 } as const
const IO_TIMEOUT_MS = 5_000

interface CaptureUrl {
  readonly url: string
  readonly captureId: string
  readonly expiresAt: number
}

interface SessionBody {
  readonly deviceId: string
  readonly ioPath: string
  readonly preferredFormat: string
  readonly h264: CaptureUrl
}

interface JsonRpcReply {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

interface FakeCounters {
  readonly io: unknown[]
}

interface ListingDevice {
  readonly id?: unknown
  readonly logicalDisplay?: { readonly width?: unknown; readonly height?: unknown }
}

function projectSession(session: SessionBody): unknown {
  return {
    deviceId: session.deviceId,
    ioPath: session.ioPath,
    preferredFormat: session.preferredFormat,
    h264: {
      captureId: '{{captureId}}',
      url: session.h264.url.replace(/token=[^&]+/u, 'token={{token}}'),
      expiresAt: '{{expiresAt}}',
    },
  }
}

function projectReply(reply: JsonRpcReply): unknown {
  if (reply.error !== undefined) {
    return {
      jsonrpc: reply.jsonrpc,
      id: reply.id,
      error: { code: reply.error.code, message: reply.error.message },
    }
  }
  return { jsonrpc: reply.jsonrpc, id: reply.id, result: reply.result }
}

type Plane = { readonly width: number; readonly height: number; readonly x: number; readonly y: number }

function captureTap(session: SessionBody, plane: Plane): Record<string, unknown> {
  return {
    deviceId: DEVICE_ID,
    x: plane.x,
    y: plane.y,
    kind: 'capture',
    captureId: session.h264.captureId,
    captureFormat: 'h264',
    captureRotation: 0,
    captureWidth: plane.width,
    captureHeight: plane.height,
  }
}

function projectRequest(plane: Plane): unknown {
  return {
    captureWidth: plane.width,
    captureHeight: plane.height,
    captureRotation: 0,
    x: plane.x,
    y: plane.y,
  }
}

async function jsonRpc(origin: string, params: Record<string, unknown>, id: number): Promise<JsonRpcReply> {
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(origin).port}${PHONE_IO_PATH}`)
  const wait = (kind: 'open' | 'message'): Promise<JsonRpcReply | void> => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { finish(new Error(`phone-capture-wire io ${kind} timed out`)) }, IO_TIMEOUT_MS)
    const onOpen = (): void => { if (kind === 'open') finish() }
    const onMessage = (event: MessageEvent): void => {
      if (kind !== 'message') return
      finish(undefined, JSON.parse(String(event.data)) as JsonRpcReply)
    }
    const onError = (): void => { finish(new Error(`phone-capture-wire io ${kind} failed`)) }
    const onClose = (): void => { finish(new Error(`phone-capture-wire io closed during ${kind}`)) }
    const finish = (error?: Error, value?: JsonRpcReply): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
  try {
    await wait('open')
    const reply = wait('message') as Promise<JsonRpcReply>
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tap', params }))
    return await reply
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
  }
}

async function readCounters(baseUrl: string): Promise<FakeCounters> {
  return await (await fetch(`${baseUrl}/__test/counters`)).json() as FakeCounters
}

async function listingLogical(origin: string, host: string): Promise<{ readonly width: number; readonly height: number }> {
  const response = await fetch(`${origin}/phone/devices`, { headers: { host } })
  if (response.status !== 200) {
    throw new Error(`phone-capture-wire listing failed: ${String(response.status)}`)
  }
  const body = await response.json() as { android?: ListingDevice[] }
  const device = body.android?.find(entry => entry.id === DEVICE_ID)
  const logical = device?.logicalDisplay
  if (logical?.width !== 2_248 || logical.height !== 1_080) {
    throw new Error(`phone-capture-wire listing logicalDisplay must be 2248x1080, got ${JSON.stringify(logical ?? null)}`)
  }
  return { width: logical.width, height: logical.height }
}

function waitUntilReady(ctx: Context): Promise<void> {
  if (ctx.phoneDevices.isReady()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop()
      reject(new Error('phone-capture-wire: phoneDevices did not become ready'))
    }, 6_000)
    const stop = ctx.phoneDevices.onReadinessChanged((ready) => {
      if (!ready) return
      clearTimeout(timeout)
      stop()
      resolve()
    })
  })
}

/**
 * Drive mint, an active H264 grant, a wrong-plane tap, then a compatible downsample tap.
 * @param ctx - settled Host context carrying phoneDevices, phoneStream, and webServer.
 */
export async function apply(ctx: Context): Promise<void> {
  const fakeBaseUrl = process.env.DSH_PHONE_FAKE_BASE_URL
  if (fakeBaseUrl === undefined || fakeBaseUrl.length === 0) {
    throw new Error('phone-capture-wire requires DSH_PHONE_FAKE_BASE_URL')
  }
  await waitUntilReady(ctx)
  const origin = `http://${ctx.webServer.host}:${String(ctx.webServer.port)}`
  const host = new URL(origin).host
  const mint = await fetch(`${origin}/phone/session`, {
    method: 'POST',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  })
  if (mint.status !== 200) {
    throw new Error(`phone-capture-wire mint failed: ${String(mint.status)} ${await mint.text()}`)
  }
  const session = await mint.json() as SessionBody
  const logical = await listingLogical(origin, host)
  const capture = await fetch(`${origin}${session.h264.url}`, { headers: { host } })
  if (capture.status !== 200) {
    throw new Error(`phone-capture-wire capture failed: ${String(capture.status)}`)
  }
  try {
    const before = await readCounters(fakeBaseUrl)
    const wrong = await jsonRpc(origin, captureTap(session, WRONG), 1)
    const afterWrong = await readCounters(fakeBaseUrl)
    const ok = await jsonRpc(origin, captureTap(session, COMPATIBLE), 2)
    const afterOk = await readCounters(fakeBaseUrl)
    process.stdout.write(`${JSON.stringify({
      mint: projectSession(session),
      listingLogical: logical,
      wrongPlane: {
        request: projectRequest(WRONG),
        reply: projectReply(wrong),
        upstreamIoDelta: afterWrong.io.slice(before.io.length),
      },
      compatibleDownsample: {
        request: projectRequest(COMPATIBLE),
        reply: projectReply(ok),
        upstreamIoDelta: afterOk.io.slice(afterWrong.io.length),
      },
    })}\n`)
  } finally {
    await capture.body?.cancel()
  }
}
