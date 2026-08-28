import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { connectDesktopRelayNodeHelper } from '../src/relay-node-helper.ts'

const fixtures = new URL('../../../packages/platform/remote-access-http/tests/fixtures/', import.meta.url)
const cert = fileURLToPath(new URL('localhost-cert.pem', fixtures))
const key = fileURLToPath(new URL('localhost-key.pem', fixtures))
const helperPath = fileURLToPath(new URL('../src/relay-node-helper-worker.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('Desktop Relay system-Node helper', () => {
  it('carries bounded binary frames through an HTTP CONNECT proxy and joins on close', async () => {
    const { url, server, sockets } = await wssEndpoint()
    const proxy = await connectProxy()
    const socket = await connectDesktopRelayNodeHelper({
      nodePath: process.execPath,
      helperPath,
      execArgv: ['--import', import.meta.resolve('tsx/esm')],
      environment: { NODE_EXTRA_CA_CERTS: cert },
      url,
      proxyUrl: `http://127.0.0.1:${String(port(proxy))}`,
      signal: new AbortController().signal,
      limits: { maxBytes: 1024, maxMessages: 4 },
    })
    const messages = socket.messages()[Symbol.asyncIterator]()
    try {
      expect((await messages.next()).value).toEqual(Uint8Array.of(1, 2, 3))
      await socket.send(Uint8Array.of(4, 5, 6))
      expect((await messages.next()).value).toEqual(Uint8Array.of(4, 5, 6))
    } finally {
      await socket.close()
    }
    expect((await messages.next()).done).toBe(true)
    expect(sockets.size).toBe(0)
    expect(server.listening).toBe(true)
  })
})

async function wssEndpoint(): Promise<{
  url: string
  server: HttpsServer
  sockets: Set<import('ws').WebSocket>
}> {
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) })
  const wss = new WebSocketServer({ server })
  const sockets = new Set<import('ws').WebSocket>()
  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    socket.on('message', (value) => { socket.send(value) })
    socket.send(Uint8Array.of(1, 2, 3))
  })
  await listen(server, 'localhost')
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate()
    await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
    await close(server)
  })
  return { url: `wss://localhost:${String(port(server))}`, server, sockets }
}

async function connectProxy(): Promise<HttpServer> {
  const server = createHttpServer()
  const clients = new Set<import('node:stream').Duplex>()
  const upstreams = new Set<import('node:net').Socket>()
  server.on('connect', (request, client, head) => {
    clients.add(client)
    client.once('close', () => { clients.delete(client) })
    const [host, port] = request.url?.split(':') ?? []
    if (host === undefined || port === undefined) { client.destroy(); return }
    const upstream = connect({ host, port: Number(port) })
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
