import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopSystemNodeFetch } from '../src/system-node-fetch-helper.ts'

const fixtures = new URL('../../../packages/platform/remote-access-http/tests/fixtures/', import.meta.url)
const cert = fileURLToPath(new URL('localhost-cert.pem', fixtures))
const key = fileURLToPath(new URL('localhost-key.pem', fixtures))
const helperPath = fileURLToPath(new URL('../src/system-node-fetch-helper-worker.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('Desktop Platform HTTP system-Node helper', () => {
  it('round-trips bounded HTTPS through the Electron-resolved HTTP CONNECT proxy', async () => {
    const endpoint = await httpsEndpoint()
    const proxy = await connectProxy()
    const resolveProxy = vi.fn(async () => `PROXY 127.0.0.1:${String(port(proxy))}`)
    const fetch = createDesktopSystemNodeFetch({
      nodePath: process.execPath,
      helperPath,
      execArgv: ['--import', import.meta.resolve('tsx/esm')],
      environment: { NODE_EXTRA_CA_CERTS: cert },
      resolveProxy,
      timeoutMs: 5_000,
    })

    const response = await fetch(`${endpoint.origin}/v1/account/login-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' },
      body: JSON.stringify({ operation: 'login' }),
      redirect: 'error',
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('x-test-response')).toBe('node-helper')
    expect(await response.json()).toEqual({ operation: 'login' })
    expect(endpoint.requests).toEqual([{
      method: 'POST',
      authorization: 'Bearer test-only',
      contentType: 'application/json',
      body: '{"operation":"login"}',
    }])
    expect(resolveProxy).toHaveBeenCalledWith(`${endpoint.origin}/v1/account/login-attempts`)
  })

  it('reconstructs HTTP 204 without a Fetch body', async () => {
    const endpoint = await httpsNoContentEndpoint()
    const fetch = createDesktopSystemNodeFetch({
      nodePath: process.execPath,
      helperPath,
      execArgv: ['--import', import.meta.resolve('tsx/esm')],
      environment: { NODE_EXTRA_CA_CERTS: cert },
      resolveProxy: async () => 'DIRECT',
      timeoutMs: 5_000,
    })

    const response = await fetch(`${endpoint.origin}/v1/projects/presence/heartbeat`, {
      method: 'POST',
      redirect: 'error',
    })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('rejects redirects and unsupported bodies before sending credentials', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT')
    const fetch = createDesktopSystemNodeFetch({
      nodePath: process.execPath,
      helperPath,
      execArgv: ['--import', import.meta.resolve('tsx/esm')],
      resolveProxy,
      timeoutMs: 100,
    })

    await expect(fetch('https://example.com', { redirect: 'follow' })).rejects.toThrow('redirects must be disabled')
    await expect(fetch('https://example.com', { method: 'PUT' })).rejects.toThrow('method is unsupported')
    await expect(fetch('http://example.com')).rejects.toThrow('credential-free HTTPS')
    expect(resolveProxy).not.toHaveBeenCalled()
  })
})

async function httpsNoContentEndpoint(): Promise<{ origin: string }> {
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    response.writeHead(204)
    response.end()
  })
  await listen(server, 'localhost')
  cleanups.push(async () => { await close(server) })
  return { origin: `https://localhost:${String(port(server))}` }
}

async function httpsEndpoint(): Promise<{
  origin: string
  requests: Array<{ method: string; authorization?: string; contentType?: string; body: string }>
}> {
  const requests: Array<{ method: string; authorization?: string; contentType?: string; body: string }> = []
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.once('end', () => {
      requests.push({
        method: request.method ?? '',
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        ...(request.headers['content-type'] === undefined ? {} : { contentType: request.headers['content-type'] }),
        body: Buffer.concat(chunks).toString(),
      })
      response.writeHead(201, { 'content-type': 'application/json', 'x-test-response': 'node-helper' })
      response.end(Buffer.concat(chunks))
    })
  })
  await listen(server, 'localhost')
  cleanups.push(async () => { await close(server) })
  return { origin: `https://localhost:${String(port(server))}`, requests }
}

async function connectProxy(): Promise<HttpServer> {
  const server = createHttpServer()
  const clients = new Set<import('node:stream').Duplex>()
  const upstreams = new Set<import('node:net').Socket>()
  server.on('connect', (request, client, head) => {
    clients.add(client)
    client.once('close', () => { clients.delete(client) })
    const [host, targetPort] = request.url?.split(':') ?? []
    if (host === undefined || targetPort === undefined) { client.destroy(); return }
    const upstream = connect({ host, port: Number(targetPort) })
    upstreams.add(upstream)
    upstream.once('close', () => { upstreams.delete(upstream) })
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.byteLength > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => { client.destroy() })
    client.on('error', () => { upstream.destroy() })
  })
  await listen(server, '127.0.0.1')
  cleanups.push(async () => {
    for (const client of clients) client.destroy()
    for (const upstream of upstreams) upstream.destroy()
    await close(server)
  })
  return server
}

async function listen(server: HttpsServer | HttpServer, host: string): Promise<void> {
  server.listen(0, host)
  await once(server, 'listening')
}

async function close(server: HttpsServer | HttpServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

function port(server: HttpsServer | HttpServer): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}
