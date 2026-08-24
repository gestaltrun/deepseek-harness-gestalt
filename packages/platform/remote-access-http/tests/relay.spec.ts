import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  RemoteRelayError,
  type RemoteRelayAttachment,
  type RemoteRelayService,
} from '@deepseek-ai/dsh-remote-access'
import {
  decodeRelayMessage,
  deriveRelayCredentialPublicKey,
  encodeRelayMessage,
  generateRelayCredential,
  parseRelayAttachmentId,
  parseRelayRouteId,
  type RelayCiphertextMessage,
  type RelayHeartbeatMessage,
  type RelayMessage,
  RemoteProtocolError,
  signRelayAttachmentChallenge,
} from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type WebSocketServer } from 'ws'
import { apply, RelayWebSocketConsumer } from '../src/relay.ts'

const cleanup: Array<() => Promise<void>> = []
const TEST_CREDENTIAL = await generateRelayCredential()
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const errors = results.filter(result => result.status === 'rejected')
  if (errors.length > 0) throw new AggregateError(errors, 'test cleanup failed')
})

describe('RelayWebSocketConsumer', () => {
  it('bounds stalled pre-proof challenges and releases capacity on every socket close', async () => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay, 1_000, 1)
    const stalled = await connect(endpoint.url)
    await vi.waitFor(() => { expect(Reflect.get(endpoint.consumer, 'pendingChallenges')).toBe(1) })
    const shed = await connect(endpoint.url)
    const [code] = await once(shed, 'close') as [number]
    expect(code).toBe(1013)
    expect(relay.attach).not.toHaveBeenCalled()
    stalled.close()
    await once(stalled, 'close')
    await vi.waitFor(() => { expect(Reflect.get(endpoint.consumer, 'pendingChallenges')).toBe(0) })
    const admitted = await connect(endpoint.url)
    const { outcome } = await sendAttach(admitted)
    await expect(outcome).resolves.toMatchObject({ type: 'ready' })
    admitted.close()
    await once(admitted, 'close')
  })

  it('attaches first, exchanges ciphertext and heartbeat, and cleans up on close', async () => {
    const attachment = attachmentFixture()
    const relay = relayFixture(attachment)
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    const { outcome: ready } = await sendAttach(socket)
    await vi.waitFor(() => { expect(relay.attach).toHaveBeenCalledOnce() })
    expect(await ready).toEqual({
      type: 'ready', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
      attachmentId: parseRelayAttachmentId('mobile-one'), peers: [],
    })

    const ciphertext = ciphertextMessage()
    const heartbeat = heartbeatMessage()
    serverSocket(endpoint.consumer).binaryType = 'arraybuffer'
    socket.send(encodeRelayMessage(ciphertext))
    await vi.waitFor(() => { expect(attachment.receive).toHaveBeenCalledOnce() })
    serverSocket(endpoint.consumer).binaryType = 'fragments'
    socket.send(encodeRelayMessage(heartbeat))
    await vi.waitFor(() => { expect(attachment.receive).toHaveBeenCalledTimes(2) })
    expect(attachment.receive).toHaveBeenNthCalledWith(1, ciphertext)
    expect(attachment.receive).toHaveBeenNthCalledWith(2, heartbeat)

    const deliver = relay.attach.mock.calls[0]?.[0].deliver
    if (deliver === undefined) throw new Error('expected Relay deliver callback')
    const received = nextMessage(socket)
    await deliver(ciphertext)
    expect(await received).toEqual(ciphertext)

    socket.close()
    await once(socket, 'close')
    await vi.waitFor(() => { expect(attachment.close).toHaveBeenCalledOnce() })
  })

  it.each([
    { name: 'ciphertext before attach', first: ciphertextMessage(), code: 'RELAY_ATTACHMENT_REJECTED' },
    { name: 'heartbeat before attach', first: heartbeatMessage(), code: 'RELAY_ATTACHMENT_REJECTED' },
  ])('rejects $name', async ({ first, code }) => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    const error = nextMessage(socket)
    socket.send(encodeRelayMessage(first))
    expect(await error).toMatchObject({ type: 'error', code })
    await once(socket, 'close')
  })

  it('rejects a second attachment proof after attachment', async () => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    const { outcome: ready } = await sendAttach(socket)
    expect(await ready).toMatchObject({ type: 'ready' })
    const error = nextMessage(socket)
    await sendAttachRequest(socket)
    expect(await error).toMatchObject({ type: 'error', code: 'RELAY_ATTACHMENT_REJECTED' })
    await once(socket, 'close')
  })

  it('rejects an attachment proof replayed on another physical socket', async () => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay)
    const first = await connect(endpoint.url)
    const attached = await sendAttach(first)
    expect(await attached.outcome).toMatchObject({ type: 'ready' })
    const replay = await connect(endpoint.url)
    const replayChallenge = nextMessage(replay)
    await sendAttachRequest(replay)
    await replayChallenge
    const error = nextMessage(replay)
    replay.send(encodeRelayMessage(attached.proof))
    expect(await error).toMatchObject({ type: 'error', code: 'RELAY_ATTACHMENT_REJECTED' })
    await once(replay, 'close')
    first.close()
  })

  it.each([
    {
      name: 'capacity with retry metadata',
      failure: new RemoteRelayError('PLATFORM_CAPACITY', 'full', 250),
      expected: { code: 'PLATFORM_CAPACITY', retryAfterMs: 250 },
    },
    {
      name: 'revoked route without retry metadata',
      failure: new RemoteRelayError('RELAY_ROUTE_REVOKED', 'revoked'),
      expected: { code: 'RELAY_ROUTE_REVOKED' },
    },
    {
      name: 'unexpected provider failure',
      failure: new Error('private provider detail'),
      expected: { code: 'RELAY_ATTACHMENT_REJECTED' },
    },
  ])('maps $name to a content-free transport error', async ({ failure, expected }) => {
    const relay = relayFixture(attachmentFixture())
    relay.attach.mockRejectedValueOnce(failure)
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    const { outcome: error } = await sendAttach(socket)
    expect(await error).toMatchObject({ type: 'error', ...expected })
    await once(socket, 'close')
  })

  it('maps incompatible and malformed wire input without exposing decoder details', async () => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay)

    relay.attach.mockRejectedValueOnce(new RemoteProtocolError(
      'RELAY_TRANSPORT_INCOMPATIBLE',
      'no shared Relay Transport version',
    ))
    const incompatible = await connect(endpoint.url)
    const { outcome: incompatibleError } = await sendAttach(incompatible)
    expect(await incompatibleError).toMatchObject({ type: 'error', code: 'RELAY_TRANSPORT_INCOMPATIBLE' })
    await once(incompatible, 'close')

    const malformed = await connect(endpoint.url)
    const malformedError = nextMessage(malformed)
    malformed.send('{')
    malformed.send('{')
    expect(await malformedError).toMatchObject({ type: 'error', code: 'RELAY_ATTACHMENT_REJECTED' })
    await once(malformed, 'close')
  })

  it.each([
    new RemoteRelayError('RELAY_ROUTE_REVOKED', 'revoked'),
    new RemoteRelayError('REMOTE_OFFLINE', 'offline'),
  ])('reports an attached endpoint failure and applies its teardown policy', async (failure) => {
    const attachment = attachmentFixture()
    attachment.receive.mockRejectedValueOnce(failure)
    const relay = relayFixture(attachment)
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    const { outcome: ready } = await sendAttach(socket)
    await vi.waitFor(() => { expect(relay.attach).toHaveBeenCalledOnce() })
    expect(await ready).toMatchObject({ type: 'ready' })
    const error = nextMessage(socket)
    socket.send(encodeRelayMessage(ciphertextMessage()))
    expect(await error).toMatchObject({ type: 'error', code: failure.code })
    if (failure.code === 'RELAY_ROUTE_REVOKED') await once(socket, 'close')
    else socket.close()
  })

  it('cancels and drains in-flight attach work when the deadline closes the socket', async () => {
    let attachSignal: AbortSignal | undefined
    let markAttachStarted: (() => void) | undefined
    const attachStarted = new Promise<void>((resolve) => { markAttachStarted = resolve })
    const relay = relayFixture(attachmentFixture())
    relay.attach.mockImplementationOnce(async (input) => {
      attachSignal = input.signal
      markAttachStarted?.()
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve()
        else input.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      throw new RemoteRelayError('REMOTE_OFFLINE', 'cancelled')
    })
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    await sendAttach(socket)
    await attachStarted
    await once(socket, 'close')
    expect(attachSignal?.aborted).toBe(true)
    await endpoint.consumer.close()
    endpoint.closed = true
  })

  it('enforces the first-frame deadline and wire payload limit', async () => {
    const relay = relayFixture(attachmentFixture())
    const endpoint = await start(relay, 10)
    const idle = await connect(endpoint.url)
    const [idleCode, idleReason] = await once(idle, 'close') as [number, Buffer]
    expect(idleCode).toBe(1008)
    expect(String(idleReason)).toBe('attach timeout')

    const sized = await start(relay)
    const oversized = await connect(sized.url)
    oversized.send(new Uint8Array(100_000))
    const [oversizedCode] = await once(oversized, 'close') as [number]
    expect(oversizedCode).toBe(1009)
  })

  it('contains delivery failure after the peer disappears', async () => {
    let input: Parameters<RemoteRelayService['attach']>[0] | undefined
    const relay = relayFixture(attachmentFixture())
    relay.attach.mockImplementationOnce(async (value) => {
      input = value
      return attachmentFixture()
    })
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    await sendAttach(socket)
    await vi.waitFor(() => { expect(input).toBeDefined() })
    const send = vi.spyOn(serverSocket(endpoint.consumer), 'send').mockImplementationOnce(
      (_data, _options, callback) => { if (typeof callback === 'function') callback(new Error('send failed')) },
    )
    await expect(input?.deliver(ciphertextMessage())).rejects.toThrow('send failed')
    send.mockRestore()
    await input?.close?.()
    await once(socket, 'close')
    await expect(input?.deliver(ciphertextMessage())).rejects.toThrow('closed before frame delivery')
  })

  it('waits for in-flight attachment cleanup and reports every shutdown failure', async () => {
    let release: (() => void) | undefined
    const closing = new Promise<void>((resolve) => { release = resolve })
    const attachment = attachmentFixture()
    attachment.close.mockImplementationOnce(async () => {
      await closing
      throw new Error('attachment close failed')
    })
    const relay = relayFixture(attachment)
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    await sendAttach(socket)
    await vi.waitFor(() => { expect(relay.attach).toHaveBeenCalledOnce() })
    socket.close()
    await once(socket, 'close')
    const stopped = endpoint.consumer.close()
    release?.()
    await expect(stopped).rejects.toThrow('Remote Relay WSS shutdown failed')
    endpoint.closed = true
  })

  it('retains an attachment cleanup failure that settles before shutdown', async () => {
    const attachment = attachmentFixture()
    attachment.close.mockRejectedValueOnce(new Error('early attachment close failed'))
    const relay = relayFixture(attachment)
    const endpoint = await start(relay)
    const socket = await connect(endpoint.url)
    await sendAttach(socket)
    await vi.waitFor(() => { expect(relay.attach).toHaveBeenCalledOnce() })
    socket.close()
    await once(socket, 'close')
    await vi.waitFor(() => { expect(attachment.close).toHaveBeenCalledOnce() })

    await expect(endpoint.consumer.close()).rejects.toThrow('Remote Relay WSS shutdown failed')
    endpoint.closed = true
  })

  it('validates direct and Cordis plugin configuration and registers exact ownership', async () => {
    expect(() => new RelayWebSocketConsumer(context(relayFixture(attachmentFixture())), 0, 1)).toThrow('positive integer')
    expect(() => new RelayWebSocketConsumer(context(relayFixture(attachmentFixture())), 1.5, 1)).toThrow('positive integer')
    expect(() => new RelayWebSocketConsumer(context(relayFixture(attachmentFixture())), 1, 0)).toThrow('positive integer')
    for (const path of ['', '/', 'relay', '/relay/', '/relay?x', '/relay#x']) {
      expect(() =>{  apply({} as Context, { path, attachTimeoutMs: 1, maxPendingChallenges: 1 }) })
        .toThrow('absolute non-root pathname')
    }

    const handleUpgrade = vi.spyOn(RelayWebSocketConsumer.prototype, 'handleUpgrade').mockImplementation(() => {})
    const close = vi.spyOn(RelayWebSocketConsumer.prototype, 'close').mockResolvedValue()
    const disposeUpgrade = vi.fn()
    const effects: Array<() => () => void | Promise<void>> = []
    const registerUpgrade = vi.fn((_route: WebUpgradeRoute) => disposeUpgrade)
    const ctx = {
      webServer: { registerUpgrade },
      effect: vi.fn((effect: () => () => void | Promise<void>) => { effects.push(effect) }),
    } as unknown as Context
    apply(ctx, { path: '/v1/remote-access/relay', attachTimeoutMs: 10, maxPendingChallenges: 2 })
    expect(effects).toHaveLength(2)
    expect(effects[0]?.()).toBe(disposeUpgrade)
    expect(registerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ path: '/v1/remote-access/relay' }))
    const route = registerUpgrade.mock.calls[0]?.[0]
    if (route === undefined) throw new Error('expected Relay WSS route')
    await route.handler({} as never, {} as never, Buffer.alloc(0))
    expect(handleUpgrade).toHaveBeenCalledOnce()
    const stop = effects[1]?.()
    if (stop === undefined) throw new Error('expected Relay WSS disposer')
    await stop()
    expect(close).toHaveBeenCalledOnce()
    handleUpgrade.mockRestore()
    close.mockRestore()
  })

  it('surfaces a WebSocket server shutdown failure', async () => {
    const consumer = new RelayWebSocketConsumer(context(relayFixture(attachmentFixture())), 10, 2)
    const server = internalServer(consumer)
    vi.spyOn(server, 'close').mockImplementationOnce((callback) => {
      callback?.(new Error('server close failed'))
      return server
    })
    await expect(consumer.close()).rejects.toThrow('Remote Relay WSS shutdown failed')
  })
})

function relayFixture(attachment: RemoteRelayAttachment) {
  return {
    rotateCredential: vi.fn(),
    revokeRoute: vi.fn(),
    attach: vi.fn<RemoteRelayService['attach']>(async (input) => {
      await input.announce?.({
        type: 'ready', transportVersion: 1, routeId: input.message.routeId,
        attachmentId: input.message.attachmentId, peers: [],
      })
      return attachment
    }),
  }
}

function attachmentFixture() {
  return {
    receive: vi.fn(async (_message: RelayCiphertextMessage | RelayHeartbeatMessage) => {}),
    close: vi.fn(async () => {}),
  }
}

function context(relay: ReturnType<typeof relayFixture>): Context {
  return { remoteRelay: relay } as unknown as Context
}

function internalServer(consumer: RelayWebSocketConsumer): WebSocketServer {
  return Reflect.get(consumer, 'server') as WebSocketServer
}

function serverSocket(consumer: RelayWebSocketConsumer): WebSocket {
  const [socket] = internalServer(consumer).clients
  if (socket === undefined) throw new Error('expected accepted server WebSocket')
  return socket
}

async function start(relay: ReturnType<typeof relayFixture>, timeout = 1_000, maxPendingChallenges = 16): Promise<{
  url: string
  consumer: RelayWebSocketConsumer
  closed: boolean
}> {
  const consumer = new RelayWebSocketConsumer(context(relay), timeout, maxPendingChallenges)
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { consumer.handleUpgrade(req, socket, head) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const endpoint = {
    url: `ws://127.0.0.1:${address.port}`,
    consumer,
    closed: false,
  }
  cleanup.push(async () => {
    if (!endpoint.closed) await consumer.close()
    await closeServer(server)
  })
  return endpoint
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  return socket
}

async function nextMessage(socket: WebSocket): Promise<RelayMessage> {
  const [data] = await once(socket, 'message') as [WebSocket.RawData]
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : Array.isArray(data)
      ? new Uint8Array(Buffer.concat(data))
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return decodeRelayMessage(bytes)
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function sendAttach(socket: WebSocket): Promise<{
  outcome: Promise<RelayMessage>
  proof: Awaited<ReturnType<typeof signRelayAttachmentChallenge>>
}> {
  const challengeMessage = nextMessage(socket)
  await sendAttachRequest(socket)
  const challenge = await challengeMessage
  if (challenge.type !== 'attach-challenge-response') throw new Error('expected Relay attach challenge')
  const outcome = nextMessage(socket)
  const proof = await signRelayAttachmentChallenge(TEST_CREDENTIAL, challenge)
  socket.send(encodeRelayMessage(proof))
  return { outcome, proof }
}

async function sendAttachRequest(socket: WebSocket): Promise<void> {
  const request = {
    type: 'attach-challenge' as const, transportVersion: 1 as const,
    routeId: parseRelayRouteId('route-one'), attachmentId: parseRelayAttachmentId('mobile-one'),
    endpoint: 'mobile' as const,
    credentialPublicKey: await deriveRelayCredentialPublicKey(TEST_CREDENTIAL),
  }
  socket.send(encodeRelayMessage(request))
}

function ciphertextMessage(): RelayCiphertextMessage {
  return {
    type: 'ciphertext',
    transportVersion: 1,
    routeId: parseRelayRouteId('route-one'),
    sourceAttachmentId: parseRelayAttachmentId('mobile-one'),
    targetAttachmentId: parseRelayAttachmentId('desktop-one'),
    ciphertext: Uint8Array.of(1, 2, 3),
  }
}

function heartbeatMessage(): RelayHeartbeatMessage {
  return {
    type: 'heartbeat',
    transportVersion: 1,
    attachmentId: parseRelayAttachmentId('mobile-one'),
    sentAt: 1,
  }
}
