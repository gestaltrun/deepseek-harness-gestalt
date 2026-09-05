/**
 * Host-half Consumer that reverse-proxies mobilecli IO and screen capture
 * through the Host webserver. The browser never dials `:12000`: IO rides a
 * same-origin WebSocket upgrade, and MJPEG/H264 frames ride signed loopback
 * HTTP URLs. This package mints capture identities and forwards frames; the
 * GUI owns measured picture layout and input presentation.
 * @module @deepseek-ai/dsh-phone-stream
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deviceId, phoneCaptureId, PhoneDevicesError } from '@deepseek-ai/dsh-phone-runtime'
import type { DeviceId, PhoneCaptureFormat, PhoneCaptureId, PhoneDeviceRef, PhoneIoRequest } from '@deepseek-ai/dsh-phone-runtime'
import { HttpError, readJsonObject, writeHttpError, writeJson } from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer } from 'ws'
import { signPhoneStreamToken, verifyPhoneStreamToken } from './token.ts'
import { isLoopbackApiRequest, isTrustedApiRequest } from './trust.ts'
import { normalizeMultipartImageStream } from './multipart-normalize.ts'
import { CaptureRelays } from './capture-relays.ts'
import { ServerResponseCaptureSink } from './server-response-capture-sink.ts'
import { PhoneIoTransports } from './phone-io-transports.ts'
import { CaptureGrantLedger } from './capture-grant-ledger.ts'
import { PhoneStreamOwner } from './phone-stream-owner.ts'
import { PhoneHttpTransactions } from './phone-http-transactions.ts'
import type { PhoneDeviceRefWire, PhoneStreamSession, PhoneStreamUrl } from './types.ts'

export type { PhoneStreamSession, PhoneStreamUrl } from './types.ts'
export type { PhoneDeviceListWire, PhoneDeviceRefWire } from './types.ts'
export { isCaptureFormat, signPhoneStreamToken, verifyPhoneStreamToken } from './token.ts'
export { isLoopbackApiRequest, isLoopbackHostname, isTrustedApiRequest } from './trust.ts'

/** Exact-path WebSocket that forwards `device.io.*` JSON-RPC. */
export const PHONE_IO_PATH = '/phone/ws/io'
/** Prefix for signed capture URLs (`/phone/stream/<id>/<mjpeg|h264>?token=`). */
export const PHONE_STREAM_PATH = '/phone/stream'
/** Prefix for minting signed same-origin session URLs. */
export const PHONE_SESSION_PATH = '/phone/session'
/** Prefix for managed device-agent detection and installation operations. */
export const PHONE_AGENT_PATH = '/phone/agent'
/** Exact-path GET listing of the grouped device fleet behind the `/api` fence. */
export const PHONE_DEVICES_PATH = '/phone/devices'

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
  /** Maximum milliseconds spent joining foreign capture cleanup during shutdown. */
  transportCleanupTimeoutMs?: number
}

/** Runtime configuration schema applied by composition. */
export const Config: z<Config> = z.object({
  tokenTtlMs: z.number().default(30_000),
  transportCleanupTimeoutMs: z.number().default(1_000),
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
  private readonly transportCleanupTimeoutMs: number
  private readonly secret = randomBytes(32)
  private readonly grants = new CaptureGrantLedger()
  private readonly relays: CaptureRelays
  private readonly transports: PhoneIoTransports
  private readonly httpTransactions: PhoneHttpTransactions
  private closing = false

  /**
   * Register Host routes as fiber effects and mint the process-local HMAC key.
   * @param ctx - Owning Cordis context carrying `phoneDevices` and `webServer`.
   * @param config - Composition config validated against {@link PhoneStream.Config}.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'phoneStream')
    this.tokenTtlMs = resolvePositiveSafeInteger('tokenTtlMs', config.tokenTtlMs as number)
    this.transportCleanupTimeoutMs = resolvePositiveSafeInteger('transportCleanupTimeoutMs', config.transportCleanupTimeoutMs as number)
    this.relays = new CaptureRelays(
      async cleanup => await cleanupDeadline(cleanup, this.transportCleanupTimeoutMs),
      {
        primary: (error) => { this.ctx.logger.warn('phone-stream: capture pipe failed'); this.ctx.logger.warn(error) },
        cleanup: (error) => { this.ctx.logger.warn('phone-stream: capture cleanup failed'); this.ctx.logger.warn(error) },
        timeout: (error) => { this.ctx.logger.warn('phone-stream: capture cleanup timed out'); this.ctx.logger.warn(error) },
      },
    )
    const wss = new WebSocketServer({ noServer: true })
    this.httpTransactions = new PhoneHttpTransactions(async task => await cleanupDeadline(task, this.transportCleanupTimeoutMs))
    this.transports = new PhoneIoTransports(
      wss,
      { reject: (socket) => { rejectUpgrade(socket) } },
      async task => await cleanupDeadline(task, this.transportCleanupTimeoutMs),
      {
        failure: (scope, error) => { this.ctx.logger.warn(`phone-stream: ${scope.subsystem} transport failed`)
          this.ctx.logger.warn(error) },
        timeout: (scope) => { this.ctx.logger.warn(`phone-stream: ${scope.subsystem} transport cleanup timed out`) },
      },
    )
    ctx.effect(() => {
      const reason = new PhoneDevicesError('PHONE_ABORTED', 'phone-stream is closing')
      const owner = new PhoneStreamOwner(
        ctx.fiber,
        listener => ctx.on('internal/plugin', listener),
        [
          () => ctx.webServer.register({ kind: 'prefix', path: PHONE_SESSION_PATH, handler: (req, res) => this.httpTransactions.run(async (signal) => { await this.handleSession(req, res, signal) }, () => { this.rejectClosing(res, false) }) }),
          () => ctx.webServer.register({ kind: 'prefix', path: PHONE_AGENT_PATH, handler: (req, res) => this.httpTransactions.run(async (signal) => { await this.handleAgent(req, res, signal) }, () => { this.rejectClosing(res, false) }) }),
          () => ctx.webServer.register({ kind: 'prefix', path: PHONE_DEVICES_PATH, handler: (req, res) => this.httpTransactions.run(async (signal) => { await this.handleDevices(req, res, signal) }, () => { this.rejectClosing(res, false) }) }),
          () => ctx.webServer.register({ kind: 'prefix', path: PHONE_STREAM_PATH, handler: (req, res) => this.httpTransactions.run(async (signal) => { await this.handleCapture(req, res, signal) }, () => { this.rejectClosing(res, true) }) }),
          () => ctx.webServer.registerUpgrade({ path: PHONE_IO_PATH, handler: (req, socket, head) => {
            if (this.closing || !isTrustedApiRequest(req, this.trustedHosts())) { rejectUpgrade(socket); return }
            this.transports.accept(req, socket, head, async (ws, raw, signal) => { await this.dispatchIo(ws, raw, signal) })
          } }),
        ],
        () => { this.closing = true },
        {
          http: () => this.httpTransactions.close(reason),
          transport: () => this.transports.close(reason),
          relay: () => this.relays.close(reason),
        },
      )
      return () => owner.dispose()
    }, 'phone-stream: route and transport owner')
  }

  /**
   * Mint signed same-origin MJPEG and H264 URLs for one known device.
   * @param id - Branded device id present in the latest published listing.
   * @param agentManaged - Whether picture or socket failures should enter the managed device-agent recovery flow.
   * @param preferredFormat - Encoding the browser should open first for this device class.
   * @returns the IO upgrade path plus both capture URLs and their expiry.
   */
  sessionFor(
    id: DeviceId,
    agentManaged: boolean = false,
    preferredFormat: PhoneCaptureFormat = 'h264',
  ): PhoneStreamSession {
    if (this.closing) throw new PhoneDevicesError('PHONE_ABORTED', 'phone-stream is closing')
    const expiresAt = Date.now() + this.tokenTtlMs
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('phone-stream: capture token expiry exceeds the safe integer range')
    return Object.freeze({
      deviceId: id,
      ioPath: PHONE_IO_PATH,
      agentManaged,
      preferredFormat,
      mjpeg: this.signedUrl(id, 'mjpeg', expiresAt),
      h264: this.signedUrl(id, 'h264', expiresAt),
    })
  }

  private signedUrl(id: DeviceId, format: PhoneCaptureFormat, expiresAt: number): PhoneStreamUrl {
    const token = signPhoneStreamToken(this.secret, id, format, expiresAt)
    return Object.freeze({
      url: `${PHONE_STREAM_PATH}/${encodeURIComponent(id)}/${format}?token=${encodeURIComponent(token)}`,
      captureId: phoneCaptureId(token),
      expiresAt,
    })
  }

  private trustedHosts(): readonly string[] {
    const runtime = this.ctx.get('webRuntime') as { readonly trustedHosts?: readonly string[] } | undefined
    return runtime?.trustedHosts ?? []
  }

  private isClosing(signal?: AbortSignal): boolean {
    return this.closing || signal?.aborted === true
  }

  private rejectClosing(res: ServerResponse, capture: boolean): void {
    if (res.headersSent || res.writableEnded) return
    if (capture) writeForbidden(res)
    else writeHttpError(res, new HttpError(503, 'unavailable', 'phone-stream is closing'))
  }

  /**
   * Shared JSON-API admission: a fenced Host answers 503, an untrusted Host is
   * forbidden, and a wrong method is rejected before path or body work. Owner
   * teardown sets `this.closing` before HTTP admission closes, so a request
   * that still enters `PhoneHttpTransactions.run` must observe the fence here.
   * @param req - Incoming JSON-API request.
   * @param res - Response that receives 503, 403, or 405 when admission fails.
   * @param method - Required HTTP method for this route family.
   * @param methodMessage - 405 diagnostic naming the route family and method.
   * @returns true when the handler may continue.
   */
  private admitTrustedJsonApi(req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST', methodMessage: string): boolean {
    if (this.closing) {
      writeHttpError(res, new HttpError(503, 'unavailable', 'phone-stream is closing'))
      return false
    }
    if (!isTrustedApiRequest(req, this.trustedHosts())) {
      writeForbidden(res)
      return false
    }
    if (req.method !== method) {
      writeHttpError(res, new HttpError(405, 'method-not-allowed', methodMessage))
      return false
    }
    return true
  }

  private async handleSession(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!this.admitTrustedJsonApi(req, res, 'POST', 'phone session minting is POST-only')) return
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
      if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
      const knownReal = list.ios.reals.find(ref => ref.id === id)
      const knownSimulator = list.ios.simulators.find(ref => ref.id === id)
      const known = knownReal ?? knownSimulator ?? list.android.find(ref => ref.id === id)
      if (known === undefined) {
        throw new PhoneDevicesError(
          'PHONE_DEVICE_NOT_FOUND',
          `cannot mint stream URLs: ${JSON.stringify(id)} is absent from the latest device listing`,
        )
      }
      if (knownReal !== undefined) {
        // Mint installs a missing recoverable agent; PHONE_AGENT_MISSING is the leftover-absent answer.
        let status = await this.ctx.phoneDevices.agentStatus(id)
        if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
        if (!status.installed) {
          await this.ctx.phoneDevices.installAgent(id)
          if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
          status = await this.ctx.phoneDevices.agentStatus(id)
          if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
        }
        if (!status.installed) {
          writeJson(res, 409, {
            error: {
              code: 'PHONE_AGENT_MISSING',
              message: 'the iOS real-device control agent is not installed',
            },
          })
          return
        }
      }
      writeJson(res, 200, this.sessionFor(
        id,
        knownReal !== undefined || known.platform === 'android',
        knownSimulator === undefined ? 'h264' : 'mjpeg',
      ))
    } catch (error) {
      this.writeFailure(res, error)
    }
  }

  private async handleAgent(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!this.admitTrustedJsonApi(req, res, 'POST', 'phone agent operations are POST-only')) return
    const pathname = pathnameOf(req)
    if (pathname !== `${PHONE_AGENT_PATH}/status` && pathname !== `${PHONE_AGENT_PATH}/install`) {
      writeHttpError(res, new HttpError(404, 'not-found', 'unknown phone agent path'))
      return
    }
    try {
      const body = await readJsonObject(req, JSON_BODY_LIMITS)
      const rawId = body.deviceId
      if (typeof rawId !== 'string' || rawId.length === 0) {
        throw new HttpError(400, 'bad-request', 'deviceId is required')
      }
      const id = deviceId(rawId)
      await this.requireManagedAgentDevice(id)
      if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
      if (pathname === `${PHONE_AGENT_PATH}/status`) {
        const status = await this.ctx.phoneDevices.agentStatus(id)
        if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
        writeJson(res, 200, status)
        return
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        throw new HttpError(400, 'bad-request', 'force must be a boolean')
      }
      const installed = await this.ctx.phoneDevices.installAgent(id, { force: body.force === true })
      if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
      writeJson(res, 200, installed)
    } catch (error) {
      this.writeFailure(res, error)
    }
  }

  private async requireManagedAgentDevice(id: DeviceId): Promise<void> {
    const list = await this.ctx.phoneDevices.listDevices()
    if ([...list.android, ...list.ios.reals].some(device => device.id === id)) return
    if (list.ios.simulators.some(device => device.id === id)) {
      throw new HttpError(400, 'agent-not-managed', 'phone agent operations require Android or an iOS real device')
    }
    throw new PhoneDevicesError(
      'PHONE_DEVICE_NOT_FOUND',
      `cannot operate the device agent: ${JSON.stringify(id)} is absent from the latest device listing`,
    )
  }

  /**
   * Answer the grouped fleet listing for the browser picker: the latest
   * `listDevices()` groups verbatim (android, iOS simulators/reals, online
   * flags). Same-origin browser requests need no minted token — the `/api`
   * trust fence is the gate.
   * @param req - Incoming request.
   * @param res - Response to write the listing JSON onto.
   */
  private async handleDevices(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!this.admitTrustedJsonApi(req, res, 'GET', 'phone device listing is GET-only')) return
    if (pathnameOf(req) !== PHONE_DEVICES_PATH) {
      writeHttpError(res, new HttpError(404, 'not-found', 'unknown phone device listing path'))
      return
    }
    try {
      const list = await this.ctx.phoneDevices.listDevices()
      if (this.isClosing(signal)) { this.rejectClosing(res, false); return }
      const refOf = ({
        id, name, kind, state, online, logicalDisplay,
      }: PhoneDeviceRef): PhoneDeviceRefWire => Object.freeze({
        id,
        name,
        kind,
        state,
        online,
        ...(logicalDisplay === undefined ? {} : { logicalDisplay }),
      })
      writeJson(res, 200, Object.freeze({
        android: list.android.map(refOf),
        ios: Object.freeze({
          simulators: list.ios.simulators.map(refOf),
          reals: list.ios.reals.map(refOf),
        }),
      }))
    } catch (error) {
      this.writeFailure(res, error)
    }
  }

  private async handleCapture(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!isTrustedApiRequest(req, this.trustedHosts()) || !isLoopbackApiRequest(req) || this.isClosing(signal)) {
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
    const now = Date.now()
    const token = url.searchParams.get('token') ?? ''
    const grant = verifyPhoneStreamToken(this.secret, parsed.deviceId, parsed.format, token, now)
    if (grant === undefined || !this.grants.consume(grant.captureId, grant.expiresAt, now)) {
      writeForbidden(res)
      return
    }

    const lifetime = new AbortController()
    const transactionAbort = (): void => { lifetime.abort(signal.reason) }
    signal.addEventListener('abort', transactionAbort, { once: true })
    const abort = (): void => { lifetime.abort() }
    const close = (): void => { abort() }
    req.on('aborted', abort)
    res.on('close', close)
    const multipart = grant.format === 'mjpeg'
    const sink = new ServerResponseCaptureSink(res, multipart)
    try {
      if (this.isClosing(signal)) { this.rejectClosing(res, true); return }
      await this.relays.run(
        async signal => await this.ctx.phoneDevices.startCapture({
          deviceId: deviceId(grant.deviceId), format: grant.format, captureId: grant.captureId, signal,
        }),
        sink,
        lifetime.signal,
        multipart ? normalizeMultipartImageStream : body => body,
      )
    } finally {
      signal.removeEventListener('abort', transactionAbort)
      req.off('aborted', abort)
      res.off('close', close)
    }
  }

  private async dispatchIo(ws: { send(data: string): void }, raw: unknown, signal: AbortSignal): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw)) as unknown
    } catch {
      safeWebSocketSend(ws, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      safeWebSocketSend(ws, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } })
      return
    }
    const record = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    const id = Number.isSafeInteger(record.id) && (record.id as number) > 0 ? record.id as number : null
    if (record.jsonrpc !== '2.0' || id === null) {
      safeWebSocketSend(ws, { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } })
      return
    }
    try {
      const request = parseIoRequest(record.method, record.params)
      await this.ctx.phoneDevices.io(request, signal)
      if (!signal.aborted) safeWebSocketSend(ws, { jsonrpc: '2.0', id, result: { status: 'ok' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof PhoneDevicesError && error.code === 'PHONE_DEVICE_NOT_FOUND'
        ? -32010
        : -32000
      if (!signal.aborted) safeWebSocketSend(ws, { jsonrpc: '2.0', id, error: { code, message } })
    }
  }

  private writeFailure(res: ServerResponse, error: unknown): void {
    if (this.closing || res.headersSent || res.writableEnded) return
    if (error instanceof HttpError) {
      writeHttpError(res, error)
      return
    }
    if (error instanceof PhoneDevicesError && error.code === 'PHONE_DEVICE_NOT_FOUND') {
      writeHttpError(res, new HttpError(404, 'not-found', error.message))
      return
    }
    if (error instanceof PhoneDevicesError) {
      writeJson(res, error.code === 'PHONE_AGENT_PROFILE_REQUIRED' ? 409 : 502, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.issue === undefined ? {} : { issue: error.issue }),
        },
      })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    writeHttpError(res, new HttpError(502, 'upstream', message))
  }
}

function resolvePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`phone-stream: ${name} must be a positive safe integer`)
  }
  return value
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url as string, 'http://dsh.internal').pathname
}

function parseCapturePath(pathname: string): { readonly deviceId: string; readonly format: string } | undefined {
  const rest = pathname.slice(PHONE_STREAM_PATH.length + 1)
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
  if (typeof method !== 'string') {
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
      return {
        deviceId: id,
        method: 'tap',
        x: requireInteger(record.x, 'x'),
        y: requireInteger(record.y, 'y'),
        source: captureSource(record),
      }
    case 'swipe':
      return {
        deviceId: id,
        method: 'swipe',
        x1: requireInteger(record.x1, 'x1'),
        y1: requireInteger(record.y1, 'y1'),
        x2: requireInteger(record.x2, 'x2'),
        y2: requireInteger(record.y2, 'y2'),
        source: captureSource(record),
      }
    case 'text':
      if (typeof record.text !== 'string') throw new HttpError(400, 'bad-request', 'text is required')
      return { deviceId: id, method: 'text', text: record.text }
    case 'button':
      if (typeof record.button !== 'string' || record.button.length === 0) {
        throw new HttpError(400, 'bad-request', 'button is required')
      }
      return { deviceId: id, method: 'button', button: record.button }
    default:
      throw new HttpError(400, 'bad-request', `unsupported phone io method ${JSON.stringify(method)}`)
  }
}

function captureSource(record: Record<string, unknown>): {
  readonly kind: 'capture'
  readonly captureWidth: number
  readonly captureHeight: number
  readonly captureId: PhoneCaptureId
  readonly captureFormat: PhoneCaptureFormat
  readonly captureRotation?: 0 | 90 | 180 | 270
} {
  if (record.kind !== 'capture') {
    throw new HttpError(400, 'bad-request', 'coordinate input kind must be capture')
  }
  const widthPresent = record.captureWidth !== undefined
  const heightPresent = record.captureHeight !== undefined
  if (!widthPresent || !heightPresent) {
    throw new HttpError(400, 'bad-request', 'captureWidth and captureHeight must be sent together')
  }
  const captureWidth = requirePositiveInteger(record.captureWidth, 'captureWidth')
  const captureHeight = requirePositiveInteger(record.captureHeight, 'captureHeight')
  if (typeof record.captureId !== 'string' || record.captureId.length === 0) {
    throw new HttpError(400, 'bad-request', 'captureId is required')
  }
  const captureId = phoneCaptureId(record.captureId)
  if (record.captureFormat !== 'mjpeg' && record.captureFormat !== 'h264') {
    throw new HttpError(400, 'bad-request', 'captureFormat must be mjpeg or h264')
  }
  const rotation = record.captureRotation
  if (record.captureFormat === 'mjpeg' && rotation !== undefined) {
    throw new HttpError(400, 'bad-request', 'MJPEG coordinate input cannot supply captureRotation')
  }
  if (rotation !== undefined && rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new HttpError(400, 'bad-request', 'captureRotation must be 0, 90, 180, or 270')
  }
  return {
    kind: 'capture',
    captureWidth,
    captureHeight,
    captureId,
    captureFormat: record.captureFormat,
    ...(rotation === undefined ? {} : { captureRotation: rotation }),
  }
}

async function cleanupDeadline(cleanup: Promise<void>, timeoutMs: number): Promise<'settled' | 'timeout'> {
  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => { resolve('timeout') }, timeoutMs)
    void cleanup.finally(() => { clearTimeout(timer) })
  })
  return await Promise.race([
    cleanup.then(() => 'settled' as const),
    timeout,
  ])
}

function safeWebSocketSend(ws: { readonly readyState?: number; send(data: string): void }, payload: unknown): void {
  if (ws.readyState !== undefined && ws.readyState !== 1) return
  try { ws.send(JSON.stringify(payload)) } catch { /* a concurrent close drops the terminal reply */ }
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'bad-request', `${name} must be an integer`)
  }
  return value
}

function requirePositiveInteger(value: unknown, name: string): number {
  const integer = requireInteger(value, name)
  if (integer <= 0) throw new HttpError(400, 'bad-request', `${name} must be a positive integer`)
  return integer
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
