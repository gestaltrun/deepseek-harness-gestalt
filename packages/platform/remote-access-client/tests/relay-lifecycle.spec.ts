import {
  decodeRelayMessage,
  encodeRelayMessage,
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  MobileRelayEndpointLifecycle,
  RemoteRelayEndpointController,
  type RelayEndpointSocket,
} from '../src/index.ts'

describe('RemoteRelayEndpointController', () => {
  it('starts Mobile only after pairing-delivered authority configures its lifecycle', async () => {
    const unavailableError = vi.fn()
    const unavailable = new MobileRelayEndpointLifecycle({
      attachmentId: () => parseRelayAttachmentId('mobile-unconfigured'),
      connect: async () => new FakeSocket(),
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
      onTransportError: unavailableError,
    })
    const unavailableStart = unavailable.start()
    void unavailableStart.catch(() => {})
    await vi.waitFor(() => { expect(unavailableError).toHaveBeenCalled() })
    await unavailable.stop()
    await expect(unavailableStart).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })

    const socket = new FakeSocket()
    const lifecycle = new MobileRelayEndpointLifecycle({
      attachmentId: () => parseRelayAttachmentId('mobile-product'),
      connect: async () => socket,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
    })
    lifecycle.configure({
      endpoint: 'mobile',
      routeId: parseRelayRouteId('route-product'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      revision: 1,
    })

    await lifecycle.start()
    expect(lifecycle.isConnected()).toBe(true)
    expect(socket.decoded()[0]).toMatchObject({ type: 'attach', endpoint: 'mobile', routeId: 'route-product' })
    await lifecycle.sendCiphertext(parseRelayAttachmentId('desktop-product'), Uint8Array.of(1))
    expect(socket.decoded()[1]).toMatchObject({
      type: 'ciphertext',
      targetAttachmentId: 'desktop-product',
      ciphertext: Uint8Array.of(1),
    })
    await lifecycle.stop()
    expect(lifecycle.isConnected()).toBe(false)
  })

  it('drops pairing-delivered authority so a later start cannot attach', async () => {
    const clearedError = vi.fn()
    const cleared = new MobileRelayEndpointLifecycle({
      attachmentId: () => parseRelayAttachmentId('mobile-cleared'),
      connect: async () => new FakeSocket(),
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
      onTransportError: clearedError,
    })
    cleared.configure({
      endpoint: 'mobile',
      routeId: parseRelayRouteId('route-cleared'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      revision: 1,
    })
    cleared.configure(undefined)
    const clearedStart = cleared.start()
    void clearedStart.catch(() => {})
    await vi.waitFor(() => { expect(clearedError).toHaveBeenCalled() })
    await cleared.stop()
    await expect(clearedStart).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('rejects invalid lifecycle configuration and Desktop without authoritative resync', () => {
    const base = {
      endpoint: 'mobile' as const,
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => new FakeSocket(),
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 1,
      reconnectDelayMs: 1,
    }
    for (const field of ['attachTimeoutMs', 'heartbeatIntervalMs', 'reconnectDelayMs'] as const) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new RemoteRelayEndpointController({ ...base, [field]: value })).toThrow('positive integer')
      }
    }
    expect(() => new RemoteRelayEndpointController({ ...base, endpoint: 'desktop' })).toThrow('resynchronize')
  })

  it('reconnects through a replacement instance and requests Desktop-authoritative resync without replay', async () => {
    const first = new FakeSocket()
    const replacement = new FakeSocket()
    const sockets = [first, replacement]
    const resynchronize = vi.fn(async (send: (target: ReturnType<typeof parseRelayAttachmentId>, value: Uint8Array) => Promise<void>) => {
      await send(parseRelayAttachmentId('mobile-one'), Uint8Array.of(9))
    })
    let attachment = 0
    const controller = new RemoteRelayEndpointController({
      endpoint: 'desktop',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId(`desktop-${String(++attachment)}`),
      connect: async () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('no replacement socket')
        return socket
      },
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
      resynchronize,
    })

    await controller.start()
    expect(controller.isConnected()).toBe(true)
    expect(resynchronize).toHaveBeenCalledTimes(1)
    expect(first.decoded().map(message => message.type)).toEqual(['attach', 'ciphertext'])
    first.end()
    await vi.waitFor(() => { expect(resynchronize).toHaveBeenCalledTimes(2) })
    expect(replacement.decoded().map(message => message.type)).toEqual(['attach', 'ciphertext'])
    expect(first.decoded()).toHaveLength(2)

    await controller.stop()
    expect(controller.isConnected()).toBe(false)
    await expect(controller.sendCiphertext(parseRelayAttachmentId('mobile-one'), Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('stops immediately for window close, sleep, quit, or Mobile Access disablement', async () => {
    for (const reason of ['window-close', 'sleep', 'quit', 'mobile-access-disabled'] as const) {
      const socket = new FakeSocket()
      const controller = new RemoteRelayEndpointController({
        endpoint: 'desktop',
        route: async () => ({
          routeId: parseRelayRouteId('route-one'),
          credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        }),
        attachmentId: () => parseRelayAttachmentId('desktop-one'),
        connect: async () => socket,
        attachTimeoutMs: 20,
        heartbeatIntervalMs: 30_000,
        reconnectDelayMs: 1,
        resynchronize: async () => {},
      })
      await controller.start()

      await controller.stop(reason)

      expect(socket.closed).toBe(true)
      await expect(controller.sendCiphertext(parseRelayAttachmentId('mobile-one'), Uint8Array.of(1)))
        .rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    }
  })

  it('receives ciphertext and content-free retryable errors while heartbeating with the supplied clock', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onCiphertext = vi.fn()
    const onTransportError = vi.fn()
    const controller = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => socket,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 1,
      clock: { now: () => 123 },
      onCiphertext,
      onTransportError,
    })
    await controller.start()
    await controller.start()
    socket.receive(encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
      sourceAttachmentId: parseRelayAttachmentId('desktop-one'),
      targetAttachmentId: parseRelayAttachmentId('mobile-one'), ciphertext: Uint8Array.of(3),
    }))
    socket.receive(encodeRelayMessage({
      type: 'error', transportVersion: 1, code: 'PLATFORM_CAPACITY', retryAfterMs: 50,
    }))
    socket.receive(encodeRelayMessage({
      type: 'error', transportVersion: 1, code: 'REMOTE_OFFLINE',
    }))
    await vi.waitFor(() => { expect(onCiphertext).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(onTransportError).toHaveBeenCalledTimes(2) })
    await vi.advanceTimersByTimeAsync(10)
    expect(socket.decoded()).toContainEqual({
      type: 'heartbeat', transportVersion: 1, attachmentId: parseRelayAttachmentId('mobile-one'), sentAt: 123,
    })
    await controller.stop()
    await controller.stop()
    vi.useRealTimers()
  })

  it('reconnects after protocol, socket, and route failures and reports stable transport errors', async () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const sockets = [firstSocket, secondSocket]
    const onTransportError = vi.fn()
    let routeCalls = 0
    const controller = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => {
        routeCalls += 1
        if (routeCalls === 2) throw new Error('route lookup failed')
        return {
          routeId: parseRelayRouteId('route-one'),
          credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        }
      },
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('connect failed')
        return socket
      },
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
      onTransportError,
    })
    await controller.start()
    firstSocket.receive(encodeRelayMessage({
      type: 'error', transportVersion: 1, code: 'RELAY_ROUTE_REVOKED',
    }))
    await vi.waitFor(() => { expect(routeCalls).toBeGreaterThanOrEqual(3) })
    secondSocket.receive(encodeRelayMessage({
      type: 'attach', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
      attachmentId: parseRelayAttachmentId('desktop-invalid'), endpoint: 'desktop',
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    }))
    await vi.waitFor(() => { expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RELAY_ATTACHMENT_REJECTED' }),
    ) })
    expect(onTransportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'REMOTE_OFFLINE' }))
    await controller.stop()
  })

  it('closes a socket acquired after stop and rejects start before first attachment', async () => {
    const pending = deferred<RelayEndpointSocket>()
    const controller = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => pending.promise,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
    })
    const starting = controller.start()
    await Promise.resolve()
    const stopping = controller.stop()
    const socket = new FakeSocket()
    pending.resolve(socket)
    await expect(starting).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await stopping
    expect(socket.closed).toBe(true)
  })

  it('drops buffered frames after stop and ignores a connection failure caused by that stop', async () => {
    const socket = new FakeSocket()
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const onCiphertext = vi.fn(async () => { entered.resolve(undefined); await release.promise })
    const controller = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => socket,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
      onCiphertext,
    })
    await controller.start()
    const frame = encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
      sourceAttachmentId: parseRelayAttachmentId('desktop-one'),
      targetAttachmentId: parseRelayAttachmentId('mobile-one'), ciphertext: Uint8Array.of(1),
    })
    socket.receive(frame)
    socket.receive(frame)
    await entered.promise
    const stopping = controller.stop()
    release.resolve(undefined)
    await stopping
    expect(onCiphertext).toHaveBeenCalledOnce()

    const connect = deferred<RelayEndpointSocket>()
    const stoppedBeforeFailure = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-two'),
      connect: async () => connect.promise,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 30_000,
      reconnectDelayMs: 1,
    })
    const starting = stoppedBeforeFailure.start()
    await Promise.resolve()
    const stopped = stoppedBeforeFailure.stop()
    connect.reject(new Error('stopped connection failed'))
    await expect(starting).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await stopped
  })

  it('uses wall-clock heartbeat time when no clock adapter is supplied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(456)
    const socket = new FakeSocket()
    const controller = new RemoteRelayEndpointController({
      endpoint: 'mobile',
      route: async () => ({
        routeId: parseRelayRouteId('route-one'),
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      }),
      attachmentId: () => parseRelayAttachmentId('mobile-one'),
      connect: async () => socket,
      attachTimeoutMs: 20,
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 1,
    })
    await controller.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(socket.decoded()).toContainEqual({
      type: 'heartbeat', transportVersion: 1,
      attachmentId: parseRelayAttachmentId('mobile-one'), sentAt: 466,
    })
    await controller.stop()
    vi.useRealTimers()
  })

  it('shares one pending attachment acknowledgement across concurrent starts', async () => {
    const socket = new FakeSocket(false)
    const connect = vi.fn(async () => socket)
    const resynchronize = vi.fn(async () => {})
    const controller = desktopController({ connect, resynchronize, attachTimeoutMs: 1_000 })

    const first = controller.start()
    const second = controller.start()
    const firstResolved = vi.fn()
    const secondResolved = vi.fn()
    void first.then(firstResolved)
    void second.then(secondResolved)
    await vi.waitFor(() => { expect(socket.decoded()).toHaveLength(1) })
    expect(firstResolved).not.toHaveBeenCalled()
    expect(secondResolved).not.toHaveBeenCalled()
    expect(resynchronize).not.toHaveBeenCalled()

    const attach = socket.decoded()[0]
    if (attach?.type !== 'attach') throw new Error('expected attach')
    socket.receive(encodeRelayMessage({
      type: 'ready', transportVersion: 1, attachmentId: attach.attachmentId,
    }))
    await Promise.all([first, second])
    expect(connect).toHaveBeenCalledOnce()
    expect(resynchronize).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it('waits for an old stop owner before a replacement start can connect', async () => {
    const releaseClose = deferred<undefined>()
    const first = new DeferredCloseSocket(releaseClose.promise)
    const second = new FakeSocket()
    const sockets: RelayEndpointSocket[] = [first, second]
    const connect = vi.fn(async () => {
      const socket = sockets.shift()
      if (socket === undefined) throw new Error('unexpected connection')
      return socket
    })
    const controller = desktopController({ connect })
    await controller.start()

    const stopping = controller.stop('sleep')
    await first.closeStarted.promise
    const restarting = controller.start()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledOnce()

    releaseClose.resolve(undefined)
    await stopping
    await restarting
    expect(connect).toHaveBeenCalledTimes(2)
    await controller.stop()
  })

  it('does not resynchronize before ready and rejects hostile attachment acknowledgements', async () => {
    const socket = new FakeSocket(false)
    const resynchronize = vi.fn(async () => {})
    const onTransportError = vi.fn()
    const controller = desktopController({
      connect: async () => socket,
      resynchronize,
      onTransportError,
      attachTimeoutMs: 1_000,
      reconnectDelayMs: 30_000,
    })
    const starting = controller.start()
    await vi.waitFor(() => { expect(socket.decoded()).toHaveLength(1) })
    socket.receive(encodeRelayMessage({
      type: 'ready', transportVersion: 1, attachmentId: parseRelayAttachmentId('wrong-attachment'),
    }))
    await vi.waitFor(() => { expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RELAY_ATTACHMENT_REJECTED' }),
    ) })
    expect(resynchronize).not.toHaveBeenCalled()
    const stopping = controller.stop()
    await expect(starting).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await stopping
  })

  it('fails an unacknowledged attach on timeout and cancels a pending acknowledgement during stop', async () => {
    vi.useFakeTimers()
    const timedOut = new FakeSocket(false)
    const onTransportError = vi.fn()
    const timeoutController = new RemoteRelayEndpointController({
      ...mobileOptions(async () => timedOut),
      attachTimeoutMs: 20,
      reconnectDelayMs: 100,
      onTransportError,
    })
    const starting = timeoutController.start()
    await vi.advanceTimersByTimeAsync(20)
    expect(onTransportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'REMOTE_OFFLINE' }))
    const stopping = timeoutController.stop()
    await expect(starting).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await stopping

    const pending = new PendingReadSocket()
    const pendingController = new RemoteRelayEndpointController(mobileOptions(async () => pending))
    const pendingStart = pendingController.start()
    await pending.readEntered.promise
    const pendingStop = pendingController.stop()
    await expect(pendingStart).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await pendingStop
    vi.useRealTimers()
  })

  it('does not publish a connection when stop wins immediately after ready', async () => {
    const socket = new FakeSocket(false)
    const controller = new RemoteRelayEndpointController(mobileOptions(async () => socket))
    const starting = controller.start()
    await vi.waitFor(() => { expect(socket.decoded()).toHaveLength(1) })
    socket.receive(encodeRelayMessage({
      type: 'ready', transportVersion: 1, attachmentId: parseRelayAttachmentId('mobile-one'),
    }))
    await Promise.resolve()
    const stopping = controller.stop()
    await expect(starting).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await stopping
    await expect(controller.sendCiphertext(parseRelayAttachmentId('desktop-one'), Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('aggregates simultaneous heartbeat and socket close failures before reconnecting', async () => {
    vi.useFakeTimers()
    const socket = new DualFailureSocket()
    const cancelled = deferred<undefined>()
    let connects = 0
    const onTransportError = vi.fn()
    const controller = new RemoteRelayEndpointController({
      ...mobileOptions(async (signal) => {
        connects += 1
        if (connects === 1) return socket
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            cancelled.resolve(undefined)
            reject(new Error('replacement cancelled'))
          }, { once: true })
        })
      }),
      heartbeatIntervalMs: 10,
      onTransportError,
    })
    await controller.start()
    await vi.advanceTimersByTimeAsync(10)
    socket.end()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTransportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'REMOTE_OFFLINE' }))
    const stopping = controller.stop()
    await cancelled.promise
    await stopping
    vi.useRealTimers()
  })

  it('reconnects when an attach is rejected, its socket closes, or its read fails before acknowledgement', async () => {
    const rejected = new FakeSocket(false)
    const closed = new FakeSocket(false)
    const readFailed = new RejectingReadSocket()
    const ready = new FakeSocket()
    const sockets: RelayEndpointSocket[] = [rejected, closed, readFailed, ready]
    const onTransportError = vi.fn()
    const controller = new RemoteRelayEndpointController({
      ...mobileOptions(async () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('no replacement')
        return socket
      }),
      attachTimeoutMs: 1_000,
      onTransportError,
    })
    const starting = controller.start()
    await vi.waitFor(() => { expect(rejected.decoded()).toHaveLength(1) })
    rejected.receive(encodeRelayMessage({
      type: 'error', transportVersion: 1, code: 'RELAY_ROUTE_REVOKED',
    }))
    await vi.waitFor(() => { expect(closed.decoded()).toHaveLength(1) })
    closed.end()
    await starting
    expect(onTransportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'RELAY_ROUTE_REVOKED' }))
    expect(onTransportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'REMOTE_OFFLINE' }))
    await controller.stop()
  })

  it('fails closed for ciphertext addressed to another route or attachment', async () => {
    const firstSocket = new FakeSocket()
    const sockets = [firstSocket, new FakeSocket()]
    const onCiphertext = vi.fn()
    const onTransportError = vi.fn()
    const controller = new RemoteRelayEndpointController({
      ...mobileOptions(async () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('no socket')
        return socket
      }),
      onCiphertext,
      onTransportError,
    })
    await controller.start()
    firstSocket.receive(encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1, routeId: parseRelayRouteId('other-route'),
      sourceAttachmentId: parseRelayAttachmentId('desktop-one'),
      targetAttachmentId: parseRelayAttachmentId('mobile-one'), ciphertext: Uint8Array.of(7),
    }))
    await vi.waitFor(() => { expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RELAY_ATTACHMENT_REJECTED' }),
    ) })
    expect(onCiphertext).not.toHaveBeenCalled()
    await controller.stop()
  })

  it('drains the connection run even when socket close rejects', async () => {
    const socket = new RejectingCloseSocket()
    const controller = new RemoteRelayEndpointController(mobileOptions(async () => socket))
    await controller.start()

    const stopped = controller.stop()
    await expect(stopped).rejects.toSatisfy((error: unknown) => error instanceof AggregateError
      && error.errors.every(item => item instanceof Error && item.message === 'close failed'))
    await socket.readDrained.promise
    await expect(controller.sendCiphertext(parseRelayAttachmentId('desktop-one'), Uint8Array.of(1)))
      .rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('normalizes a non-Error native close rejection while draining the run', async () => {
    const socket = new NonErrorRejectingCloseSocket()
    const controller = new RemoteRelayEndpointController(mobileOptions(async () => socket))
    await controller.start()

    await expect(controller.stop()).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.errors.every(item => item instanceof Error && item.message === 'close failed')
    })
  })

  it('isolates a throwing observer and keeps reconnecting after one post-ready error', async () => {
    const first = new FakeSocket()
    const second = new FakeSocket()
    const sockets = [first, second]
    const onTransportError = vi.fn(() => { throw new Error('observer failed') })
    const controller = new RemoteRelayEndpointController({
      ...mobileOptions(async () => {
        const socket = sockets.shift()
        if (socket === undefined) throw new Error('no socket')
        return socket
      }),
      onTransportError,
    })
    await controller.start()

    first.receive(encodeRelayMessage({
      type: 'error', transportVersion: 1, code: 'RELAY_ROUTE_REVOKED',
    }))

    await vi.waitFor(() => { expect(second.decoded()).toHaveLength(1) })
    expect(onTransportError).toHaveBeenCalledOnce()
    await controller.stop()
  })

  it.each(['route', 'connect'] as const)('cancels and settles a pending %s acquisition during stop', async (stage) => {
    const cancelled = deferred<undefined>()
    const never = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        cancelled.resolve(undefined)
        reject(new Error(`${stage} cancelled`))
      }, { once: true })
    })
    const options = mobileOptions(async signal => stage === 'connect' ? await never(signal) : new FakeSocket())
    if (stage === 'route') options.route = async (signal: AbortSignal) => await never(signal)
    const controller = new RemoteRelayEndpointController(options)
    const starting = controller.start()
    const startResult = starting.then(() => undefined, (error: unknown) => error as RemoteRelayError)
    await Promise.resolve()

    const stopping = controller.stop()
    await cancelled.promise
    await stopping
    expect(await startResult).toMatchObject({ code: 'REMOTE_OFFLINE' })
  })
})

function mobileOptions(connect: (signal: AbortSignal) => Promise<RelayEndpointSocket>) {
  return {
    endpoint: 'mobile' as const,
    route: async (_signal: AbortSignal) => ({
      routeId: parseRelayRouteId('route-one'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    }),
    attachmentId: () => parseRelayAttachmentId('mobile-one'),
    connect,
    attachTimeoutMs: 20,
    heartbeatIntervalMs: 30_000,
    reconnectDelayMs: 1,
  }
}

function desktopController(overrides: Partial<ConstructorParameters<typeof RemoteRelayEndpointController>[0]> = {}) {
  return new RemoteRelayEndpointController({
    ...mobileOptions(async () => new FakeSocket()),
    endpoint: 'desktop',
    attachmentId: () => parseRelayAttachmentId('desktop-one'),
    resynchronize: async () => {},
    ...overrides,
  })
}

class FakeSocket implements RelayEndpointSocket {
  readonly sent: Uint8Array[] = []
  closed = false
  private readonly queue = new AsyncQueue<Uint8Array>()

  constructor(private readonly autoReady = true) {}

  async send(value: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(value)
    const message = decodeRelayMessage(value)
    if (this.autoReady && message.type === 'attach') {
      this.receive(encodeRelayMessage({
        type: 'ready', transportVersion: 1, attachmentId: message.attachmentId,
      }))
    }
  }

  messages(): AsyncIterable<Uint8Array> { return this.queue }

  receive(value: Uint8Array): void { this.queue.push(value) }

  async close(): Promise<void> { this.end() }

  end(): void {
    this.closed = true
    this.queue.end()
  }

  decoded() { return this.sent.map(value => decodeRelayMessage(value)) }
}

class DeferredCloseSocket extends FakeSocket {
  readonly closeStarted = deferred<undefined>()

  constructor(private readonly releaseClose: Promise<undefined>) { super() }

  override async close(): Promise<void> {
    this.end()
    this.closeStarted.resolve(undefined)
    await this.releaseClose
  }
}

class RejectingCloseSocket extends FakeSocket {
  readonly readDrained = deferred<undefined>()

  override messages(): AsyncIterable<Uint8Array> {
    const messages = super.messages()
    const drained = this.readDrained
    return {
      async *[Symbol.asyncIterator]() {
        try { yield* messages }
        finally { drained.resolve(undefined) }
      },
    }
  }

  override async close(): Promise<void> {
    this.end()
    throw new Error('close failed')
  }
}

class NonErrorRejectingCloseSocket extends FakeSocket {
  private readonly rejectClose = vi.fn<() => Promise<void>>().mockRejectedValue('close failed')

  override close(): Promise<void> {
    this.end()
    return this.rejectClose()
  }
}

class RejectingReadSocket extends FakeSocket {
  constructor() { super(false) }

  override messages(): AsyncIterable<Uint8Array> {
    return {
      async *[Symbol.asyncIterator]() { throw new Error('read failed before ready') },
    }
  }
}

class PendingReadSocket extends FakeSocket {
  readonly readEntered = deferred<undefined>()

  constructor() { super(false) }

  override messages(): AsyncIterable<Uint8Array> {
    const messages = super.messages()
    const entered = this.readEntered
    return {
      async *[Symbol.asyncIterator]() {
        entered.resolve(undefined)
        yield* messages
      },
    }
  }
}

class DualFailureSocket extends RejectingCloseSocket {
  private sends = 0

  override async send(value: Uint8Array): Promise<void> {
    this.sends += 1
    if (this.sends > 1) throw new Error('heartbeat failed')
    await super.send(value)
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waits: Array<(value: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    const wait = this.waits.shift()
    if (wait === undefined) this.values.push(value)
    else wait({ done: false, value })
  }

  end(): void {
    this.ended = true
    for (const wait of this.waits.splice(0)) wait({ done: true, value: undefined })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const value = this.values.shift()
      if (value !== undefined) { yield value; continue }
      if (this.ended) return
      const next = await new Promise<IteratorResult<T>>((resolve) => { this.waits.push(resolve) })
      if (next.done) return
      yield next.value
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
