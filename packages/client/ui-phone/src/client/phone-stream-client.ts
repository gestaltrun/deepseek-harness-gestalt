/**
 * Same-origin transport of the Host `phoneStream` Consumer: session minting
 * over `POST /phone/session`, the `/phone/ws/io` JSON-RPC WebSocket, and the
 * pure io frame codec. This module owns wire facts only — the connection
 * state machine in `phone-connection.ts` decides what the facts mean.
 * @module @deepseek-ai/dsh-client-ui-phone/client/phone-stream-client
 */
import type { PhoneIoHandlers, PhoneIoSocket, PhoneStreamGateway } from './phone-connection.ts'

/** Minting endpoint for signed same-origin capture URLs. */
export const PHONE_SESSION_PATH = '/phone/session'

/**
 * Whether an upstream io/capture message reports the handset debugging gate.
 * @param message - Wire or upstream error text.
 * @returns true when the text names an unauthorized USB/WDA gate.
 */
export function isUnauthorizedMessage(message: string): boolean {
  return /unauthor/i.test(message)
}

/** One signed same-origin capture URL plus its expiry (Host wire shape). */
export interface PhoneStreamUrlView {
  /** Path and query to load on this Host; never a `:12000` origin. */
  readonly url: string
  /** Unix epoch milliseconds after which the Host refuses this URL. */
  readonly expiresAt: number
}

/** The minted session the browser plays and addresses io with. */
export interface PhoneStreamSessionView {
  /** Device these URLs address. */
  readonly deviceId: string
  /** Exact-path WebSocket upgrade path for io frames. */
  readonly ioPath: string
  /** Signed MJPEG capture URL (Host still signs it; the live view does not request it). */
  readonly mjpeg: PhoneStreamUrlView
  /** Signed H264 capture URL (the live view's only requested encoding). */
  readonly h264: PhoneStreamUrlView
}

/** One mint failure with its wire status and code. */
export class PhoneStreamHttpError extends Error {
  /**
   * @param status - HTTP status the minting endpoint answered with.
   * @param code - wire error code (`forbidden`, `not-found`, …).
   * @param message - wire error message.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** io request vocabulary the browser sends; coordinates are device pixels. */
export type PhoneClientIoRequest =
  | { readonly method: 'tap'; readonly x: number; readonly y: number }
  | { readonly method: 'gesture'; readonly actions: readonly Record<string, unknown>[] }
  | { readonly method: 'text'; readonly text: string }
  | { readonly method: 'button'; readonly button: string }

/** One parsed io reply: ok results and errors alike. */
export interface PhoneIoReply {
  /** Echoed JSON-RPC id of the request. */
  readonly id: number
  /** Whether the Host reported success. */
  readonly ok: boolean
  /** Wire error code when {@link PhoneIoReply.ok} is false. */
  readonly code?: number | undefined
  /** Wire error message when {@link PhoneIoReply.ok} is false. */
  readonly message?: string | undefined
}

/**
 * Encode one io JSON-RPC frame.
 * @param id - JSON-RPC request id minted by the caller.
 * @param deviceId - device the frame addresses.
 * @param request - the io request payload.
 * @returns the text frame to send over the io socket.
 */
export function encodePhoneIoFrame(id: number, deviceId: string, request: PhoneClientIoRequest): string {
  switch (request.method) {
    case 'tap':
      return JSON.stringify({ jsonrpc: '2.0', id, method: 'tap', params: { deviceId, x: request.x, y: request.y } })
    case 'gesture':
      return JSON.stringify({ jsonrpc: '2.0', id, method: 'gesture', params: { deviceId, actions: request.actions } })
    case 'text':
      return JSON.stringify({ jsonrpc: '2.0', id, method: 'text', params: { deviceId, text: request.text } })
    case 'button':
      return JSON.stringify({ jsonrpc: '2.0', id, method: 'button', params: { deviceId, button: request.button } })
  }
}

/**
 * Parse one io reply frame. Notifications, malformed JSON, and frames
 * without a numeric id read as undefined — only request replies are
 * actionable to the controller.
 * @param data - raw text frame from the io socket.
 * @returns the parsed reply, or undefined when the frame carries no reply.
 */
export function parsePhoneIoReply(data: string): PhoneIoReply | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
  if (typeof record.id !== 'number') return undefined
  if (record.error !== undefined && typeof record.error === 'object' && record.error !== null) {
    return {
      id: record.id,
      ok: false,
      code: typeof record.error.code === 'number' ? record.error.code : undefined,
      message: typeof record.error.message === 'string' ? record.error.message : undefined,
    }
  }
  return { id: record.id, ok: record.result !== undefined }
}

function isStreamUrlView(value: unknown): value is PhoneStreamUrlView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.url === 'string' && record.url.length > 0 && typeof record.expiresAt === 'number'
}

/**
 * Mint one signed same-origin session for one device.
 * @param deviceId - Android serial or iOS UDID present in the latest listing.
 * @returns the session with the io path and signed capture URLs. The live view requests `format: 'avc'` (Host `h264`).
 * @throws {@link PhoneStreamHttpError} when the Host refuses the mint.
 * @throws the network error when the Host is unreachable.
 */
export async function mintPhoneSession(deviceId: string): Promise<PhoneStreamSessionView> {
  let response: Response
  try {
    response = await fetch(PHONE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, format: 'avc' }),
    })
  } catch (error) {
    throw new PhoneStreamHttpError(0, 'network', error instanceof Error ? error.message : String(error))
  }
  const body: unknown = await response.json().catch(() => null)
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const error = (typeof record.error === 'object' && record.error !== null ? record.error : {}) as Record<string, unknown>
  if (!response.ok || !isStreamUrlView(record.mjpeg) || !isStreamUrlView(record.h264) || typeof record.ioPath !== 'string') {
    throw new PhoneStreamHttpError(
      response.status,
      typeof error.code === 'string' ? error.code : 'http',
      typeof error.message === 'string' ? error.message : `phone session mint failed with HTTP ${response.status}`,
    )
  }
  return {
    deviceId: typeof record.deviceId === 'string' ? record.deviceId : deviceId,
    ioPath: record.ioPath,
    mjpeg: record.mjpeg,
    h264: record.h264,
  }
}

/** Socket target the minted session names. */
export type PhoneIoTarget = Pick<PhoneStreamSessionView, 'ioPath'>

/**
 * Open the io WebSocket against the current Host origin on the io path the
 * Host minted. The browser fires `open` asynchronously, so handlers never
 * run during this call.
 * @param target - the minted session carrying the io upgrade path.
 * @param handlers - the events the connection controller reacts to.
 * @returns the socket handle the controller owns.
 */
export function openPhoneIoSocket(target: PhoneIoTarget, handlers: PhoneIoHandlers): PhoneIoSocket {
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host ?? ''
  const socket = new WebSocket(`${protocol}://${host}${target.ioPath}`)
  socket.onopen = () => { handlers.onOpen() }
  socket.onclose = () => { handlers.onClose() }
  socket.onerror = () => { handlers.onError() }
  socket.onmessage = (event) => { handlers.onMessage(typeof event.data === 'string' ? event.data : '') }
  return {
    send: (data) => { socket.send(data) },
    close: () => { socket.close() },
  }
}

/**
 * Wire the browser transport onto the gateway seam the connection
 * controller consumes.
 * @returns the production gateway backed by fetch and WebSocket.
 */
export function createHttpPhoneGateway(): PhoneStreamGateway {
  return {
    mintSession: deviceId => mintPhoneSession(deviceId),
    connectIo: (target, handlers) => openPhoneIoSocket(target, handlers),
  }
}
