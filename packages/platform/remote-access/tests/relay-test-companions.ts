/**
 * Shared in-memory Relay companions for provider specs: one route store, one
 * coordinator, deterministic entropy, and credential helpers. Test-only; the
 * deployment supplies durable counterparts.
 * @module
 */

import {
  deriveRelayCredentialDigest,
  generateRelayCredential,
  parseRelayAttachmentId,
  type RelayCiphertextMessage,
  type RelayPairingSelector,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import type {
  RelayCoordinationEvent,
  RelayDirectoryEntry,
  RelayInstanceId,
} from '../src/index.ts'
import { RemoteRelayService, type RelayCoordinator, type RelayRouteStore } from '../src/index.ts'

/** The digest operations credential helpers need from any Relay provider double. */
type RelayCredentialOperations = Pick<
  RemoteRelayService,
  'activateCredentialDigest' | 'registerCredentialDigest' | 'revokeCredentialDigest'
>

/** Bounded deterministic provider configuration shared by Relay specs. */
export const RELAY_TEST_CONFIG = {
  capacityRetryAfterMs: 1_000,
  deliveryAckTimeoutMs: 50,
  directoryTtlMs: 30_000,
  heartbeatTimeoutMs: 45_000,
  maxBufferedCiphertextBytes: 128 * 1024,
  maxConnections: 20,
  maxPendingDeliveries: 20,
} as const

interface SharedAuthority {
  endpoint: 'mobile' | 'desktop'
  pairingSelector?: RelayPairingSelector
}

/** In-memory persistent route authority shared across provider instances. */
export class SharedRouteStore implements RelayRouteStore {
  uncertain = false
  private readonly routes = new Map<string, {
    authorities: Map<string, SharedAuthority>
    revision: number
    revoked: boolean
  }>()

  async rotate(routeId: string, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    for (const [digest, owner] of authorities) if (owner.endpoint === endpoint) authorities.delete(digest)
    authorities.set(Buffer.from(credentialDigest).toString('hex'), { endpoint })
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }

  async issue(
    routeId: string,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number | undefined> {
    const current = this.routes.get(routeId)
    if (current === undefined || current.revoked) return undefined
    current.authorities.set(Buffer.from(credentialDigest).toString('hex'), {
      endpoint,
      ...(pairingSelector === undefined ? {} : { pairingSelector }),
    })
    return current.revision
  }

  async registerPairing(
    routeId: string,
    pairingSelector: RelayPairingSelector,
    desktopDigest: Uint8Array,
    mobileDigest: Uint8Array,
  ): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = current === undefined || current.revoked ? (current?.revision ?? 0) + 1 : current.revision
    const authorities = current === undefined || current.revoked
      ? new Map<string, SharedAuthority>()
      : new Map(current.authorities)
    authorities.set(Buffer.from(desktopDigest).toString('hex'), { endpoint: 'desktop', pairingSelector })
    authorities.set(Buffer.from(mobileDigest).toString('hex'), { endpoint: 'mobile', pairingSelector })
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }

  async authorize(
    routeId: string,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
  ): Promise<{ revision: number; pairingSelector?: RelayPairingSelector } | undefined> {
    if (this.uncertain) throw new Error('shared route store unavailable')
    const current = this.routes.get(routeId)
    const authority = current?.authorities.get(Buffer.from(credentialDigest).toString('hex'))
    if (current === undefined || current.revoked || authority?.endpoint !== endpoint) return undefined
    return {
      revision: current.revision,
      ...(authority.pairingSelector === undefined ? {} : { pairingSelector: authority.pairingSelector }),
    }
  }

  async revokeCredential(
    routeId: string,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
  ): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    const digest = Buffer.from(credentialDigest).toString('hex')
    if (authorities.get(digest)?.endpoint === endpoint) authorities.delete(digest)
    this.routes.set(routeId, { authorities, revision, revoked: current?.revoked ?? true })
    return revision
  }

  async revoke(routeId: string): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    this.routes.set(routeId, { authorities: new Map(), revision, revoked: true })
    return revision
  }

  advanceRevision(routeId: string): void {
    const current = this.routes.get(routeId)
    if (current === undefined) throw new Error('route missing')
    this.routes.set(routeId, { ...current, revision: current.revision + 1 })
  }
}

/** In-memory expiring directory and direct coordination shared across provider instances. */
export class SharedCoordinator implements RelayCoordinator {
  readonly events: RelayCoordinationEvent[] = []
  readonly queuedEventCount = 0
  failStop = false
  failListen = false
  failRegister = false
  failRefresh = false
  failUnregister = false
  refreshCalls = 0
  unregisterCalls = 0
  private readonly directory = new Map<string, RelayDirectoryEntry>()
  private readonly listeners = new Map<RelayInstanceId, (event: RelayCoordinationEvent) => Promise<void>>()

  async listen(
    instanceId: RelayInstanceId,
    listener: (event: RelayCoordinationEvent) => Promise<void>,
  ): Promise<() => Promise<void>> {
    if (this.failListen) throw new Error('listen failed')
    this.listeners.set(instanceId, listener)
    return async () => {
      this.listeners.delete(instanceId)
      if (this.failStop) throw new Error('stop failed')
    }
  }

  async register(entry: RelayDirectoryEntry): Promise<void> {
    if (this.failRegister) throw new Error('register failed')
    this.directory.set(key(entry.routeId, entry.attachmentId), entry)
  }

  async refresh(entry: RelayDirectoryEntry): Promise<boolean> {
    this.refreshCalls += 1
    if (this.failRefresh) return false
    const current = this.directory.get(key(entry.routeId, entry.attachmentId))
    if (current?.connectionToken !== entry.connectionToken) return false
    this.directory.set(key(entry.routeId, entry.attachmentId), entry)
    return true
  }

  async unregister(entry: RelayDirectoryEntry): Promise<void> {
    this.unregisterCalls += 1
    const entryKey = key(entry.routeId, entry.attachmentId)
    if (this.directory.get(entryKey)?.connectionToken === entry.connectionToken) this.directory.delete(entryKey)
    if (this.failUnregister) throw new Error('unregister failed')
  }

  async locate(routeId: string, attachmentId: string): Promise<RelayDirectoryEntry | undefined> {
    return this.directory.get(key(routeId, attachmentId))
  }

  async list(routeId: string): Promise<readonly RelayDirectoryEntry[]> {
    return [...this.directory.values()].filter(entry => entry.routeId === routeId)
  }

  async publish(instanceId: RelayInstanceId, event: RelayCoordinationEvent): Promise<boolean> {
    this.events.push(event)
    const listener = this.listeners.get(instanceId)
    if (listener === undefined) return false
    queueMicrotask(() => { void listener(event).catch(() => {}) })
    return true
  }

  async invalidate(event: Extract<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<void> {
    await Promise.all([...this.listeners.values()].map(listener => listener(event)))
  }

  put(entry: RelayDirectoryEntry): void { this.directory.set(key(entry.routeId, entry.attachmentId), entry) }

  async send(instanceId: RelayInstanceId, event: RelayCoordinationEvent): Promise<void> {
    await this.listeners.get(instanceId)?.(event)
  }
}

/** Rotate one freshly generated endpoint credential into the route authority. */
export async function rotateCredential(
  relay: RelayCredentialOperations,
  routeId: RelayRouteId,
  endpoint: 'mobile' | 'desktop' = 'desktop',
  pairingSelector?: RelayPairingSelector,
) {
  const credential = await generateRelayCredential()
  const revision = await relay.activateCredentialDigest(
    routeId, endpoint, await deriveRelayCredentialDigest(credential), pairingSelector,
  )
  return { routeId, endpoint, credential, revision, ...(pairingSelector === undefined ? {} : { pairingSelector }) }
}

/** Issue one freshly generated endpoint credential without touching the revision. */
export async function issueCredential(
  relay: RelayCredentialOperations,
  routeId: RelayRouteId,
  endpoint: 'mobile' | 'desktop' = 'mobile',
  pairingSelector?: RelayPairingSelector,
) {
  const credential = await generateRelayCredential()
  const revision = await relay.registerCredentialDigest(
    routeId, endpoint, await deriveRelayCredentialDigest(credential), pairingSelector,
  )
  return { routeId, endpoint, credential, revision, ...(pairingSelector === undefined ? {} : { pairingSelector }) }
}

/** Revoke exactly one endpoint credential by its derived digest. */
export async function revokeCredential(
  relay: RelayCredentialOperations,
  grant: Awaited<ReturnType<typeof rotateCredential>>,
): Promise<void> {
  await relay.revokeCredentialDigest(
    grant.routeId, grant.endpoint, await deriveRelayCredentialDigest(grant.credential),
  )
}

/**
 * Deterministic random source whose bytes also differ across calls, so endpoint-scoped
 * credential digests issued by one provider never collide in the shared route store.
 */
export function uniqueRandomBytes(seed: number): (size: number) => Uint8Array {
  let issued = 0
  return (size: number): Uint8Array => uniqueBytes(size, seed + ++issued * 101)
}

/** Deterministic reproducible byte source for ordered test entropy. */
export function uniqueBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (seed + index * 17) & 0xff
  return bytes
}

function key(routeId: string, attachmentId: string): string {
  return `${routeId}:${attachmentId}`
}

/** Build one route-scoped ciphertext frame between two attachment ids. */
export function ciphertext(
  routeId: RelayRouteId,
  sourceAttachmentId: string,
  targetAttachmentId: string,
  value: Uint8Array,
): RelayCiphertextMessage {
  return {
    type: 'ciphertext', transportVersion: 1, routeId,
    sourceAttachmentId: parseRelayAttachmentId(sourceAttachmentId),
    targetAttachmentId: parseRelayAttachmentId(targetAttachmentId),
    ciphertext: value,
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
