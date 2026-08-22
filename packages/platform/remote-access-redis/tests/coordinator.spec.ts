import {
  encodeRelayMessage,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayRouteId,
  type RelayCiphertextMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import { createClient } from 'redis'
import { describe, expect, it, vi } from 'vitest'
import {
  parseRelayConnectionToken,
  parseRelayDeliveryId,
  parseRelayInstanceId,
  type RelayCoordinationEvent,
  type RelayDirectoryEntry,
} from '../../remote-access/src/index.ts'
import {
  RedisRelayCoordinator,
  connectRedisRelayCoordinator,
  type RelayRedisClient,
} from '../src/index.ts'

vi.mock('redis', () => ({ createClient: vi.fn() }))

describe('RedisRelayCoordinator', () => {
  it('shares only expiring directory metadata, invalidations, and bounded ciphertext Pub/Sub', async () => {
    const bus = new FakeRedisBus()
    const platformA = new RedisRelayCoordinator({
      command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:development:relay', clock: { now: () => 1_000 },
    })
    const platformB = new RedisRelayCoordinator({
      command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:development:relay', clock: { now: () => 1_000 },
    })
    const routeId = parseRelayRouteId('route-one')
    const attachmentId = parseRelayAttachmentId('desktop-one')
    const entry: RelayDirectoryEntry = {
      routeId,
      attachmentId,
      endpoint: 'desktop',
      instanceId: parseRelayInstanceId('platform-b'),
      connectionToken: parseRelayConnectionToken('connection-one'),
      revision: 3,
      expiresAt: 31_000,
    }
    const received: RelayCoordinationEvent[] = []
    const stop = await platformB.listen(entry.instanceId, async (event) => { received.push(event) })
    await platformA.register(entry)

    const mobileEntry: RelayDirectoryEntry = {
      ...entry,
      attachmentId: parseRelayAttachmentId('mobile-one'),
      endpoint: 'mobile',
      pairingSelector: parseRelayPairingSelector('pairing-one'),
      connectionToken: parseRelayConnectionToken('connection-mobile'),
    }
    await platformA.register(mobileEntry)

    expect(await platformA.locate(routeId, attachmentId)).toEqual(entry)
    expect(await platformA.list(routeId)).toEqual([entry, mobileEntry])
    expect(await platformA.refresh({ ...entry, expiresAt: 41_000 })).toBe(true)
    const ciphertext = Uint8Array.of(4, 8, 15, 16, 23, 42)
    const frame: RelayCiphertextMessage = {
      type: 'ciphertext', transportVersion: 1, routeId,
      sourceAttachmentId: parseRelayAttachmentId('mobile-one'), targetAttachmentId: attachmentId, ciphertext,
    }
    expect(await platformA.publish(entry.instanceId, {
      ...frame,
      sourceInstanceId: parseRelayInstanceId('platform-a'),
      targetConnectionToken: entry.connectionToken,
      deliveryId: parseRelayDeliveryId('delivery-one'),
      revision: entry.revision,
    })).toBe(true)
    expect(await platformA.publish(entry.instanceId, {
      type: 'delivered', deliveryId: parseRelayDeliveryId('delivery-one'),
    })).toBe(true)
    expect(await platformA.publish(entry.instanceId, {
      type: 'peer-update', transportVersion: 1, routeId,
      attachmentId, peers: [{
        attachmentId: parseRelayAttachmentId('mobile-one'),
        pairingSelector: parseRelayPairingSelector('pairing-one'), generation: 3,
      }],
      targetConnectionToken: entry.connectionToken, revision: entry.revision,
    })).toBe(true)
    await platformA.invalidate({ type: 'invalidate', routeId, revision: 4 })

    expect(received).toEqual([
      expect.objectContaining({ type: 'ciphertext', ciphertext }),
      { type: 'delivered', deliveryId: parseRelayDeliveryId('delivery-one') },
      expect.objectContaining({ type: 'peer-update', attachmentId, revision: entry.revision }),
      { type: 'invalidate', routeId, revision: 4 },
    ])
    expect(bus.published.join('\n')).not.toContain('private prompt')
    expect(bus.queuedMessages).toBe(0)
    await platformA.unregister({ ...entry, expiresAt: 41_000 })
    expect(await platformA.locate(routeId, attachmentId)).toBeUndefined()
    await stop()
  })

  it('does not retain ciphertext when the target instance has no subscriber', async () => {
    const bus = new FakeRedisBus()
    const coordinator = new RedisRelayCoordinator({
      command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:production:relay', clock: { now: () => 1_000 },
    })
    const event = {
      type: 'ciphertext', transportVersion: 1,
      routeId: parseRelayRouteId('route-one'),
      sourceAttachmentId: parseRelayAttachmentId('mobile-one'),
      targetAttachmentId: parseRelayAttachmentId('desktop-one'),
      targetConnectionToken: parseRelayConnectionToken('connection-one'),
      sourceInstanceId: parseRelayInstanceId('platform-a'),
      deliveryId: parseRelayDeliveryId('delivery-one'),
      revision: 1,
      ciphertext: Uint8Array.of(1),
    } as const

    expect(await coordinator.publish(parseRelayInstanceId('platform-missing'), event)).toBe(false)
    expect(bus.queuedMessages).toBe(0)
  })

  it('validates namespaces, expiry, event kind, and default wall-clock TTL', async () => {
    const bus = new FakeRedisBus()
    for (const keyPrefix of ['', 'x'.repeat(129), 'not valid']) {
      expect(() => new RedisRelayCoordinator({
        command: bus.client(), subscriber: bus.client(), keyPrefix,
      })).toThrow('keyPrefix')
    }
    const coordinator = new RedisRelayCoordinator({
      command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:relay',
    })
    const entry = directoryEntry(Date.now() + 1_000)
    await coordinator.register(entry)
    await expect(coordinator.register({ ...entry, expiresAt: Date.now() - 1 })).rejects.toThrow('future')
    await expect(coordinator.register({ ...entry, expiresAt: Date.now() + 1.5 })).rejects.toThrow('future')
    await expect(coordinator.publish(parseRelayInstanceId('platform-a'), {
      type: 'invalidate', routeId: entry.routeId, revision: 2,
    })).rejects.toThrow('must use invalidate')

    const sparse = clientFixture()
    sparse.sMembers.mockResolvedValueOnce(['desktop-stale'])
    const sparseCoordinator = new RedisRelayCoordinator({
      command: sparse, subscriber: clientFixture(), keyPrefix: 'dsh:relay',
    })
    await expect(sparseCoordinator.list(parseRelayRouteId('route-stale'))).resolves.toEqual([])
  })

  it('cancels an in-flight directory registration through the maintained Redis client', async () => {
    const command = clientFixture()
    const controller = new AbortController()
    let commandSignal: AbortSignal | undefined
    command.withAbortSignal.mockImplementation((signal) => {
      commandSignal = signal
      return {
        ...command,
        eval: async () => await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('registration aborted'))
          }, { once: true })
        }),
      }
    })
    const coordinator = new RedisRelayCoordinator({
      command, subscriber: clientFixture(), keyPrefix: 'dsh:relay', clock: { now: () => 1_000 },
    })

    const registration = coordinator.register(directoryEntry(2_000), controller.signal)
    controller.abort(new Error('attach timed out'))

    await expect(registration).rejects.toThrow('attach timed out')
    expect(commandSignal).toBe(controller.signal)
  })

  it('rolls back partial subscription and aggregates unsubscribe failures', async () => {
    const command = clientFixture()
    const subscriber = clientFixture()
    subscriber.subscribe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('subscribe failed'))
    const coordinator = new RedisRelayCoordinator({
      command, subscriber, keyPrefix: 'dsh:relay',
    })
    await expect(coordinator.listen(parseRelayInstanceId('platform-a'), async () => {}))
      .rejects.toThrow('subscribe failed')
    expect(subscriber.unsubscribe).toHaveBeenCalledOnce()

    subscriber.subscribe.mockReset().mockResolvedValue(undefined)
    subscriber.unsubscribe.mockReset().mockRejectedValue(new Error('unsubscribe failed'))
    const stop = await coordinator.listen(parseRelayInstanceId('platform-a'), async () => {})
    await expect(stop()).rejects.toThrow('subscription shutdown failed')
  })

  it('rejects malformed shared values and contains listener failures', async () => {
    const bus = new FakeRedisBus()
    const coordinator = new RedisRelayCoordinator({
      command: bus.client(), subscriber: bus.client(), keyPrefix: 'dsh:relay', clock: { now: () => 1_000 },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await coordinator.listen(parseRelayInstanceId('platform-a'), async () => {
      throw new Error('listener failed')
    })
    const malformedEvents = [
      'x'.repeat(140_000),
      'null',
      '[]',
      JSON.stringify({ type: 'invalidate', routeId: 'route-one', revision: 1, extra: true }),
      JSON.stringify({ type: 'invalidate', routeId: 'bad route', revision: 1 }),
      JSON.stringify({ type: 'invalidate', routeId: 'route-one', revision: 0 }),
      coordinationValue('unknown', ''),
      coordinationValue('ciphertext', 1),
      coordinationValue('ciphertext', 'AA=='),
      coordinationValue('ciphertext', 'A'),
      coordinationValue('ciphertext', 'AB'),
      JSON.stringify({
        type: 'peer-update', targetConnectionToken: 'connection-one', revision: 1,
        frame: Buffer.from(encodeRelayMessage({
          type: 'ciphertext', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
          sourceAttachmentId: parseRelayAttachmentId('mobile-one'),
          targetAttachmentId: parseRelayAttachmentId('desktop-one'), ciphertext: Uint8Array.of(1),
        })).toString('base64url'),
      }),
      coordinationValue('ciphertext', Buffer.from(encodeRelayMessage({
        type: 'peer-update', transportVersion: 1, routeId: parseRelayRouteId('route-one'),
        attachmentId: parseRelayAttachmentId('desktop-one'), peers: [],
      })).toString('base64url')),
      JSON.stringify({
        type: 'ciphertext', sourceInstanceId: 'platform-a', targetConnectionToken: 'token',
        deliveryId: 'delivery-one', revision: 1,
        frame: Buffer.from(JSON.stringify({
          type: 'attach', transportVersion: 1, routeId: 'route-one', attachmentId: 'mobile-one',
          endpoint: 'mobile', credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        })).toString('base64url'),
      }),
    ]
    for (const event of malformedEvents) bus.emit('dsh:relay:instance:platform-a', event)
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalledTimes(malformedEvents.length) })

    await coordinator.invalidate({ type: 'invalidate', routeId: parseRelayRouteId('route-one'), revision: 2 })
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalledWith(
      '[remote-access-redis] coordination listener failed:', expect.any(Error),
    ) })

    const malformedDirectories = [
      'x'.repeat(2_049),
      'null',
      '[]',
      JSON.stringify({ ...directoryEntry(2_000), extra: true }),
      JSON.stringify({ ...directoryEntry(2_000), endpoint: 'relay' }),
      JSON.stringify({ ...directoryEntry(2_000), routeId: 'bad route' }),
      JSON.stringify({ ...directoryEntry(2_000), attachmentId: '' }),
      JSON.stringify({ ...directoryEntry(2_000), instanceId: '' }),
      JSON.stringify({ ...directoryEntry(2_000), connectionToken: '' }),
      JSON.stringify({ ...directoryEntry(2_000), revision: 0 }),
      JSON.stringify({ ...directoryEntry(2_000), expiresAt: 0 }),
    ]
    for (const value of malformedDirectories) {
      bus.raw('dsh:relay:directory:route-one:desktop-one', value)
      await expect(coordinator.locate(
        parseRelayRouteId('route-one'), parseRelayAttachmentId('desktop-one'),
      )).rejects.toThrow()
    }
    await expect(stop()).rejects.toThrow('Relay Redis subscription shutdown failed')
    consoleError.mockRestore()
  })

  it('constructs and closes maintained Redis clients with fail-closed cleanup', async () => {
    await expect(connectRedisRelayCoordinator({ url: 'https://redis.example', keyPrefix: 'dsh:relay' }))
      .rejects.toThrow('redis or rediss')
    vi.mocked(createClient).mockClear()
    await expect(connectRedisRelayCoordinator({ url: 'redis://localhost:6379', keyPrefix: 'not valid' }))
      .rejects.toThrow('keyPrefix')
    expect(createClient).not.toHaveBeenCalled()

    const command = redisClientFixture()
    const subscriber = redisClientFixture()
    command.duplicate.mockReturnValue(subscriber)
    vi.mocked(createClient).mockReturnValue(command as never)
    const connected = await connectRedisRelayCoordinator({
      url: 'redis://localhost:6379', keyPrefix: 'dsh:relay',
    })
    expect(command.connect).toHaveBeenCalledOnce()
    expect(subscriber.connect).toHaveBeenCalledOnce()
    expect(command.on).toHaveBeenCalledBefore(command.connect)
    expect(subscriber.on).toHaveBeenCalledBefore(subscriber.connect)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleError.mockClear()
    command.emitError(new Error('command runtime error'))
    subscriber.emitError(new Error('subscriber runtime error'))
    expect(consoleError.mock.calls.some(call => String(call[1] ?? call[0]).includes('command runtime error') || String(call[0]).includes('command runtime error'))).toBe(true)
    expect(consoleError.mock.calls.some(call => String(call[1] ?? call[0]).includes('subscriber runtime error') || String(call[0]).includes('subscriber runtime error'))).toBe(true)
    consoleError.mockRestore()
    await connected.close()
    expect(command.quit).toHaveBeenCalledOnce()
    expect(subscriber.quit).toHaveBeenCalledOnce()
    expect(command.off).toHaveBeenCalledOnce()
    expect(subscriber.off).toHaveBeenCalledOnce()

    command.connect.mockReset().mockResolvedValue(undefined)
    subscriber.connect.mockReset().mockResolvedValue(undefined)
    command.quit.mockReset().mockRejectedValue(new Error('command quit failed'))
    subscriber.quit.mockReset().mockRejectedValue(new Error('subscriber quit failed'))
    const rediss = await connectRedisRelayCoordinator({
      url: 'rediss://localhost:6380', keyPrefix: 'dsh:relay',
    })
    await expect(rediss.close()).rejects.toThrow('clients failed to close')

    command.connect.mockReset().mockRejectedValue(new Error('connect failed'))
    subscriber.connect.mockReset().mockResolvedValue(undefined)
    command.close.mockReset().mockRejectedValue(new Error('already closed'))
    subscriber.close.mockReset().mockResolvedValue(undefined)
    await expect(connectRedisRelayCoordinator({
      url: 'redis://localhost:6379', keyPrefix: 'dsh:relay',
    })).rejects.toThrow('Relay Redis clients failed to connect and close')
    expect(command.close).toHaveBeenCalled()
    expect(subscriber.close).toHaveBeenCalled()

    command.connect.mockReset().mockRejectedValue(new Error('command connect failed'))
    subscriber.connect.mockReset().mockRejectedValue(new Error('subscriber connect failed'))
    await expect(connectRedisRelayCoordinator({
      url: 'redis://localhost:6379', keyPrefix: 'dsh:relay',
    })).rejects.toThrow('clients failed to connect')
  })

  it('drops coordination events after listen shutdown starts', async () => {
    const subscriber = clientFixture()
    let instanceListener: ((message: string) => void) | undefined
    subscriber.subscribe.mockImplementation(async (_channel, listener) => {
      instanceListener ??= listener
    })
    let releaseUnsubscribe: (() => void) | undefined
    const unsubscribed = new Promise<void>((resolve) => { releaseUnsubscribe = resolve })
    subscriber.unsubscribe.mockImplementation(async () => { await unsubscribed })
    const coordinator = new RedisRelayCoordinator({
      command: clientFixture(), subscriber, keyPrefix: 'dsh:relay',
    })
    const listener = vi.fn(async () => {})
    const stop = await coordinator.listen(parseRelayInstanceId('platform-a'), listener)

    const stopping = stop()
    instanceListener?.('{"type":"delivered","deliveryId":"delivery-late"}')
    releaseUnsubscribe?.()
    await stopping

    expect(listener).not.toHaveBeenCalled()
  })

  it('aggregates subscribe and unsubscribe failures during listen acquisition', async () => {
    const subscriber = clientFixture()
    subscriber.subscribe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('subscribe failed'))
    subscriber.unsubscribe.mockRejectedValueOnce(new Error('unsubscribe failed'))
    const coordinator = new RedisRelayCoordinator({
      command: clientFixture(), subscriber, keyPrefix: 'dsh:relay',
    })

    await expect(coordinator.listen(parseRelayInstanceId('platform-a'), async () => {}))
      .rejects.toThrow('subscription acquisition rollback failed')
  })

  it('rethrows a single Redis connect failure after successful client cleanup', async () => {
    const command = redisClientFixture()
    const subscriber = redisClientFixture()
    command.duplicate.mockReturnValue(subscriber)
    command.connect.mockRejectedValue(new Error('only command connect failed'))
    vi.mocked(createClient).mockReturnValue(command as never)

    await expect(connectRedisRelayCoordinator({
      url: 'redis://localhost:6379', keyPrefix: 'dsh:relay',
    })).rejects.toThrow('only command connect failed')
    expect(command.close).toHaveBeenCalled()
    expect(subscriber.close).toHaveBeenCalled()
  })
})

class FakeRedisBus {
  readonly published: string[] = []
  readonly queuedMessages = 0
  private readonly values = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly subscriptions = new Map<string, Set<(message: string) => void>>()

  client(): RelayRedisClient {
    const client: RelayRedisClient = {
      get: async key => this.values.get(key) ?? null,
      sMembers: async key => [...(this.sets.get(key) ?? [])],
      set: async (key, value) => { this.values.set(key, value); return 'OK' },
      eval: async (script, options) => {
        const [key] = options.keys
        if (script.includes("redis.call('SET', KEYS[1], ARGV[1]")) {
          this.values.set(key as string, options.arguments[0] as string)
          const routeKey = options.keys[1] as string
          const members = this.sets.get(routeKey) ?? new Set()
          members.add(options.arguments[2] as string)
          this.sets.set(routeKey, members)
          return 1
        }
        const value = key === undefined ? undefined : this.values.get(key)
        if (value === undefined) return 0
        const record = JSON.parse(value) as { connectionToken?: string }
        if (record.connectionToken !== options.arguments[0]) return 0
        if (script.includes("redis.call('SREM'")) {
          this.values.delete(key as string)
          this.sets.get(options.keys[1] as string)?.delete(options.arguments[1] as string)
          return 1
        }
        const replacement = options.arguments[1]
        if (replacement !== undefined) {
          this.values.set(key as string, replacement)
          const routeKey = options.keys[1] as string
          const members = this.sets.get(routeKey) ?? new Set()
          members.add(options.arguments[3] as string)
          this.sets.set(routeKey, members)
        }
        return 1
      },
      publish: async (channel, message) => {
        this.published.push(message)
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

  emit(channel: string, message: string): void {
    for (const listener of this.subscriptions.get(channel) ?? []) listener(message)
  }

  raw(key: string, value: string): void { this.values.set(key, value) }
}

function directoryEntry(expiresAt: number): RelayDirectoryEntry {
  return {
    routeId: parseRelayRouteId('route-one'),
    attachmentId: parseRelayAttachmentId('desktop-one'),
    endpoint: 'desktop',
    instanceId: parseRelayInstanceId('platform-a'),
    connectionToken: parseRelayConnectionToken('connection-one'),
    revision: 1,
    expiresAt,
  }
}

function coordinationValue(type: string, frame: unknown): string {
  return JSON.stringify({
    type,
    sourceInstanceId: 'platform-a',
    targetConnectionToken: 'connection-one',
    deliveryId: 'delivery-one',
    revision: 1,
    frame,
  })
}

function clientFixture() {
  const fixture = {
    get: vi.fn(async () => null),
    sMembers: vi.fn(async () => []),
    set: vi.fn(async () => 'OK'),
    eval: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    withAbortSignal: vi.fn(),
  } satisfies Record<keyof RelayRedisClient, unknown> as unknown as {
    [K in keyof RelayRedisClient]: ReturnType<typeof vi.fn<RelayRedisClient[K]>>
  }
  fixture.withAbortSignal.mockReturnValue(fixture)
  return fixture
}

function redisClientFixture() {
  const errorListeners: Array<(error: Error) => void> = []
  return {
    ...clientFixture(),
    duplicate: vi.fn(),
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    on: vi.fn((_event: 'error', listener: (error: Error) => void) => { errorListeners.push(listener) }),
    off: vi.fn(),
    emitError: (error: Error) => { for (const listener of errorListeners) listener(error) },
  }
}
