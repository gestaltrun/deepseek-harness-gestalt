/** Typed loopback RPC from Desktop Host to its bundled Web Host. */

import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  REMOTE_PROTOCOL_LIMITS,
  type CompanionHostFailure,
} from '@deepseek-ai/dsh-remote-protocol'

const DEFAULT_HOST_RPC_TIMEOUT_MS = 15_000
const MAX_HOST_ATTACHMENT_RESPONSE_BYTES = Math.ceil(
  REMOTE_PROTOCOL_LIMITS.imageChunkBytes * REMOTE_PROTOCOL_LIMITS.imageChunks / 3,
) * 4 + REMOTE_PROTOCOL_LIMITS.companionMessageBytes

/** Unary Host call result after HTTP, JSON, envelope, and business validation. */
export type DesktopHostRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; failure: CompanionHostFailure }

/** Node HTTP client for the Desktop-owned Web Host loopback API. */
export interface DesktopHostRpc {
  /**
   * Invoke one unary Host method without throwing Host HTTP, wire, business, or timeout failures.
   * @param method - Host RPC method and `/api/<method>` path.
   * @param payload - JSON payload for the method.
   * @returns validated value or a stable failure for Companion projection.
   */
  call(
    method: string,
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number; rpcId?: string },
  ): Promise<DesktopHostRpcResult>
  /**
   * Settle one Host-originated Approval or Ask User request by its private rpc identity.
   * @param rpcId - exact id received from the current Host event stream.
   * @param result - domain result shell accepted by `/api/respond`.
   * @returns Host carrier receipt.
   */
  respond?(
    rpcId: string,
    result: Record<string, unknown>,
  ): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }>
  /**
   * Follow only Host pending-interaction envelopes from the mux stream.
   * @param signal - current Web Host generation lifetime.
   * @param accept - validated later by the pairing-neutral interaction registry.
   */
  watchInteractions?(
    signal: AbortSignal,
    accept: (envelope: { rpcId: string; payload: unknown }) => void,
  ): Promise<void>
}

/** Desktop Host RPC construction options. */
export interface DesktopHostRpcOptions {
  /** Wall-clock deadline for one unary Host request. */
  timeoutMs?: number
  /** Maximum accumulated response bytes; cannot exceed the Companion application-message ceiling. */
  responseMaxBytes: number
  /** Wall-clock deadline for one maximum-size local attachment admission. */
  attachmentTimeoutMs?: number
}

/**
 * Build the Desktop-owned loopback Host RPC client.
 * @param baseUrl - Web Host loopback origin printed at spawn.
 * @param options - request deadline.
 * @returns typed unary client.
 */
export function createDesktopHostRpc(baseUrl: string, options: DesktopHostRpcOptions): DesktopHostRpc {
  const origin = new URL(baseUrl)
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOST_RPC_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Desktop Host RPC timeoutMs must be a positive safe integer')
  }
  const responseMaxBytes = options.responseMaxBytes
  if (options.attachmentTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.attachmentTimeoutMs) || options.attachmentTimeoutMs <= 0)) {
    throw new TypeError('Desktop Host RPC attachmentTimeoutMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(responseMaxBytes) || responseMaxBytes <= 0
    || responseMaxBytes > REMOTE_PROTOCOL_LIMITS.companionMessageBytes) {
    throw new TypeError('Desktop Host RPC responseMaxBytes must be a positive safe integer within the Companion message ceiling')
  }
  return {
    async call(method, payload, callOptions) {
      const attachmentRead = method === 'session.attachment'
      const callTimeoutMs = callOptions?.timeoutMs
        ?? (attachmentRead ? options.attachmentTimeoutMs : undefined)
        ?? timeoutMs
      if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs <= 0) {
        throw new TypeError('Desktop Host RPC call timeoutMs must be a positive safe integer')
      }
      const rpcId = callOptions?.rpcId ?? randomUUID()
      const response = await requestJson(
        new URL(`/api/${method}`, origin),
        { type: 'client-request', rpcId, method, payload },
        callTimeoutMs,
        attachmentRead ? MAX_HOST_ATTACHMENT_RESPONSE_BYTES : responseMaxBytes,
      )
      if (response.kind === 'timeout') {
        return { ok: false, failure: { kind: 'timeout', code: 'HOST_TIMEOUT', message: 'Desktop Host request timed out' } }
      }
      if (response.kind === 'transport') {
        return { ok: false, failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response transport failed' } }
      }
      if (response.kind === 'limit') {
        return { ok: false, failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response exceeded its byte limit' } }
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          failure: {
            kind: 'http',
            code: 'HOST_HTTP_STATUS',
            message: `Desktop Host returned HTTP ${String(response.status)}`,
            status: response.status,
          },
        }
      }
      let body: unknown
      try {
        body = JSON.parse(response.text) as unknown
      } catch {
        return {
          ok: false,
          failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response was not valid RPC JSON' },
        }
      }
      return parseServerResponse(body, rpcId)
    },
    async respond(rpcId, result) {
      const response = await requestJson(
        new URL('/api/respond', origin),
        { type: 'client-response', rpcId, result },
        timeoutMs,
        responseMaxBytes,
      )
      if (response.kind !== 'response' || response.status < 200 || response.status >= 300) {
        throw new Error('Desktop Host interaction response transport failed')
      }
      const value: unknown = JSON.parse(response.text)
      if (!isRecord(value) || typeof value.accepted !== 'boolean') {
        throw new Error('Desktop Host interaction receipt was invalid')
      }
      if (value.accepted && Object.keys(value).length === 1) return { accepted: true }
      if (!value.accepted && Object.keys(value).length === 2
        && (value.reason === 'not-pending' || value.reason === 'bad-response')) {
        return { accepted: false, reason: value.reason }
      }
      throw new Error('Desktop Host interaction receipt was invalid')
    },
    async watchInteractions(signal, accept) {
      const response = await fetch(new URL('/api/events.mux', origin), { signal })
      if (!response.ok || response.body === null) throw new Error('Desktop Host interaction stream failed to open')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const readResult: unknown = await reader.read()
          if (!isRecord(readResult) || typeof readResult.done !== 'boolean') {
            throw new Error('Desktop Host interaction stream returned an invalid read result')
          }
          if (readResult.done) return
          if (!(readResult.value instanceof Uint8Array)) {
            throw new Error('Desktop Host interaction stream returned an invalid byte chunk')
          }
          buffer += decoder.decode(readResult.value, { stream: true })
          if (new TextEncoder().encode(buffer).byteLength > REMOTE_PROTOCOL_LIMITS.companionMessageBytes) {
            throw new Error('Desktop Host interaction stream frame exceeded its byte ceiling')
          }
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = chunk.split('\n').filter(line => line.startsWith('data: '))
              .map(line => line.slice(6)).join('')
            if (data === '') continue
            const envelope: unknown = JSON.parse(data)
            if (!isRecord(envelope) || envelope.type !== 'server-request'
              || typeof envelope.rpcId !== 'string' || !('payload' in envelope)) {
              throw new Error('Desktop Host interaction stream envelope was invalid')
            }
            accept({ rpcId: envelope.rpcId, payload: envelope.payload })
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    },
  }
}

function parseServerResponse(body: unknown, rpcId: string): DesktopHostRpcResult {
  if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)) {
    return {
      ok: false,
      failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response did not match the RPC request' },
    }
  }
  const result = body.result
  if (result.ok === true) return { ok: true, value: result.value }
  if (result.ok !== false || !isRecord(result.error)) {
    return {
      ok: false,
      failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response did not contain an RPC result' },
    }
  }
  const code = typeof result.error.code === 'string' && result.error.code !== ''
    ? result.error.code
    : 'host-error'
  const message = typeof result.error.message === 'string' && result.error.message !== ''
    ? result.error.message
    : 'Desktop Host rejected the request'
  return { ok: false, failure: { kind: 'business', code, message } }
}

type RequestOutcome =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'timeout' }
  | { kind: 'transport' }
  | { kind: 'limit' }

function requestJson(url: URL, body: unknown, timeoutMs: number, responseMaxBytes: number): Promise<RequestOutcome> {
  const encoded = JSON.stringify(body)
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: RequestOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(outcome)
    }
    const upstream = startRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(encoded)),
      },
    }, (incoming) => {
      incoming.on('error', () => { settle({ kind: 'transport' }) })
      const status = incoming.statusCode ?? 500
      if (status < 200 || status >= 300) {
        settle({ kind: 'response', status, text: '' })
        incoming.destroy()
        upstream.destroy()
        return
      }
      const chunks: Buffer[] = []
      let receivedBytes = 0
      incoming.on('data', (chunk) => {
        if (settled) return
        const bytes = Buffer.from(chunk as Uint8Array)
        receivedBytes += bytes.byteLength
        if (receivedBytes > responseMaxBytes) {
          settle({ kind: 'limit' })
          incoming.destroy()
          upstream.destroy()
          return
        }
        chunks.push(bytes)
      })
      incoming.on('end', () => {
        if (settled) return
        settle({
          kind: 'response',
          status,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    const deadline = setTimeout(() => {
      settle({ kind: 'timeout' })
      upstream.destroy()
    }, timeoutMs)
    deadline.unref()
    upstream.on('error', () => { settle({ kind: 'transport' }) })
    upstream.end(encoded)
  })
}

function startRequest(
  url: URL,
  options: RequestOptions,
  onResponse: (incoming: IncomingMessage) => void,
) {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    ...options,
  }, onResponse)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
