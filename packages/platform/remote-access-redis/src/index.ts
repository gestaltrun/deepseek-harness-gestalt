/** Redis connection directory, invalidation, and ciphertext Pub/Sub for Remote Access. */

import { createClient } from 'redis'
import {
  parseRelayConnectionToken,
  parseRelayDeliveryId,
  parseRelayInstanceId,
  type RelayCoordinationEvent,
  type RelayCoordinator,
  type RelayDirectoryEntry,
  type RelayInstanceId,
} from '@deepseek-ai/dsh-remote-access'
import {
  decodeRelayMessage,
  encodeRelayMessage,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
  type RelayAttachmentId,
  type RelayCiphertextMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9:_-]+$/u
const DIRECTORY_VALUE_BYTES = 2_048
const EVENT_BYTES = Math.ceil(REMOTE_PROTOCOL_LIMITS.relayMessageBytes * 4 / 3) + 1_024

const REGISTER_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return 1
`

const REFRESH_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if decoded.connectionToken ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`

const UNREGISTER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if decoded.connectionToken ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`

/** Minimal maintained-client operations used by the coordinator and its keyless adapter tests. */
export interface RelayRedisClient {
  get(key: string): Promise<string | null>
  sMembers(key: string): Promise<string[]>
  set(key: string, value: string, options: { PX: number }): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>
  unsubscribe(channel: string, listener: (message: string) => void): Promise<unknown>
  /** @returns a command face whose queued and in-flight work is cancelled by the signal. */
  withAbortSignal(signal: AbortSignal): RelayRedisClient
}

/** Construction inputs for one environment-scoped Redis coordinator. */
export interface RedisRelayCoordinatorOptions {
  command: RelayRedisClient
  subscriber: RelayRedisClient
  /** Environment-specific key namespace containing no credential. */
  keyPrefix: string
  clock?: { now(): number }
}

/** Redis adapter that never creates a stream, list, or other offline ciphertext queue. */
export class RedisRelayCoordinator implements RelayCoordinator {
  private readonly keyPrefix: string
  private readonly clock: { now(): number }

  /** @param options - connected maintained Redis clients and environment namespace. */
  constructor(private readonly options: RedisRelayCoordinatorOptions) {
    validateKeyPrefix(options.keyPrefix)
    this.keyPrefix = options.keyPrefix
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  async listen(
    instanceId: RelayInstanceId,
    listener: (event: RelayCoordinationEvent) => Promise<void>,
  ): Promise<() => Promise<void>> {
    const instanceChannel = this.instanceChannel(instanceId)
    const invalidationChannel = this.invalidationChannel()
    const inFlight = new Set<Promise<void>>()
    const listenerErrors: unknown[] = []
    let stopping = false
    const dispatch = (message: string): void => {
      if (stopping) return
      const operation = this.dispatch(message, listener).catch((error: unknown) => {
        listenerErrors.push(error)
        console.error('[remote-access-redis] coordination listener failed:', error)
      })
      inFlight.add(operation)
      void operation.finally(() => { inFlight.delete(operation) })
    }
    const onInstance = (message: string): void => { dispatch(message) }
    const onInvalidation = (message: string): void => { dispatch(message) }
    const subscribed: Array<{ channel: string; callback: (message: string) => void }> = []
    try {
      await this.options.subscriber.subscribe(instanceChannel, onInstance)
      subscribed.push({ channel: instanceChannel, callback: onInstance })
      await this.options.subscriber.subscribe(invalidationChannel, onInvalidation)
      subscribed.push({ channel: invalidationChannel, callback: onInvalidation })
    } catch (error) {
      const cleanup = await Promise.allSettled(
        subscribed.map(item => this.options.subscriber.unsubscribe(item.channel, item.callback)),
      )
      const cleanupErrors = rejectedReasons(cleanup)
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Relay Redis subscription acquisition rollback failed')
      }
      throw error
    }
    return async () => {
      stopping = true
      const results = await Promise.allSettled([
        ...subscribed.map(item => this.options.subscriber.unsubscribe(item.channel, item.callback)),
        ...inFlight,
      ])
      const errors = [
        ...rejectedReasons(results),
        ...listenerErrors,
      ]
      if (errors.length > 0) throw new AggregateError(errors, 'Relay Redis subscription shutdown failed')
    }
  }

  async register(entry: RelayDirectoryEntry, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const command = signal === undefined ? this.options.command : this.options.command.withAbortSignal(signal)
    const ttl = this.ttl(entry)
    await command.eval(REGISTER_SCRIPT, {
      keys: [this.directoryKey(entry.routeId, entry.attachmentId), this.routeDirectoryKey(entry.routeId)],
      arguments: [encodeDirectory(entry), String(ttl), entry.attachmentId],
    })
  }

  async refresh(entry: RelayDirectoryEntry): Promise<boolean> {
    const result = await this.options.command.eval(REFRESH_SCRIPT, {
      keys: [this.directoryKey(entry.routeId, entry.attachmentId), this.routeDirectoryKey(entry.routeId)],
      arguments: [entry.connectionToken, encodeDirectory(entry), String(this.ttl(entry)), entry.attachmentId],
    })
    return result === 1
  }

  async unregister(entry: RelayDirectoryEntry): Promise<void> {
    await this.options.command.eval(UNREGISTER_SCRIPT, {
      keys: [this.directoryKey(entry.routeId, entry.attachmentId), this.routeDirectoryKey(entry.routeId)],
      arguments: [entry.connectionToken, entry.attachmentId],
    })
  }

  async locate(routeId: RelayRouteId, attachmentId: RelayAttachmentId): Promise<RelayDirectoryEntry | undefined> {
    const value = await this.options.command.get(this.directoryKey(routeId, attachmentId))
    return value === null ? undefined : decodeDirectory(value)
  }

  async list(routeId: RelayRouteId): Promise<readonly RelayDirectoryEntry[]> {
    const attachmentIds = await this.options.command.sMembers(this.routeDirectoryKey(routeId))
    const entries = await Promise.all(attachmentIds.map(async (attachmentId) => {
      const value = await this.options.command.get(this.directoryKey(routeId, parseRelayAttachmentId(attachmentId)))
      return value === null ? undefined : decodeDirectory(value)
    }))
    return entries.filter((entry): entry is RelayDirectoryEntry => entry !== undefined)
  }

  async publish(instanceId: RelayInstanceId, event: RelayCoordinationEvent): Promise<boolean> {
    if (event.type === 'invalidate') throw new TypeError('Relay invalidation must use invalidate()')
    return await this.options.command.publish(this.instanceChannel(instanceId), encodeEvent(event)) > 0
  }

  async invalidate(event: Extract<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<void> {
    await this.options.command.publish(this.invalidationChannel(), encodeEvent(event))
  }

  private async dispatch(message: string, listener: (event: RelayCoordinationEvent) => Promise<void>): Promise<void> {
    let event: RelayCoordinationEvent
    try {
      event = decodeEvent(message)
    } catch (error) {
      console.error('[remote-access-redis] rejected malformed coordination event:', error)
      return
    }
    await listener(event)
  }

  private directoryKey(routeId: RelayRouteId, attachmentId: RelayAttachmentId): string {
    return `${this.keyPrefix}:directory:${routeId}:${attachmentId}`
  }

  private routeDirectoryKey(routeId: RelayRouteId): string {
    return `${this.keyPrefix}:route-directory:${routeId}`
  }

  private instanceChannel(instanceId: RelayInstanceId): string {
    return `${this.keyPrefix}:instance:${instanceId}`
  }

  private invalidationChannel(): string { return `${this.keyPrefix}:invalidation` }

  private ttl(entry: RelayDirectoryEntry): number {
    const ttl = entry.expiresAt - this.clock.now()
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new TypeError('Relay directory expiry must be in the future')
    return ttl
  }
}

/**
 * Construct maintained Redis clients from secret-injected deployment configuration.
 * @param options - Redis URL and environment-specific key namespace.
 * @returns the connected coordinator and an all-settled client disposer.
 */
export async function connectRedisRelayCoordinator(options: {
  url: string
  keyPrefix: string
}): Promise<{ coordinator: RedisRelayCoordinator; close(): Promise<void> }> {
  const url = new URL(options.url)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new TypeError('Relay Redis URL must use redis or rediss')
  }
  validateKeyPrefix(options.keyPrefix)
  const command = createClient({ url: options.url })
  const subscriber = command.duplicate()
  const onCommandError = (error: Error): void => {
    console.error('[remote-access-redis] command client error:', error)
  }
  const onSubscriberError = (error: Error): void => {
    console.error('[remote-access-redis] subscriber client error:', error)
  }
  command.on('error', onCommandError)
  subscriber.on('error', onSubscriberError)
  const connected = await Promise.allSettled([command.connect(), subscriber.connect()])
  const connectionErrors = rejectedReasons(connected)
  if (connectionErrors.length > 0) {
    const cleanup = await Promise.allSettled([command.close(), subscriber.close()])
    command.off('error', onCommandError)
    subscriber.off('error', onSubscriberError)
    const errors = [...connectionErrors, ...rejectedReasons(cleanup)]
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, 'Relay Redis clients failed to connect and close')
  }
  const coordinator = new RedisRelayCoordinator({
    command: command,
    subscriber: subscriber,
    keyPrefix: options.keyPrefix,
  })
  return {
    coordinator,
    close: async () => {
      const results = await Promise.allSettled([command.quit(), subscriber.quit()])
      command.off('error', onCommandError)
      subscriber.off('error', onSubscriberError)
      const errors = rejectedReasons(results)
      if (errors.length > 0) throw new AggregateError(errors, 'Relay Redis clients failed to close')
    },
  }
}

function encodeDirectory(entry: RelayDirectoryEntry): string {
  return JSON.stringify(entry)
}

function decodeDirectory(value: string): RelayDirectoryEntry {
  if (Buffer.byteLength(value) > DIRECTORY_VALUE_BYTES) throw new TypeError('Relay directory entry exceeds its byte limit')
  const record = object(JSON.parse(value) as unknown, 'Relay directory entry')
  const keys = record.pairingSelector === undefined
    ? ['routeId', 'attachmentId', 'endpoint', 'instanceId', 'connectionToken', 'revision', 'expiresAt']
    : ['routeId', 'attachmentId', 'endpoint', 'pairingSelector', 'instanceId', 'connectionToken', 'revision', 'expiresAt']
  exactKeys(record, keys)
  if (record.endpoint !== 'mobile' && record.endpoint !== 'desktop') throw new TypeError('Relay directory endpoint is invalid')
  return {
    routeId: parseRelayRouteId(record.routeId),
    attachmentId: parseRelayAttachmentId(record.attachmentId),
    endpoint: record.endpoint,
    ...(record.pairingSelector === undefined
      ? {}
      : { pairingSelector: parseRelayPairingSelector(record.pairingSelector) }),
    instanceId: parseRelayInstanceId(record.instanceId),
    connectionToken: parseRelayConnectionToken(record.connectionToken),
    revision: positiveInteger(record.revision, 'revision'),
    expiresAt: positiveInteger(record.expiresAt, 'expiresAt'),
  }
}

function encodeEvent(event: RelayCoordinationEvent): string {
  const value = event.type === 'invalidate'
    ? JSON.stringify(event)
    : event.type === 'delivered'
      ? JSON.stringify(event)
      : event.type === 'peer-update'
        ? JSON.stringify({
          type: 'peer-update',
          targetConnectionToken: event.targetConnectionToken,
          revision: event.revision,
          frame: Buffer.from(encodeRelayMessage(withoutPeerCoordination(event))).toString('base64url'),
        })
        : JSON.stringify({
          type: 'ciphertext',
          sourceInstanceId: event.sourceInstanceId,
          targetConnectionToken: event.targetConnectionToken,
          deliveryId: event.deliveryId,
          revision: event.revision,
          frame: Buffer.from(encodeRelayMessage(withoutCoordination(event))).toString('base64url'),
        })
  return value
}

function decodeEvent(value: string): RelayCoordinationEvent {
  if (Buffer.byteLength(value) > EVENT_BYTES) throw new TypeError('Relay coordination event exceeds its byte limit')
  const record = object(JSON.parse(value) as unknown, 'Relay coordination event')
  if (record.type === 'invalidate') {
    exactKeys(record, ['type', 'routeId', 'revision'])
    return {
      type: 'invalidate',
      routeId: parseRelayRouteId(record.routeId),
      revision: positiveInteger(record.revision, 'revision'),
    }
  }
  if (record.type === 'delivered') {
    exactKeys(record, ['type', 'deliveryId'])
    return { type: 'delivered', deliveryId: parseRelayDeliveryId(record.deliveryId) }
  }
  if (record.type === 'peer-update') {
    exactKeys(record, ['type', 'targetConnectionToken', 'revision', 'frame'])
    const frame = decodeCoordinationFrame(record.frame)
    if (frame.type !== 'peer-update') throw new TypeError('Relay coordination frame must carry a peer update')
    return {
      ...frame,
      targetConnectionToken: parseRelayConnectionToken(record.targetConnectionToken),
      revision: positiveInteger(record.revision, 'revision'),
    }
  }
  exactKeys(record, ['type', 'sourceInstanceId', 'targetConnectionToken', 'deliveryId', 'revision', 'frame'])
  if (record.type !== 'ciphertext' || typeof record.frame !== 'string') {
    throw new TypeError('Relay coordination event type is invalid')
  }
  const frame = decodeCoordinationFrame(record.frame)
  if (frame.type !== 'ciphertext') throw new TypeError('Relay coordination frame must carry ciphertext')
  return {
    ...frame,
    sourceInstanceId: parseRelayInstanceId(record.sourceInstanceId),
    targetConnectionToken: parseRelayConnectionToken(record.targetConnectionToken),
    deliveryId: parseRelayDeliveryId(record.deliveryId),
    revision: positiveInteger(record.revision, 'revision'),
  }
}

function decodeCoordinationFrame(value: unknown): ReturnType<typeof decodeRelayMessage> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError('Relay coordination frame must use canonical base64url')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) {
    throw new TypeError('Relay coordination frame must use canonical base64url')
  }
  return decodeRelayMessage(new Uint8Array(decoded))
}

function withoutCoordination(
  event: Extract<RelayCoordinationEvent, { type: 'ciphertext' }>,
): RelayCiphertextMessage {
  const {
    sourceInstanceId: _sourceInstanceId,
    targetConnectionToken: _targetConnectionToken,
    deliveryId: _deliveryId,
    revision: _revision,
    ...frame
  } = event
  return frame
}

function withoutPeerCoordination(
  event: Extract<RelayCoordinationEvent, { type: 'peer-update' }>,
) {
  const {
    targetConnectionToken: _targetConnectionToken,
    revision: _revision,
    ...frame
  } = event
  return frame
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new TypeError('Relay coordination value contains unsupported fields')
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`Relay ${name} must be a positive integer`)
  return value as number
}

function validateKeyPrefix(keyPrefix: string): void {
  if (keyPrefix.length === 0 || keyPrefix.length > 128 || !KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new TypeError('Relay Redis keyPrefix must be 1-128 namespace characters')
  }
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  return errors
}
