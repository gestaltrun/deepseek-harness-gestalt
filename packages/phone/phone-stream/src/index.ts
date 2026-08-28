/**
 * Host-half Consumer that reverse-proxies mobilecli IO and screen capture
 * through the Host webserver. The browser never dials `:12000`: IO rides a
 * same-origin WebSocket upgrade, and MJPEG/H264 frames ride signed loopback
 * HTTP URLs. Picture aspect (1:2, axis 3) is a GUI consumer contract; this
 * package only mints stream URLs and forwards frames.
 * @module @deepseek-ai/dsh-phone-stream
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deviceId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { DeviceId, PhoneCaptureFormat, PhoneIoRequest } from '@deepseek-ai/dsh-phone-runtime'
import { HttpError, readJsonObject, writeHttpError, writeJson } from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer } from 'ws'
import { signPhoneStreamToken, verifyPhoneStreamToken } from './token.ts'
import { isLoopbackApiRequest, isTrustedApiRequest } from './trust.ts'
import type { PhoneStreamSession, PhoneStreamUrl } from './types.ts'

export type { PhoneStreamSession, PhoneStreamUrl } from './types.ts'
export { isCaptureFormat, signPhoneStreamToken, verifyPhoneStreamToken } from './token.ts'
export { isLoopbackApiRequest, isLoopbackHostname, isTrustedApiRequest } from './trust.ts'

/** Exact-path WebSocket that forwards `device.io.*` JSON-RPC. */
export const PHONE_IO_PATH = '/phone/ws/io'
/** Prefix for signed capture URLs (`/phone/stream/<id>/<mjpeg|h264>?token=`). */
export const PHONE_STREAM_PATH = '/phone/stream'
/** Prefix for minting signed same-origin session URLs. */
export const PHONE_SESSION_PATH = '/phone/session'

const IO_METHODS = new Set(['tap', 'gesture', 'text', 'button'])
const JSON_BODY_LIMITS = {
  maxBytes: 64 * 1024,
  tooLarge: { status: 413, code: 'payload-too-large', message: 'phone stream JSON body exceeds 64 KiB' },
  invalidJson: { status: 400, code: 'invalid-json', message: 'phone stream JSON body is not valid JSON' },
  notObject: { status: 400, code: 'invalid-json', message: 'phone stream JSON body must be an object' },
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Same-origin phone IO and capture reverse-proxy. */
    phoneStream: PhoneStream
  }
}

/**
 * Validated runtime configuration. Token lifetime is a deployment-varying
 * choice; path prefixes, HMAC algorithm, and the loopback capture fence are
 * security invariants.
 */
export interface Config {
  /** Milliseconds a minted capture URL remains valid. */
  tokenTtlMs?: number
}

/** Runtime configuration schema applied by composition. */
export const Config: z<Config> = z.object({
  tokenTtlMs: z.number().default(30_000),
})

/**
 * Same-origin phone stream Consumer. It injects `phoneDevices` and
 * `webServer`, registers the IO upgrade and signed capture routes, and
 * publishes `ctx.phoneStream` so later GUI consumers can mint URLs without
 * talking to `:12000`.
 */
export class PhoneStream extends Service {
  /** Validated configuration schema applied by composition. */
  static readonly Config = Config
  /** Services required before this Consumer can register Host routes. */
  static inject = ['phoneDevices', 'webServer']

  private readonly tokenTtlMs: number
  private readonly secret = randomBytes(32)
  private readonly sockets = new Set<Duplex>()

  /**
   * Register Host routes as fiber effects and mint the process-local HMAC key.
   * @param ctx - Owning Cordis context carrying `phoneDevices` and `webServer`.
   * @param config - Composition config validated against {@link PhoneStream.Config}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'phoneStream')
    this.tokenTtlMs = resolveTokenTtl(config.tokenTtlMs as number)
    const wss = new WebSocketServer({ noServer: true })
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PHONE_SESSION_PATH,
      handler: (req, res) => this.handleSession(req, res),
    }), 'phone-stream: /phone/session')
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PHONE_STREAM_PATH,
      handler: (req, res) => this.handleCapture(req, res),
    }), 'phone-stream: /phone/stream')
    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: PHONE_IO_PATH,
      handler: (req, socket, head) => this.handleIoUpgrade(wss, req, socket, head),
    }), 'phone-stream: /phone/ws/io')
    ctx.effect(() => () => {
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      wss.close()
    }, 'phone-stream: socket teardown')
  }

  /**
   * Mint signed same-origin MJPEG and H264 URLs for one known device.
   * @param id - Branded device id present in the latest published listing.
   * @returns the IO upgrade path plus both capture URLs and their expiry.
   */
  sessionFor(id: DeviceId): PhoneStreamSession {
    const expiresAt = Date.now() + this.tokenTtlMs
    return Object.freeze({
      deviceId: id,
      ioPath: PHONE_IO_PATH,
      mjpeg: this.signedUrl(id, 'mjpeg', expiresAt),
      h264: this.signedUrl(id, 'h264', expiresAt),
    })
  }

  private signedUrl(id: DeviceId, format: PhoneCaptureFormat, expiresAt: number): PhoneStreamUrl {
    const token = signPhoneStreamToken(this.secret, id, format, expiresAt)
    return Object.freeze({
      url: `${PHONE_STREAM_PATH}/${encodeURIComponent(id)}/${format}?token=${encodeURIComponent(token)}`,
      expiresAt,
    })
  }

  private trustedHosts(): readonly string[] {
    const runtime = this.ctx.get('webRuntime') as { readonly trustedHosts?: readonly string[] } | undefined
    return runtime?.trustedHosts ?? []
  }

  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.trustedHosts())) {
      writeForbidden(res)
      return
    }
    if (req.method !== 'POST') {
      writeHttpError(res, new HttpError(405, 'method-not-allowed', 'phone session minting is POST-only'))
      return
    }
    const pathname = pathnameOf(req)
    if (pathname !== PHONE_SESSION_PATH) {
      writeHttpError(res, new HttpError(404, 'not-found', 'unknown phone session path'))
      return
    }
    try {
      const body = await readJsonObject(req, JSON_BODY_LIMITS)
      const rawId = body.deviceId
      if (typeof rawId !== 'string' || rawId.length === 0) {
        throw new HttpError(400, 'bad-request', 'deviceId is required')
      }
      const id = deviceId(rawId)
      const list = await this.ctx.phoneDevices.listDevices()
      const known = [...list.android, ...list.ios.simulators, ...list.ios.reals].some(ref => ref.id === id)
      if (!known) {
        throw new PhoneDevicesError(
          'PHONE_DEVICE_NOT_FOUND',
          `cannot mint stream URLs: ${JSON.stringify(id)} is absent from the latest device listing`,
        )
      }
      writeJson(res, 200, this.sessionFor(id))
    } catch (error) {
      this.writeFailure(res, error)
    }
  }

  private async handleCapture(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.trustedHosts()) || !isLoopbackApiRequest(req)) {
      writeForbidden(res)
      return
    }
    if (req.method !== 'GET') {
      writeHttpError(res, new HttpError(405, 'method-not-allowed', 'phone capture is GET-only'))
      return
    }
    const url = new URL(req.url as string, 'http://dsh.internal')
    const parsed = parseCapturePath(url.pathname)
    if (parsed === undefined) {
      writeHttpError(res, new HttpError(404, 'not-found', 'unknown phone capture path'))
      return
    }
    const token = url.searchParams.get('token') ?? /* v8 ignore next */ ''
    const grant = verifyPhoneStreamToken(this.secret, parsed.deviceId, parsed.format, token, Date.now())
    if (grant === undefined) {
      writeForbidden(res)
      return
    }
    try {
      const capture = await this.ctx.phoneDevices.startCapture({
        deviceId: deviceId(grant.deviceId),
        format: grant.format,
      })
      res.writeHead(200, {
        'content-type': capture.contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      const reader = capture.body.getReader()
      /* v8 ignore start -- browser disconnect cancels the unread capture body */
      const abort = (): void => {
        void reader.cancel()
      }
      /* v8 ignore stop */
      req.on('aborted', abort)
      res.on('close', abort)
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          /* v8 ignore next -- node:fetch yields a defined Uint8Array chunk or done */
          if (next.value === undefined) continue
          res.write(Buffer.from(next.value))
        }
        res.end()
      } catch {
        // The browser or upstream capture ended the pipe; both sides are already closing.
        /* v8 ignore next -- headers are already sent when the pipe throws */
        if (!res.writableEnded) res.destroy()
      } finally {
        req.off('aborted', abort)
        res.off('close', abort)
      }
    } catch (error) {
      /* v8 ignore next 4 -- startCapture fails before writeHead in the suite */
      if (res.headersSent) {
        res.destroy()
        return
      }
      this.writeFailure(res, error)
    }
  }

  private handleIoUpgrade(
    wss: WebSocketServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (!isTrustedApiRequest(req, this.trustedHosts())) {
      rejectUpgrade(socket)
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
    })
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        void this.dispatchIo(ws, raw)
      })
    })
  }

  private async dispatchIo(ws: { send(data: string): void }, raw: unknown): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw)) as unknown
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }))
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }))
      return
    }
    const record = parsed as { id?: unknown; method?: unknown; params?: unknown }
    const id = record.id ?? null
    try {
      const request = parseIoRequest(record.method, record.params)
      await this.ctx.phoneDevices.io(request)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'ok' } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : /* v8 ignore next */ String(error)
      const code = error instanceof PhoneDevicesError && error.code === 'PHONE_DEVICE_NOT_FOUND'
        ? -32010
        : -32000
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
    }
  }

  private writeFailure(res: ServerResponse, error: unknown): void {
    if (error instanceof HttpError) {
      writeHttpError(res, error)
      return
    }
    if (error instanceof PhoneDevicesError && error.code === 'PHONE_DEVICE_NOT_FOUND') {
      writeHttpError(res, new HttpError(404, 'not-found', error.message))
      return
    }
    /* v8 ignore next -- PhoneDevicesError and HttpError already returned */
    const message = error instanceof Error ? error.message : String(error)
    writeHttpError(res, new HttpError(502, 'upstream', message))
  }
}

function resolveTokenTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('phone-stream: tokenTtlMs must be a positive safe integer')
  }
  return value
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url as string, 'http://dsh.internal').pathname
}

function parseCapturePath(pathname: string): { readonly deviceId: string; readonly format: string } | undefined {
  const prefix = `${PHONE_STREAM_PATH}/`
  /* v8 ignore next -- handleCapture already 404s unknown prefixes */
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  const separator = rest.lastIndexOf('/')
  if (separator <= 0 || separator === rest.length - 1) return undefined
  let deviceIdValue: string
  try {
    deviceIdValue = decodeURIComponent(rest.slice(0, separator))
  } catch {
    return undefined
  }
  if (deviceIdValue.length === 0 || deviceIdValue.includes('/')) return undefined
  return { deviceId: deviceIdValue, format: rest.slice(separator + 1) }
}

function parseIoRequest(method: unknown, params: unknown): PhoneIoRequest {
  if (typeof method !== 'string' || !IO_METHODS.has(method)) {
    throw new HttpError(400, 'bad-request', `unsupported phone io method ${JSON.stringify(method)}`)
  }
  if (typeof params !== 'object' || params === null) {
    throw new HttpError(400, 'bad-request', 'phone io params must be an object')
  }
  const record = params as Record<string, unknown>
  const rawId = record.deviceId
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw new HttpError(400, 'bad-request', 'deviceId is required')
  }
  const id = deviceId(rawId)
  switch (method) {
    case 'tap':
      return { deviceId: id, method: 'tap', x: requireInteger(record.x, 'x'), y: requireInteger(record.y, 'y') }
    case 'gesture':
      if (!Array.isArray(record.actions)) throw new HttpError(400, 'bad-request', 'gesture actions must be an array')
      return { deviceId: id, method: 'gesture', actions: record.actions as readonly Record<string, unknown>[] }
    case 'text':
      if (typeof record.text !== 'string') throw new HttpError(400, 'bad-request', 'text is required')
      return { deviceId: id, method: 'text', text: record.text }
    case 'button':
      if (typeof record.button !== 'string' || record.button.length === 0) {
        throw new HttpError(400, 'bad-request', 'button is required')
      }
      return { deviceId: id, method: 'button', button: record.button }
    /* v8 ignore start -- IO_METHODS already closed the union */
    default: {
      const exhaustive: never = method as never
      throw new HttpError(400, 'bad-request', `unsupported phone io method ${JSON.stringify(exhaustive)}`)
    }
    /* v8 ignore stop */
  }
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(400, 'bad-request', `${name} must be an integer`)
  }
  return value
}

function writeForbidden(res: ServerResponse): void {
  writeJson(res, 403, { error: { code: 'forbidden', message: 'forbidden' } })
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 9',
    '',
    'forbidden',
  ].join('\r\n'))
}

export default PhoneStream
