/** Local two-instance Platform listen for development Mobile and Desktop clients. */

import { randomBytes as secureRandomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer, request as httpsRequest, type Server } from 'node:https'
import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  loadPlatformEnvironment,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import * as PlatformAccountHttp from '@deepseek-ai/dsh-platform-account-http'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  DevelopmentKeylessPairingHandshakeProvider,
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  parseRelayInstanceId,
  type RemoteRelayConfig,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteRelayProvider } from '@deepseek-ai/dsh-remote-access/relay-provider'
import * as RemoteAccessHttp from '@deepseek-ai/dsh-remote-access-http'
import { RelayWebSocketConsumer } from '@deepseek-ai/dsh-remote-access-http'
import { RedisRelayCoordinator, type RelayRedisClient } from '@deepseek-ai/dsh-remote-access-redis'
import { REMOTE_PROTOCOL_LIMITS, type RelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import z from '@deepseek-ai/schemastery'

const CERT_DIR = fileURLToPath(new URL('../../two-instance-relay/fixtures/', import.meta.url))

/** Client and provider tunables for the local two-instance composition. */
export interface LocalCompanionListenConfig extends RemoteRelayConfig {
  attachTimeoutMs: number
  heartbeatIntervalMs: number
  inboundMaxBytes: number
  inboundMaxMessages: number
  reconnectDelayMs: number
}

/** Validated listen tunables; production supplies the same choices from deployment config. */
export const Config: z<LocalCompanionListenConfig> = z.object({
  attachTimeoutMs: z.natural().min(1).required(),
  capacityRetryAfterMs: z.natural().min(1).required(),
  deliveryAckTimeoutMs: z.natural().min(1).required(),
  directoryTtlMs: z.natural().min(1).required(),
  heartbeatIntervalMs: z.natural().min(1).required(),
  heartbeatTimeoutMs: z.natural().min(1).required(),
  inboundMaxBytes: z.natural().min(1).required(),
  inboundMaxMessages: z.natural().min(1).required(),
  maxBufferedCiphertextBytes: z.natural().min(1).required(),
  maxConnections: z.natural().min(1).required(),
  maxPendingDeliveries: z.natural().min(1).required(),
  reconnectDelayMs: z.natural().min(1).required(),
})

/** Human-scale loopback listen bounds. */
export const LOCAL_COMPANION_LISTEN_CONFIG: LocalCompanionListenConfig = {
  attachTimeoutMs: 10_000,
  capacityRetryAfterMs: 1_000,
  deliveryAckTimeoutMs: 5_000,
  directoryTtlMs: 30_000,
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 20_000,
  inboundMaxBytes: REMOTE_PROTOCOL_LIMITS.relayMessageBytes,
  inboundMaxMessages: 16,
  maxBufferedCiphertextBytes: 131_070,
  maxConnections: 32,
  maxPendingDeliveries: 32,
  reconnectDelayMs: 500,
}

/** Construction inputs for the local TLS front. */
export interface StartLocalCompanionPlatformOptions extends LocalCompanionListenConfig {
  /** Bind port; zero requests an OS-assigned port. */
  port?: number
  /** Optional Vite or static origin reverse-proxied for every non-`/v1` path. */
  pageOrigin?: string
  /** Sequential entropy keeps Loader snapshots stable; secure is the listen-bin default. */
  entropy?: 'secure' | 'sequential'
}

/** Running local Platform: one HTTPS origin, two HTTP instances, shared memory stores. */
export interface LocalCompanionPlatform {
  environment: SelectedPlatformEnvironment
  origin: string
  relayUrl: string
  acquired: string[]
  fetch: typeof fetch
  close(): Promise<void>
}

interface Backend {
  id: string
  port: number
  consumer: RelayWebSocketConsumer
  close(): Promise<void>
}

/** Start Account HTTP, Personal Pairing HTTP, and Relay WSS behind one loopback TLS endpoint. */
export async function startLocalCompanionPlatform(
  options: StartLocalCompanionPlatformOptions,
): Promise<LocalCompanionPlatform> {
  validateListenConfig(options)
  const config = options
  const [key, cert] = await Promise.all([
    readFile(`${CERT_DIR}localhost-key.pem`),
    readFile(`${CERT_DIR}localhost-cert.pem`),
  ])
  const acquired: string[] = []
  const server = createServer({ key, cert }, () => {})
  await listenTls(server, options.port ?? 0)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Local companion TLS endpoint did not bind a TCP port')
  }
  const origin = `https://127.0.0.1:${String(address.port)}`
  const environment = loadPlatformEnvironment({
    selection: 'development',
    development: {
      origin,
      callbackUrl: `${origin}/v1/account/oauth/github/callback`,
      githubClientId: 'gestalt-local-companion-development',
      credentialReference: 'credentials://github-oauth/local-companion-development',
      databaseIdentity: 'gestalt-local-companion-development',
      identityNamespace: 'gestalt-local-companion-development',
    },
    production: {
      origin: 'https://www.gestaltrun.com',
      callbackUrl: 'https://www.gestaltrun.com/v1/account/oauth/github/callback',
      githubClientId: 'Ov23lip9LTmnFuFpFeeV',
      credentialReference: 'credentials://github-oauth/production',
      databaseIdentity: 'gestalt',
      identityNamespace: 'gestalt-production',
    },
  })
  const entropy = createEntropy(options.entropy ?? 'secure')
  const backend = new MemoryAccountBackend(environment.databaseIdentity)
  const invalidation = new MemoryAccountInvalidationBus()
  const github = createDevelopmentGithub(environment)
  const authority = new MemoryPersonalPairingAuthorityStore()
  const routeStore = new MemoryRelayRouteStore()
  const bus = new MemoryRelayBus()
  const page = options.pageOrigin === undefined ? undefined : new URL(options.pageOrigin)
  if (page !== undefined && (page.protocol !== 'http:' && page.protocol !== 'https:')) {
    await closeServer(server)
    throw new TypeError('Local companion page origin must be HTTP or HTTPS')
  }
  let backends: Backend[]
  try {
    backends = [
      await startBackend('platform-a', environment, github, backend, invalidation, authority, routeStore, bus, config, entropy, 11),
      await startBackend('platform-b', environment, github, backend, invalidation, authority, routeStore, bus, config, entropy, 29),
    ]
  } catch (error) {
    await closeServer(server)
    throw error
  }
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    const path = pathname(req)
    if (path === '/healthz' || path === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (path.startsWith('/v1/')) {
      const selected = backends[acquired.length % backends.length]
      if (selected === undefined) {
        res.writeHead(503)
        res.end()
        return
      }
      acquired.push(selected.id)
      proxyHttp(req, res, selected.port, '127.0.0.1', page === undefined ? undefined : {
        from: page.origin,
        to: environment.origin,
      })
      return
    }
    if (page !== undefined) {
      proxyHttp(req, res, Number(page.port === '' ? (page.protocol === 'https:' ? 443 : 80) : page.port), page.hostname)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DeepSeek Gestalt</title>'
      + '<body><main><p>Set LOCAL_COMPANION_PAGE_ORIGIN to the Mobile Vite origin.</p></main></body></html>',
    )
  })
  server.on('upgrade', (req, socket, head) => {
    if (pathname(req) !== '/v1/remote-access/relay') {
      socket.destroy()
      return
    }
    const selected = backends[acquired.length % backends.length]
    if (selected === undefined) {
      socket.destroy()
      return
    }
    acquired.push(selected.id)
    selected.consumer.handleUpgrade(req, socket, head)
  })
  let open = true
  return {
    environment,
    origin,
    relayUrl: `${origin.replace('https:', 'wss:')}/v1/remote-access/relay`,
    acquired,
    fetch: createInsecureHttpsFetch(),
    close: async () => {
      if (!open) return
      open = false
      const results = await Promise.allSettled([
        ...backends.reverse().map(async (item) => { await item.close() }),
        closeServer(server),
      ])
      throwRejected(results, 'Local companion Platform failed to close')
    },
  }
}

/** Fetch that accepts the bundled loopback certificate and follows HTTPS redirects. */
export function createInsecureHttpsFetch(): typeof fetch {
  const fetchHttps = async (input: RequestInfo | URL, init?: RequestInit, redirects = 0): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer())
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => { headers[key] = value })
    const response = await new Promise<Response>((resolve, reject) => {
      const upstream = httpsRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        rejectUnauthorized: false,
      }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk) => { chunks.push(chunk as Buffer) })
        incoming.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') responseHeaders.set(key, value)
            else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '))
          }
          const status = incoming.statusCode ?? 502
          resolve(new Response(
            status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks),
            { status, headers: responseHeaders },
          ))
        })
      })
      upstream.on('error', reject)
      if (body !== undefined) upstream.write(body)
      upstream.end()
    })
    const location = response.headers.get('location')
    if (location === null || redirects >= 5 || ![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }
    return await fetchHttps(new URL(location, request.url), { method: 'GET' }, redirects + 1)
  }
  return (input, init) => fetchHttps(input, init)
}

/** Reject heartbeat and inbound combinations that cannot keep a live directory entry. */
export function validateListenConfig(config: LocalCompanionListenConfig): void {
  if (config.heartbeatIntervalMs >= Math.min(config.directoryTtlMs, config.heartbeatTimeoutMs)) {
    throw new TypeError('Relay heartbeatIntervalMs must be less than directoryTtlMs and heartbeatTimeoutMs')
  }
  if (config.inboundMaxBytes < REMOTE_PROTOCOL_LIMITS.relayMessageBytes) {
    throw new TypeError('Relay inboundMaxBytes must admit one maximum Relay message')
  }
}

async function startBackend(
  id: string,
  environment: SelectedPlatformEnvironment,
  github: GitHubIdentityProvider,
  backend: MemoryAccountBackend,
  invalidation: MemoryAccountInvalidationBus,
  authority: MemoryPersonalPairingAuthorityStore,
  routeStore: MemoryRelayRouteStore,
  bus: MemoryRelayBus,
  config: LocalCompanionListenConfig,
  entropy: Entropy,
  randomByte: number,
): Promise<Backend> {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const account = new PlatformAccount(ctx, {
    backend,
    invalidation,
    github,
    environment,
    config: {
      tokenSigningKey: Buffer.alloc(32, 7),
      pollingSigningKey: Buffer.alloc(32, 9),
    },
  })
  await ctx.plugin(PlatformAccountHttp, { origin: environment.origin })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/v1/account/oauth/github/development-complete',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', environment.origin)
      try {
        await account.completeGitHubCallback({
          code: 'development-keyless',
          state: requiredQuery(url, 'state'),
        })
        res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        res.end()
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(error instanceof Error ? error.message : 'development login failed')
      }
    },
  }))
  const coordinator = new RedisRelayCoordinator({
    command: bus.client(),
    subscriber: bus.client(),
    keyPrefix: 'dsh:local-companion:relay',
  })
  const relay = new RemoteRelayProvider(ctx, {
    instanceId: parseRelayInstanceId(id),
    routeStore,
    coordinator,
    config: {
      capacityRetryAfterMs: config.capacityRetryAfterMs,
      deliveryAckTimeoutMs: config.deliveryAckTimeoutMs,
      directoryTtlMs: config.directoryTtlMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      maxBufferedCiphertextBytes: config.maxBufferedCiphertextBytes,
      maxConnections: config.maxConnections,
      maxPendingDeliveries: config.maxPendingDeliveries,
    },
    randomBytes: size => entropy.randomBytes(size, randomByte),
  })
  new PersonalPairingProvider(ctx, {
    account,
    handshake: new DevelopmentKeylessPairingHandshakeProvider(),
    relay,
    authority,
    randomBytes: size => entropy.randomBytes(size, randomByte),
    randomId: kind => entropy.randomId(kind),
    pairingLinkOrigin: `${environment.origin}/pair`,
  })
  await ctx.plugin(RemoteAccessHttp, { origin: environment.origin })
  const consumer = new RelayWebSocketConsumer(ctx, config.attachTimeoutMs)
  return {
    id,
    port: ctx.webServer.port,
    consumer,
    close: async () => {
      const results = await Promise.allSettled([consumer.close(), relay.dispose(), ctx.fiber.dispose()])
      throwRejected(results, `Local companion backend ${id} failed to close`)
    },
  }
}

function createDevelopmentGithub(environment: SelectedPlatformEnvironment): GitHubIdentityProvider {
  return {
    environment,
    authorizationUrl(input) {
      if (input.callbackUrl !== environment.callbackUrl) {
        throw new TypeError('GitHub OAuth callback does not match the configured fixed callback')
      }
      const url = new URL('/v1/account/oauth/github/development-complete', environment.origin)
      url.searchParams.set('state', input.state)
      return url.href
    },
    async exchange() {
      return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
    },
  }
}

interface Entropy {
  randomBytes(size: number, salt: number): Uint8Array
  randomId(kind: 'challenge' | 'pairing' | 'principal' | 'completion' | 'relay-route'): string
}

function createEntropy(mode: 'secure' | 'sequential'): Entropy {
  let allocation = 0
  let id = 0
  return {
    randomBytes(size, salt) {
      if (mode === 'secure') return new Uint8Array(secureRandomBytes(size))
      allocation += 1
      return new Uint8Array(size).fill((salt + allocation) % 256)
    },
    randomId(kind) {
      id += 1
      return mode === 'secure' ? `${kind}-${crypto.randomUUID()}` : `${kind}-${String(id)}`
    },
  }
}

class MemoryRelayRouteStore {
  private readonly routes = new Map<string, {
    authorities: Map<string, 'mobile' | 'desktop'>
    revision: number
    revoked: boolean
  }>()

  async rotate(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const revision = (this.routes.get(routeId)?.revision ?? 0) + 1
    const authorities = new Map(this.routes.get(routeId)?.authorities ?? [])
    for (const [value, owner] of authorities) if (owner === endpoint) authorities.delete(value)
    authorities.set(Buffer.from(digest).toString('hex'), endpoint)
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }

  async issue(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number | undefined> {
    const route = this.routes.get(routeId)
    if (route === undefined || route.revoked) return undefined
    route.authorities.set(Buffer.from(digest).toString('hex'), endpoint)
    return route.revision
  }

  async authorize(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number | undefined> {
    const route = this.routes.get(routeId)
    return route !== undefined && !route.revoked
      && route.authorities.get(Buffer.from(digest).toString('hex')) === endpoint
      ? route.revision : undefined
  }

  async revokeCredential(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', digest: Uint8Array): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    const encoded = Buffer.from(digest).toString('hex')
    if (authorities.get(encoded) === endpoint) authorities.delete(encoded)
    this.routes.set(routeId, { authorities, revision, revoked: current?.revoked ?? true })
    return revision
  }

  async revoke(routeId: RelayRouteId): Promise<number> {
    const revision = (this.routes.get(routeId)?.revision ?? 0) + 1
    this.routes.set(routeId, { authorities: new Map(), revision, revoked: true })
    return revision
  }
}

class MemoryRelayBus {
  private readonly values = new Map<string, string>()
  private readonly subscriptions = new Map<string, Set<(message: string) => void>>()

  client(): RelayRedisClient {
    const client: RelayRedisClient = {
      get: async key => this.values.get(key) ?? null,
      set: async (key, value, _options) => { this.values.set(key, value); return 'OK' },
      eval: async (_script, options) => {
        const key = options.keys[0]
        if (key === undefined) return 0
        const value = this.values.get(key)
        if (value === undefined) return 0
        const record = JSON.parse(value) as { connectionToken?: string }
        if (record.connectionToken !== options.arguments[0]) return 0
        const replacement = options.arguments[1]
        if (replacement === undefined) this.values.delete(key)
        else this.values.set(key, replacement)
        return 1
      },
      publish: async (channel, message) => {
        const listeners = [...(this.subscriptions.get(channel) ?? [])]
        for (const listener of listeners) listener(message)
        return listeners.length
      },
      subscribe: async (channel, listener) => {
        const listeners = this.subscriptions.get(channel) ?? new Set()
        listeners.add(listener)
        this.subscriptions.set(channel, listeners)
      },
      unsubscribe: async (channel, listener) => { this.subscriptions.get(channel)?.delete(listener) },
      withAbortSignal: () => client,
    }
    return client
  }
}

function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  hostname = '127.0.0.1',
  cors?: { from: string; to: string },
): void {
  const headers = { ...req.headers }
  delete headers.connection
  if (cors !== undefined && headers.origin === cors.from) headers.origin = cors.to
  const options: RequestOptions = {
    hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  }
  const upstream = httpRequest(options, (incoming) => {
    const incomingHeaders = { ...incoming.headers }
    if (cors !== undefined && incomingHeaders['access-control-allow-origin'] === cors.to) {
      incomingHeaders['access-control-allow-origin'] = cors.from
    }
    res.writeHead(incoming.statusCode ?? 502, incomingHeaders)
    incoming.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(upstream)
}

function pathname(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'https://127.0.0.1').pathname
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value === '') throw new TypeError(`${name} is required`)
  return value
}

function listenTls(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

function throwRejected(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length === 1) throw errorFromUnknown(errors[0])
  if (errors.length > 1) throw new AggregateError(errors, message)
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}
