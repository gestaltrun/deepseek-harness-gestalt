/**
 * JSON-RPC 2.0 client over HTTP for one loopback mobilecli `/rpc` endpoint,
 * plus normalization of transport failures onto the public error vocabulary.
 * Method names follow the upstream OpenRPC specification (`devices.list`,
 * `device.boot`, `device.shutdown`, `server.info`, `device.io.*`,
 * `device.screencapture`); this module owns no other mobilecli behavior.
 * The capture answer follows both upstream shapes: the bare byte stream and
 * mobilecli 1.0.5's `{ format, sessionUrl }` envelope, whose session URL is
 * resolved against the server origin and forced back onto the loopback fence
 * before the stream is opened.
 * @module @deepseek-ai/dsh-phone-runtime/rpc
 */

import { isLoopbackHostname } from '@deepseek-ai/dsh-request-trust'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { realDeviceIssueError } from './classify.ts'
import { PhoneDevicesError } from './errors.ts'

/** Upstream JSON-RPC error code naming a missing device (mobilecli `-32010`). */
const DEVICE_NOT_FOUND_CODE = -32010

/** System error codes whose presence means the server socket is gone. */
const CONNECTIVITY_CODES: readonly string[] = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND']

/**
 * Map one parsed JSON-RPC error envelope onto the public failure. The
 * `-32010` arm stays `PHONE_DEVICE_NOT_FOUND` so Host 404 semantics survive;
 * every other message classifies onto the structured real-device arms first.
 * @param method - Upstream OpenRPC method that was rejected.
 * @param error - The parsed JSON-RPC `error` envelope value.
 * @returns the public failure to throw.
 */
function jsonRpcError(method: string, error: unknown): PhoneDevicesError {
  const record = error as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'number' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : 'upstream error'
  if (code === DEVICE_NOT_FOUND_CODE) {
    return new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', `no device answers that id upstream: ${message}`)
  }
  return upstreamRejection(method, code, message)
}

/**
 * Build the public failure for one upstream JSON-RPC error message. A message
 * naming a structured real-device arm becomes `PHONE_REAL_DEVICE_ISSUE`; the
 * `-32010` arm stays `PHONE_DEVICE_NOT_FOUND` so Host 404 semantics survive.
 * @param method - Upstream OpenRPC method that was rejected.
 * @param code - Upstream error code, `undefined` when the envelope omitted it.
 * @param message - Upstream error text.
 * @returns the public failure to throw.
 */
function upstreamRejection(method: string, code: number | undefined, message: string): PhoneDevicesError {
  const described = `mobilecli rejected ${JSON.stringify(method)}: ${message}`
  const issueError = realDeviceIssueError(described)
  if (issueError !== undefined) return issueError
  return new PhoneDevicesError(
    'PHONE_UPSTREAM',
    `mobilecli rejected ${JSON.stringify(method)}${code === undefined ? '' : ` (${String(code)})`}: ${message}`,
  )
}

/** One loopback JSON-RPC client. */
export class MobilecliRpc {
  private nextId = 1

  /**
   * @param baseUrl - Loopback origin such as `http://127.0.0.1:12000`.
   */
  constructor(readonly baseUrl: string) {}

  /**
   * Run one JSON-RPC request against `/rpc`.
   * @param method - Upstream OpenRPC method name.
   * @param params - Params object exactly as the method documents them.
   * @param signal - Fused caller-and-deadline signal that stops the round trip.
   * @returns the parsed `result` field, `undefined` when the notification-style result is nullish.
   * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` for non-2xx responses or
   *   unparseable bodies, `PHONE_UPSTREAM` carrying the upstream code and message,
   *   `PHONE_REAL_DEVICE_ISSUE` when the upstream message names a structured
   *   real-device arm, `PHONE_DEVICE_NOT_FOUND` for upstream `-32010`, or whatever
   *   {@link normalizeOperationError} makes of a transport failure.
   */
  async call(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        // connection: close keeps a dead server's socket out of the pool, so a
        // later round trip refuses instantly instead of stalling to its ceiling.
        headers: { 'content-type': 'application/json', accept: 'application/json', connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal,
      })
    } catch (error) {
      throw normalizeOperationError(error)
    }
    const body = await this.readBody(response)
    if ('error' in body && body.error !== null && typeof body.error === 'object') {
      throw jsonRpcError(method, body.error)
    }
    return body.result
  }

  /**
   * POST one JSON-RPC request whose successful answer is a byte stream
   * (`device.screencapture`). Both upstream answer shapes are accepted: the
   * bare byte stream, and mobilecli 1.0.5's `{ format, sessionUrl }` JSON
   * envelope whose session URL is resolved against the server origin, forced
   * back onto the loopback fence, and dialed for the actual stream. JSON-RPC
   * errors still arrive as a JSON body and map onto the same public vocabulary
   * as {@link call}.
   * @param method - Upstream OpenRPC method name.
   * @param params - Params object exactly as the method documents them.
   * @param signal - Fused caller-and-deadline signal that stops header wait.
   * @returns the upstream content type and unread body; the caller owns cancellation.
   */
  async stream(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly contentType: string; readonly body: ReadableStream<Uint8Array> }> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: '*/*', connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal,
      })
    } catch (error) {
      throw normalizeOperationError(error)
    }
    const headerType = response.headers.get('content-type')
    const contentType = headerType === null ? '' : headerType
    if (contentType.includes('application/json')) {
      const body = await this.readBody(response)
      if ('error' in body && body.error !== null && typeof body.error === 'object') {
        throw jsonRpcError(method, body.error)
      }
      const sessionUrl = (body.result as { sessionUrl?: unknown } | null | undefined)?.sessionUrl
      if (typeof sessionUrl === 'string' && sessionUrl.length > 0) {
        return await this.streamSession(sessionUrl, signal)
      }
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli ${JSON.stringify(method)} answered JSON instead of a capture stream`,
      )
    }
    if (!response.ok) {
      try {
        await response.body?.cancel()
      } catch {
        // The unread capture body is already gone; the HTTP status is the failure.
      }
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli answered HTTP ${String(response.status)} instead of a capture stream`,
      )
    }
    /* v8 ignore next 4 -- node:fetch always attaches a body on a completed HTTP response */
    if (response.body === null) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', `mobilecli ${JSON.stringify(method)} answered no capture body`)
    }
    return { contentType, body: response.body }
  }

  /**
   * Dial the capture session endpoint a 1.0.5 envelope named. Relative URLs
   * resolve against the server origin; an absolute URL must stay on the
   * loopback fence, so a compromised server cannot redirect the Host proxy at
   * an internal endpoint.
   * @param sessionUrl - Session URL exactly as the envelope carried it.
   * @param signal - Fused caller-and-deadline signal that stops header wait.
   * @returns the session content type and unread body; the caller owns cancellation.
   */
  private async streamSession(
    sessionUrl: string,
    signal: AbortSignal,
  ): Promise<{ readonly contentType: string; readonly body: ReadableStream<Uint8Array> }> {
    let resolved: URL
    try {
      resolved = new URL(sessionUrl, this.baseUrl)
    } catch {
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli answered an unparseable capture session URL: ${JSON.stringify(sessionUrl)}`,
      )
    }
    if (resolved.protocol !== 'http:' || !isLoopbackHostname(resolved.hostname)) {
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli capture session URL ${JSON.stringify(sessionUrl)} leaves the loopback fence`,
      )
    }
    let session: Response
    try {
      session = await fetch(resolved, { headers: { accept: '*/*', connection: 'close' }, signal })
    } catch (error) {
      throw normalizeOperationError(error)
    }
    if (!session.ok) {
      try {
        await session.body?.cancel()
      } catch {
        // The unread session body is already gone; the HTTP status is the failure.
      }
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `the mobilecli capture session answered HTTP ${String(session.status)}`,
      )
    }
    const sessionType = session.headers.get('content-type')
    /* v8 ignore next 4 -- node:fetch always attaches a body on a completed HTTP response */
    if (session.body === null) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'the mobilecli capture session answered no body')
    }
    return { contentType: sessionType === null ? '' : sessionType, body: session.body }
  }

  /**
   * Parse one JSON-RPC HTTP body into `result` or `error`.
   * @param response - Completed fetch response whose body is JSON.
   * @returns the parsed JSON-RPC envelope.
   */
  async readBody(response: Response): Promise<{ result?: unknown; error?: unknown }> {
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw normalizeOperationError(error)
    }
    if (!response.ok) {
      throw new PhoneDevicesError(
        'PHONE_PROTOCOL',
        `mobilecli answered HTTP ${String(response.status)} instead of a JSON-RPC response`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'mobilecli response body is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || (!('result' in parsed) && !('error' in parsed))) {
      throw new PhoneDevicesError('PHONE_PROTOCOL', 'mobilecli response carries neither result nor error')
    }
    return parsed
  }
}

/**
 * Normalize one operation failure onto the public error vocabulary so callers
 * see only {@link PhoneDevicesError}: cancellation as `PHONE_ABORTED`, elapsed
 * ceilings as `PHONE_TIMEOUT`, dead sockets as `PHONE_UNAVAILABLE`.
 * @param error - Thrown value from a JSON-RPC round trip.
 * @returns the normalized public failure.
 */
export function normalizeOperationError(error: unknown): PhoneDevicesError {
  if (error instanceof PhoneDevicesError) return error
  if (error instanceof TimeoutReason) {
    return new PhoneDevicesError(
      'PHONE_TIMEOUT',
      `phone operation exceeded its ${String(error.timeoutMs)}ms ceiling (${error.code})`,
      { cause: error },
    )
  }
  const record = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null
  if (typeof record === 'object' && record !== null) {
    if (record.name === 'AbortError' || record.name === 'TimeoutError') {
      return new PhoneDevicesError('PHONE_ABORTED', 'phone operation was cancelled', { cause: error })
    }
    for (let cause: unknown = error; cause !== null && cause !== undefined; cause = readCause(cause)) {
      const code = (cause as { code?: unknown }).code
      if (typeof code === 'string' && CONNECTIVITY_CODES.includes(code)) {
        return new PhoneDevicesError(
          'PHONE_UNAVAILABLE',
          `the mobilecli server socket is gone (${code}); it exited or never came up`,
          { cause: error },
        )
      }
    }
    // undici reports transport-level failures it does not classify further as
    // bare "fetch failed" or "terminated"; on a loopback peer that is a lost
    // server unless it aborted or timed out.
    if (record.message === 'fetch failed' || record.message === 'terminated') {
      return new PhoneDevicesError(
        'PHONE_UNAVAILABLE',
        'the mobilecli server transport failed; it exited or never came up',
        { cause: error },
      )
    }
  }
  return new PhoneDevicesError('PHONE_PROTOCOL', 'phone operation failed unexpectedly', { cause: error })
}

function readCause(value: unknown): unknown {
  return (value as { cause?: unknown } | null | undefined)?.cause
}
