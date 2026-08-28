/**
 * JSON-RPC 2.0 client over HTTP for one loopback mobilecli `/rpc` endpoint,
 * plus normalization of transport failures onto the public error vocabulary.
 * Method names follow the upstream OpenRPC specification (`devices.list`,
 * `device.boot`, `device.shutdown`, `server.info`); this module owns no other
 * mobilecli behavior.
 * @module @deepseek-ai/dsh-phone-runtime/rpc
 */

import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { PhoneDevicesError } from './errors.ts'

/** Upstream JSON-RPC error code naming a missing device (mobilecli `-32010`). */
const DEVICE_NOT_FOUND_CODE = -32010

/** System error codes whose presence means the server socket is gone. */
const CONNECTIVITY_CODES: readonly string[] = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND']

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
   *   `PHONE_DEVICE_NOT_FOUND` for upstream `-32010`, or whatever
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
      const record = body.error as { code?: unknown; message?: unknown }
      const code = typeof record.code === 'number' ? record.code : undefined
      const message = typeof record.message === 'string' ? record.message : 'upstream error'
      if (code === DEVICE_NOT_FOUND_CODE) {
        throw new PhoneDevicesError('PHONE_DEVICE_NOT_FOUND', `no device answers that id upstream: ${message}`)
      }
      throw new PhoneDevicesError(
        'PHONE_UPSTREAM',
        `mobilecli rejected ${JSON.stringify(method)}${code === undefined ? '' : ` (${String(code)})`}: ${message}`,
      )
    }
    return body.result
  }

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
