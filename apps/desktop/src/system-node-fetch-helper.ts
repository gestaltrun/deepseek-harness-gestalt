/** Bounded official-Node HTTPS adapter for Desktop Platform requests. */

import { fork, type ChildProcess } from 'node:child_process'
import { REMOTE_PROTOCOL_LIMITS } from '@deepseek-ai/dsh-remote-protocol'
import { desktopNodeHelperEnvironment } from './node-helper-environment.ts'
import { desktopRelayProxyCandidates } from './system-network.ts'

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes

type FetchMessage = {
  type: 'fetch'
  url: string
  method: 'GET' | 'POST' | 'DELETE'
  headers: readonly (readonly [string, string])[]
  body?: Uint8Array
  proxyUrl?: string
  maxResponseBytes: number
}

type HelperMessage =
  | {
    type: 'response'
    status: number
    statusText: string
    headers: Array<[string, string]>
    body: Uint8Array
  }
  | { type: 'error'; code?: string; name?: string; stage: 'request' | 'response' | 'parent-message' }

export interface DesktopSystemNodeFetchOptions {
  nodePath: string
  helperPath: string
  resolveProxy(url: string): Promise<string>
  timeoutMs: number
  /** Test-only TypeScript loader arguments. Production runs the bundled helper. */
  execArgv?: readonly string[]
  /** Test-only environment additions such as a local certificate authority. */
  environment?: Readonly<NodeJS.ProcessEnv>
}

/**
 * Build the Fetch subset used by Desktop Platform Account, pairing, and attachment clients.
 * @param options - official Node path, helper bundle, Electron proxy resolver, and deadline.
 * @returns HTTPS-only Fetch adapter with bounded request and response bodies.
 */
export function createDesktopSystemNodeFetch(options: DesktopSystemNodeFetchOptions): typeof fetch {
  return async (input, init) => {
    const url = parseUrl(input)
    const method = parseMethod(init?.method)
    if (init?.redirect !== undefined && init.redirect !== 'error') {
      throw new TypeError('Desktop Platform HTTP redirects must be disabled')
    }
    const body = requestBody(init?.body)
    const headers = new Headers(init?.headers)
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
    if (body !== undefined && !headers.has('content-length')) headers.set('content-length', String(body.byteLength))
    const message: FetchMessage = {
      type: 'fetch', url: url.href, method, headers: [...headers.entries()], maxResponseBytes: MAX_RESPONSE_BYTES,
      ...(body === undefined ? {} : { body }),
    }
    const signal = init?.signal ?? new AbortController().signal
    const rules = await deadline(options.resolveProxy(url.href), signal, options.timeoutMs, 'proxy')
    const candidates = desktopRelayProxyCandidates(rules)
    const end = Date.now() + options.timeoutMs
    let lastFailure: unknown
    for (const [index, candidate] of candidates.entries()) {
      const remainingMs = end - Date.now()
      if (remainingMs <= 0) throw new Error('Desktop Platform HTTP proxy acquisition timed out')
      const candidateMessage = {
        ...message,
        ...(candidate.proxyUrl === undefined ? {} : { proxyUrl: candidate.proxyUrl }),
      }
      try {
        const response = await deadline(
          runCandidate(options, candidateMessage, signal),
          signal,
          Math.max(1, Math.floor(remainingMs / (candidates.length - index))),
          'request',
        )
        const responseBody = [204, 205, 304].includes(response.status)
          ? null
          : Uint8Array.from(response.body).buffer
        return new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch (error) {
        lastFailure = error
        if (signal.aborted || index === candidates.length - 1 || !isProxyFallbackFailure(error)) throw error
      }
    }
    throw new Error('Desktop Platform HTTP proxy list had no connection candidate', { cause: lastFailure })
  }
}

async function runCandidate(
  options: DesktopSystemNodeFetchOptions,
  message: FetchMessage,
  signal: AbortSignal,
): Promise<Extract<HelperMessage, { type: 'response' }>> {
  const child = fork(options.helperPath, [], {
    execPath: options.nodePath,
    execArgv: [...options.execArgv ?? []],
    env: desktopNodeHelperEnvironment(process.env, options.environment),
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.resume()
  const result = deferred<Extract<HelperMessage, { type: 'response' }>>()
  const closed = deferred<void>()
  let settled = false
  const settle = (operation: () => void): void => {
    if (settled) return
    settled = true
    operation()
  }
  child.on('message', (value: unknown) => {
    try {
      const parsed = parseHelperMessage(value)
      if (parsed.type === 'response') settle(() => { result.resolve(parsed) })
      else settle(() => { result.reject(helperError(parsed)) })
    } catch {
      settle(() => { result.reject(new Error('Desktop Platform HTTP helper response is invalid')) })
    }
  })
  child.once('error', (error) => { settle(() => { result.reject(error) }) })
  child.once('close', () => {
    settle(() => { result.reject(new Error('Desktop Platform HTTP helper exited before responding')) })
    closed.resolve()
  })
  const abort = (): void => { child.kill() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    await send(child, message)
    return await result.promise
  } finally {
    signal.removeEventListener('abort', abort)
    child.kill()
    await closed.promise
  }
}

function parseUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) throw new TypeError('Desktop Platform HTTP does not accept Request objects')
  const url = new URL(typeof input === 'string' ? input : input.href)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('Desktop Platform HTTP target must be credential-free HTTPS')
  }
  return url
}

function parseMethod(value: string | undefined): FetchMessage['method'] {
  const method = (value ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'POST' || method === 'DELETE') return method
  throw new TypeError(`Desktop Platform HTTP method is unsupported: ${method}`)
}

function requestBody(value: BodyInit | null | undefined): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? new Uint8Array(value)
      : value instanceof ArrayBuffer ? new Uint8Array(value)
        : undefined
  if (bytes === undefined) throw new TypeError('Desktop Platform HTTP body type is unsupported')
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new TypeError('Desktop Platform HTTP request exceeds its byte limit')
  return bytes
}

function parseHelperMessage(value: unknown): HelperMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('Desktop Platform HTTP helper response is invalid')
  if (value.type === 'error') {
    if (!['request', 'response', 'parent-message'].includes(String(value.stage))) throw new TypeError('invalid stage')
    if (value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(value.code))) throw new TypeError('invalid code')
    if (value.name !== undefined && (typeof value.name !== 'string' || !/^[A-Za-z]{1,64}$/u.test(value.name))) throw new TypeError('invalid name')
    return {
      type: 'error', stage: value.stage as Extract<HelperMessage, { type: 'error' }>['stage'],
      ...(value.code === undefined ? {} : { code: value.code }),
      ...(value.name === undefined ? {} : { name: value.name }),
    }
  }
  if (value.type !== 'response' || !Number.isInteger(value.status) || Number(value.status) < 100
    || Number(value.status) > 599 || typeof value.statusText !== 'string'
    || !(value.body instanceof Uint8Array) || value.body.byteLength > MAX_RESPONSE_BYTES
    || !Array.isArray(value.headers)) throw new TypeError('Desktop Platform HTTP helper response is invalid')
  const headers = new Headers()
  for (const entry of value.headers) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw new TypeError('Desktop Platform HTTP helper headers are invalid')
    }
    headers.append(entry[0], entry[1])
  }
  return {
    type: 'response', status: Number(value.status), statusText: value.statusText,
    headers: [...headers.entries()], body: new Uint8Array(value.body),
  }
}

function helperError(message: Extract<HelperMessage, { type: 'error' }>): Error {
  return Object.assign(
    new Error(`Desktop Platform HTTP helper failed at ${message.stage}${message.name === undefined ? '' : `: ${message.name}`}`),
    message.code === undefined ? {} : { code: message.code },
  )
}

function deadline<T>(source: Promise<T>, signal: AbortSignal, timeoutMs: number, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      operation()
    }
    const abort = (): void => { finish(() => { reject(new DOMException('Desktop Platform HTTP was cancelled', 'AbortError')) }) }
    const timer = setTimeout(() => { finish(() => { reject(new Error(`Desktop Platform HTTP ${stage} timed out`)) }) }, timeoutMs)
    timer.unref()
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void source.then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(error instanceof Error ? error : new Error('Desktop Platform HTTP failed')) }) },
    )
  })
}

function isProxyFallbackFailure(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return false
  return ['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT']
    .includes(error.code)
}

function send(child: ChildProcess, message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child.connected) { reject(new Error('Desktop Platform HTTP helper is closed')); return }
    child.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
