/** One-request HTTPS worker for Desktop's official Node runtime. */

import { request } from 'node:https'
import type { ClientRequest, IncomingHttpHeaders } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'

const MAX_HEADER_BYTES = 64 * 1024
const MAX_HEADER_COUNT = 128

type ParentMessage = {
  type: 'fetch'
  url: string
  method: 'GET' | 'POST' | 'DELETE'
  headers: readonly (readonly [string, string])[]
  body?: Uint8Array
  proxyUrl?: string
  maxResponseBytes: number
}

type WorkerMessage =
  | {
    type: 'response'
    status: number
    statusText: string
    headers: Array<[string, string]>
    body: Uint8Array
  }
  | { type: 'error'; code?: string; name?: string; stage: 'request' | 'response' | 'parent-message' }

let activeRequest: ClientRequest | undefined
let settling = false

process.once('message', (value: unknown) => { run(value) })
process.once('disconnect', () => {
  settling = true
  activeRequest?.destroy()
  process.exit(0)
})

function run(value: unknown): void {
  let message: ParentMessage
  try { message = parseMessage(value) }
  catch (error) { fail(error, 'parent-message'); return }
  const target = new URL(message.url)
  const agent = message.proxyUrl === undefined ? undefined : proxyAgent(message.proxyUrl)
  const outgoing = request(target, {
    method: message.method,
    headers: Object.fromEntries(message.headers),
    maxHeaderSize: MAX_HEADER_BYTES,
    ...(agent === undefined ? {} : { agent }),
  }, (response) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    response.on('data', (chunk: Buffer) => {
      byteLength += chunk.byteLength
      if (byteLength > message.maxResponseBytes) {
        response.destroy(Object.assign(new Error('Desktop Platform HTTP response exceeds its byte limit'), {
          code: 'ERR_RESPONSE_TOO_LARGE',
        }))
        return
      }
      chunks.push(chunk)
    })
    response.once('error', (error) => { fail(error, 'response') })
    response.once('end', () => {
      if (settling) return
      const status = response.statusCode
      if (status === undefined) { fail(new Error('Desktop Platform HTTP response has no status'), 'response'); return }
      const headers = responseHeaders(response.headers)
      settling = true
      void sendAndExit({
        type: 'response', status, statusText: response.statusMessage ?? '', headers,
        body: Buffer.concat(chunks, byteLength),
      }, 0)
    })
  })
  activeRequest = outgoing
  outgoing.once('error', (error) => { fail(error, 'request') })
  outgoing.end(message.body)
}

function parseMessage(value: unknown): ParentMessage {
  if (!isRecord(value) || value.type !== 'fetch' || typeof value.url !== 'string'
    || !['GET', 'POST', 'DELETE'].includes(String(value.method))
    || !Number.isSafeInteger(value.maxResponseBytes) || Number(value.maxResponseBytes) < 1
    || (value.body !== undefined && !(value.body instanceof Uint8Array))
    || (value.proxyUrl !== undefined && typeof value.proxyUrl !== 'string')) {
    throw new TypeError('Desktop Platform HTTP helper message is invalid')
  }
  const target = new URL(value.url)
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') {
    throw new TypeError('Desktop Platform HTTP target must be credential-free HTTPS')
  }
  const headers = parseHeaders(value.headers)
  return {
    type: 'fetch', url: target.href, method: value.method as ParentMessage['method'], headers,
    maxResponseBytes: Number(value.maxResponseBytes),
    ...(value.body === undefined ? {} : { body: value.body }),
    ...(value.proxyUrl === undefined ? {} : { proxyUrl: value.proxyUrl }),
  }
}

function parseHeaders(value: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(value) || value.length > MAX_HEADER_COUNT) throw new TypeError('Desktop Platform HTTP headers are invalid')
  let bytes = 0
  const headers: Array<readonly [string, string]> = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw new TypeError('Desktop Platform HTTP headers are invalid')
    }
    bytes += Buffer.byteLength(entry[0]) + Buffer.byteLength(entry[1])
    if (bytes > MAX_HEADER_BYTES) throw new TypeError('Desktop Platform HTTP headers exceed their byte limit')
    headers.push([entry[0], entry[1]])
  }
  return headers
}

function proxyAgent(value: string): HttpsProxyAgent<string> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new TypeError('Desktop Platform HTTP proxy must be credential-free HTTP or HTTPS')
  }
  return new HttpsProxyAgent(url)
}

function responseHeaders(source: IncomingHttpHeaders): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) result.push([name, item])
    } else result.push([name, value])
  }
  return result
}

function fail(error: unknown, stage: Extract<WorkerMessage, { type: 'error' }>['stage']): void {
  if (settling) return
  settling = true
  activeRequest?.destroy()
  const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)
    ? error.code : undefined
  const name = error instanceof Error && /^[A-Za-z]{1,64}$/u.test(error.name) ? error.name : undefined
  void sendAndExit({
    type: 'error', stage,
    ...(code === undefined ? {} : { code }),
    ...(name === undefined ? {} : { name }),
  }, 1)
}

async function sendAndExit(message: WorkerMessage, code: number): Promise<void> {
  if (process.send !== undefined && process.connected) {
    await new Promise<void>((resolve) => { process.send?.(message, () => { resolve() }) })
  }
  process.exit(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
