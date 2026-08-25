/** HTTPS upload/consume/revoke Consumer for the encrypted attachment blob store. */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { CorsOriginPolicy, writeRetryAfterError } from '@deepseek-ai/dsh-host-webserver'
import { RemoteAccessError, type PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseAttachmentCapability, type AttachmentCapability } from '@deepseek-ai/dsh-remote-protocol'
import z from '@deepseek-ai/schemastery'
import {
  RemoteAttachmentError,
  type RemoteAttachmentErrorCode,
  type RemoteAttachmentQuotaReservation,
} from './index.ts'

const MAX_JSON_BYTES = 4 * 1024

/** HTTP Consumer configuration. */
export interface Config {
  /** Exact product origins allowed to call the routes. */
  origins: string[]
}
/** Validated HTTP Consumer configuration. */
export const Config: z<Config> = z.object({ origins: z.array(z.string()).min(1).required() })
/** Cordis plugin name. */
export const name = 'remote-attachments-http'
/** Required blob store, pairing authority, and HTTP route registry. */
export const inject = ['webServer', 'remoteAttachments', 'remoteAttachmentAuthority']

/**
 * Pairing scope seam: the Personal Pairing layer authenticates one HTTPS request
 * to exactly one Personal Pairing. Implementations never see attachment bytes.
 */
export interface RemoteAttachmentAuthority {
  /**
   * Authenticate one attachment request to its owning Personal Pairing.
   * @param input - complete untrusted request headers.
   * @returns pairing authority plus Account-complete blob admission.
   */
  authenticate(input: { headers: IncomingHttpHeaders }): Promise<{
    pairingId: PersonalPairingId
    admit(bytes: number): Promise<RemoteAttachmentQuotaReservation>
  }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteAttachmentAuthority: RemoteAttachmentAuthority
  }
}

const STORE_FAILURE_STATUS: Record<RemoteAttachmentErrorCode, number> = {
  ATTACHMENT_CAPABILITY_INVALID: 404,
  ATTACHMENT_EMPTY: 400,
  ATTACHMENT_EXPIRED: 410,
  ATTACHMENT_PAIRING_MISMATCH: 403,
  ATTACHMENT_LIMIT_EXCEEDED: 413,
  ATTACHMENT_CAPACITY: 503,
  PLATFORM_CAPACITY: 429,
}

type AttachmentRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  authorization: Awaited<ReturnType<RemoteAttachmentAuthority['authenticate']>>,
) => Promise<void>

/** Register the bounded attachment blob routes over the mounted blob store. */
export function apply(ctx: Context, config: Config): void {
  const origins = new CorsOriginPolicy(config.origins, 'Remote Attachments HTTP')
  const store = ctx.remoteAttachments
  /** Wrap one route with the shared CORS, method, pairing-authentication, and failure preludes. */
  const route = (handle: AttachmentRouteHandler) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (handleCors(req, res, origins)) return
        if (req.method !== 'POST') throw new RemoteAttachmentHttpError(405, 'METHOD_NOT_ALLOWED', 'Remote Attachments route requires POST')
        await handle(req, res, await ctx.remoteAttachmentAuthority.authenticate({ headers: req.headers }))
      } catch (error) {
        answerError(res, error)
      }
    }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/v1/remote-attachments',
    handler: route(async (req, res, authorization) => {
      const byteLength = parseUploadLength(req.headers['content-length'], store.maxBlobBytes)
      const quota = await authorization.admit(byteLength)
      let ciphertext: Buffer
      try {
        ciphertext = await readExact(req, byteLength)
      } catch (error) {
        try {
          await quota.release()
        } catch (cleanupError) {
          console.error('[remote-attachments-http] quota release after rejected upload failed:', cleanupError)
        }
        throw error
      }
      const grant = await store.publish({
        pairingId: authorization.pairingId,
        ciphertext: new Uint8Array(ciphertext),
        now: Date.now(),
        quota,
      })
      answerJson(res, 201, {
        capability: grant.capability,
        byteLength: grant.byteLength,
        expiresAt: grant.expiresAt,
      })
    }),
  }), 'remote-attachments: upload route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/v1/remote-attachments/consume',
    handler: route(async (req, res, authorization) => {
      const body = await readJson(req)
      const capability = parseCapability(body.capability)
      const consumption = await store.consume({ pairingId: authorization.pairingId, capability, now: Date.now() })
      let delivered = false
      try {
        await writeOctetStream(res, consumption.ciphertext)
        delivered = true
        await consumption.complete()
      } catch (error) {
        if (!delivered) await consumption.abandon(Date.now())
        throw error
      }
    }),
  }), 'remote-attachments: consume route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/v1/remote-attachments/revoke',
    handler: route(async (req, res, authorization) => {
      const body = await readJson(req)
      await store.revoke({ pairingId: authorization.pairingId, capability: parseCapability(body.capability) })
      res.writeHead(204).end()
    }),
  }), 'remote-attachments: revoke route')
}

function parseUploadLength(value: string | string[] | undefined, limit: number): number {
  if (value === undefined) {
    throw new RemoteAttachmentHttpError(411, 'CONTENT_LENGTH_REQUIRED', 'Remote attachment upload requires Content-Length')
  }
  if (value === '0') {
    throw new RemoteAttachmentError('ATTACHMENT_EMPTY', 'Remote attachment ciphertext must not be empty')
  }
  if (Array.isArray(value) || !/^[1-9]\d*$/.test(value)) {
    throw new RemoteAttachmentHttpError(400, 'CONTENT_LENGTH_INVALID', 'Remote attachment Content-Length must be a positive integer')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) {
    throw new RemoteAttachmentHttpError(400, 'CONTENT_LENGTH_INVALID', 'Remote attachment Content-Length must be a positive safe integer')
  }
  if (length > limit) {
    throw new RemoteAttachmentHttpError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Remote attachment exceeds the per-blob byte ceiling')
  }
  return length
}

async function readExact(req: IncomingMessage, length: number): Promise<Buffer> {
  const body = Buffer.allocUnsafe(length)
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    if (buffer.byteLength > length - received) {
      throw new RemoteAttachmentHttpError(400, 'CONTENT_LENGTH_MISMATCH', 'Remote attachment body exceeds Content-Length')
    }
    buffer.copy(body, received)
    received += buffer.byteLength
  }
  if (received !== length) {
    throw new RemoteAttachmentHttpError(400, 'CONTENT_LENGTH_MISMATCH', 'Remote attachment body is shorter than Content-Length')
  }
  return body
}

function parseCapability(value: unknown): AttachmentCapability {
  if (typeof value !== 'string') throw new RemoteAttachmentHttpError(400, 'BODY_INVALID', 'capability must be a string')
  try {
    return parseAttachmentCapability(value)
  } catch {
    throw new RemoteAttachmentHttpError(400, 'BODY_INVALID', 'capability must be 43 canonical base64url characters')
  }
}

async function readBounded(
  req: IncomingMessage,
  limit: number,
  exceed: () => RemoteAttachmentHttpError,
): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw exceed()
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    received += buffer.byteLength
    if (received > limit) throw exceed()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBounded(req, MAX_JSON_BYTES, () =>
    new RemoteAttachmentHttpError(413, 'BODY_TOO_LARGE', 'Remote Attachments body is too large'))
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw new RemoteAttachmentHttpError(400, 'BODY_INVALID', 'Remote Attachments body must be JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteAttachmentHttpError(400, 'BODY_INVALID', 'Remote Attachments body must be an object')
  }
  return value as Record<string, unknown>
}

function handleCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: CorsOriginPolicy): boolean {
  const requestOrigin = req.headers.origin
  if (requestOrigin !== undefined) {
    const parsedOrigin = allowedOrigins.match(requestOrigin)
    if (parsedOrigin === undefined) {
      throw new RemoteAttachmentHttpError(403, 'ORIGIN_DENIED', 'Remote Attachments request origin is not trusted')
    }
    res.setHeader('access-control-allow-origin', parsedOrigin)
    res.setHeader('vary', 'Origin')
  }
  if (req.method !== 'OPTIONS') return false
  res.writeHead(204, {
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-gestalt-pairing-selector,x-gestalt-proof-jti,x-gestalt-proof-issued-at,x-gestalt-proof-signature',
    'access-control-max-age': '600',
  })
  res.end()
  return true
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const

function answerJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(value))
}

function answerError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return
  if (error instanceof RemoteAccessError) {
    writeRetryAfterError(res, error, error.code === 'QUOTA' || error.code === 'PLATFORM_CAPACITY' ? 429 : 409)
    return
  }
  const storeError = remoteAttachmentFailure(error)
  if (storeError?.code === 'PLATFORM_CAPACITY') {
    writeRetryAfterError(res, storeError, 429)
    return
  }
  const { status, body } = toFailureView(error)
  answerJson(res, status, body)
}

/** Write one ciphertext body and settle only after the response finishes. */
function writeOctetStream(res: ServerResponse, ciphertext: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = (): void => {
      res.off('error', fail)
      res.off('finish', succeed)
      res.off('close', closed)
    }
    const fail = (error: unknown): void => {
      clear()
      reject(error instanceof Error ? error : new Error('Remote attachment consume response failed'))
    }
    const succeed = (): void => {
      clear()
      resolve()
    }
    const closed = (): void => {
      if (res.writableFinished) succeed()
      else fail(new Error('Remote attachment consume response closed before finish'))
    }
    res.once('error', fail)
    res.once('finish', succeed)
    res.once('close', closed)
    try {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(ciphertext)
    } catch (error) {
      fail(error)
    }
  })
}

function toFailureView(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  const storeError = remoteAttachmentFailure(error)
  if (storeError !== undefined) {
    return { status: STORE_FAILURE_STATUS[storeError.code], body: { error: storeError } }
  }
  if (error instanceof RemoteAttachmentHttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } }
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Remote Attachments request failed' } } }
}

function remoteAttachmentFailure(error: unknown): {
  code: RemoteAttachmentErrorCode
  message: string
  retryAfter?: number
} | undefined {
  if (error instanceof RemoteAttachmentError) {
    return { code: error.code, message: error.message, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }) }
  }
  if (typeof error !== 'object' || error === null || !('code' in error) || !('message' in error)) return undefined
  const { code, message } = error
  if (typeof code !== 'string' || !(code in STORE_FAILURE_STATUS) || typeof message !== 'string') return undefined
  return { code: code as RemoteAttachmentErrorCode, message }
}

/** HTTP admission failure that an injected attachment authority may return to the route. */
export class RemoteAttachmentHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteAttachmentHttpError'
  }
}
