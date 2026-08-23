import { request as httpsRequest } from 'node:https'

/** Hang bound for loopback HTTPS in the Electron main process. */
const LOOPBACK_REQUEST_TIMEOUT_MS = 10_000

/** True when the URL names a loopback HTTPS listen that presents a bundled test certificate. */
export function isLoopbackListenUrl(url: string): boolean {
  const parsed = new URL(url)
  return (parsed.protocol === 'https:' || parsed.protocol === 'wss:')
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
}

/** Fetch face used by Account and Remote Access transports. */
export type LoopbackListenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Fetch that accepts the bundled loopback listen certificate.
 * @param origin - selected Platform environment origin.
 * @returns a Fetch implementation, or `undefined` when the origin is not loopback HTTPS.
 */
export function createLoopbackListenFetch(origin: string): LoopbackListenFetch | undefined {
  if (!isLoopbackListenUrl(origin)) return undefined
  return createInsecureHttpsFetch()
}

/**
 * Complete a loopback authorization URL in-process without following the browser return Location;
 * otherwise open the system browser.
 * @param url - GitHub or local-companion authorization URL.
 * @param openExternal - system-browser opener for non-loopback URLs.
 */
export async function openDesktopAuthorizationUrl(
  url: string,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  if (!isLoopbackListenUrl(url)) {
    await openExternal(url)
    return
  }
  const response = await requestLoopback(new URL(url), 'GET')
  if (response.status >= 400) {
    throw new Error(`loopback authorization returned ${String(response.status)}`)
  }
}

function createInsecureHttpsFetch(): LoopbackListenFetch {
  const fetchHttps = async (
    input: string | URL | Request,
    init?: RequestInit,
    redirects = 0,
  ): Promise<Response> => {
    const request = typeof Request === 'function' && input instanceof Request ? input : undefined
    const url = request === undefined
      ? new URL(input instanceof URL ? input.href : input)
      : new URL(request.url)
    const method = request === undefined ? (init?.method ?? 'GET') : request.method
    const headers = request === undefined ? headerRecord(init?.headers) : headerRecord(request.headers)
    const body = request === undefined ? bodyBuffer(method, init?.body) : await requestBody(method, request)
    const response = await requestLoopback(url, method, headers, body)
    const location = response.headers.get('location')
    if (location === null || redirects >= 5 || ![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }
    return await fetchHttps(new URL(location, url), { method: 'GET' }, redirects + 1)
  }
  return (input, init) => fetchHttps(input, init)
}

function requestLoopback(
  url: URL,
  method: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const upstream = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: body === undefined ? headers : { ...headers, 'content-length': String(body.length) },
      rejectUnauthorized: false,
      timeout: LOOPBACK_REQUEST_TIMEOUT_MS,
    }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      incoming.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') headers[key] = value
          else if (Array.isArray(value)) headers[key] = value.join(', ')
        }
        const status = incoming.statusCode ?? 502
        resolve(new LoopbackResponse(
          status,
          headers,
          status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks),
        ) as Response)
      })
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      reject(new Error('loopback HTTPS request timed out'))
    })
    upstream.on('error', reject)
    if (body !== undefined) upstream.write(body)
    upstream.end()
  })
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {}
  if (headers === undefined) return record
  if (typeof Headers === 'function' && headers instanceof Headers) {
    headers.forEach((value, key) => { record[key] = value })
    return record
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers as readonly (readonly [string, string])[]) record[key] = value
    return record
  }
  return { ...headers as Record<string, string> }
}

/** In-memory Response so Electron main never constructs a Chromium Body. */
class LoopbackResponse {
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  private readonly body: Buffer | null

  constructor(status: number, headers: Record<string, string>, body: Buffer | null) {
    this.status = status
    this.ok = status >= 200 && status < 300
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value
    this.headers = { get: name => normalized[name.toLowerCase()] ?? null }
    this.body = body
  }

  json(): Promise<unknown> {
    return Promise.resolve(JSON.parse((this.body ?? Buffer.alloc(0)).toString('utf8')) as unknown)
  }

  text(): Promise<string> {
    return Promise.resolve((this.body ?? Buffer.alloc(0)).toString('utf8'))
  }
}

async function requestBody(method: string, request: Request): Promise<Buffer | undefined> {
  if (method === 'GET' || method === 'HEAD') return undefined
  return Buffer.from(await request.arrayBuffer())
}

function bodyBuffer(method: string, body: unknown): Buffer | undefined {
  if (method === 'GET' || method === 'HEAD' || body == null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  throw new TypeError('loopback Fetch body must be a string or bytes')
}
