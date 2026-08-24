/** Browser-safe Remote Relay protocol, error, and Service Definition face. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  RelayAttachMessage,
  RelayAttachmentId,
  RelayCiphertextMessage,
  RelayCredential,
  RelayErrorCode,
  RelayHeartbeatMessage,
  RelayPeerUpdateMessage,
  RelayPairingSelector,
  RelayReadyMessage,
  RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/u

/** Opaque identity of one stateless Platform process. */
export type RelayInstanceId = Branded<'RelayInstanceId'>
/** Opaque generation preventing stale directory cleanup from deleting a replacement attachment. */
export type RelayConnectionToken = Branded<'RelayConnectionToken'>
/** Opaque content-free correlation for one bounded live delivery attempt. */
export type RelayDeliveryId = Branded<'RelayDeliveryId'>
/** Content-free SHA-256 identity of one Relay credential. */
export type RelayCredentialFingerprint = Branded<'RelayCredentialFingerprint'>

/** Durable Mobile Pairing activity projection updated by authenticated Relay lifecycle events. */
export interface RelayPairingActivitySink {
  /** Add or extend one authenticated attachment lease and optionally record its access time. */
  recordRelayLease(input: {
    credentialFingerprint: RelayCredentialFingerprint
    connectionToken: RelayConnectionToken
    expiresAt: number
    accessedAt: number
  }): Promise<void>
  /** Remove only the authenticated attachment lease identified by this connection token. */
  releaseRelayLease(input: {
    credentialFingerprint: RelayCredentialFingerprint
    connectionToken: RelayConnectionToken
    observedAt: number
  }): Promise<void>
}

/** Validated deployment tunables for one Relay provider. */
export interface RemoteRelayConfig {
  /** Retry delay returned only when a new attachment is shed at capacity. */
  capacityRetryAfterMs: number
  /** Maximum wait for the target attachment to acknowledge live delivery. */
  deliveryAckTimeoutMs: number
  /** Lifetime of one expiring shared-directory entry. */
  directoryTtlMs: number
  /** Maximum interval without an authenticated heartbeat before disconnect. */
  heartbeatTimeoutMs: number
  /** Maximum ciphertext bytes waiting for one live socket writer. */
  maxBufferedCiphertextBytes: number
  /** Maximum live attachments accepted by this Platform Instance. */
  maxConnections: number
  /** Maximum delivery acknowledgements waiting in this Platform process. */
  maxPendingDeliveries: number
}

/** Persistent, content-free route authorization required by every Platform Instance. */
export interface RelayRouteStore {
  /** @returns the new monotonically increasing route revision. */
  rotate(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number>
  /** @returns the current revision after adding endpoint-specific authority, or undefined when the route is inactive. */
  issue(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number | undefined>
  /** Atomically register distinct pairing-scoped endpoint digests, rejecting reuse by another selector. */
  registerPairing(
    routeId: RelayRouteId,
    pairingSelector: RelayPairingSelector,
    desktopCredentialDigest: Uint8Array,
    mobileCredentialDigest: Uint8Array,
  ): Promise<number>
  /** @returns current authority metadata, or undefined for wrong/revoked authority. */
  authorize(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    signal?: AbortSignal,
  ): Promise<RelayAuthorization | undefined>
  /** @returns the new revision after removing exactly one endpoint credential. */
  revokeCredential(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
  ): Promise<number>
  /** @returns the new monotonically increasing revoked revision. */
  revoke(routeId: RelayRouteId): Promise<number>
}

/** One expiring attachment location stored outside every stateless Platform Instance. */
export interface RelayDirectoryEntry {
  routeId: RelayRouteId
  attachmentId: RelayAttachmentId
  endpoint: 'mobile' | 'desktop'
  /** Mobile-only selector loaded from the credential record after authorization. */
  pairingSelector?: RelayPairingSelector
  instanceId: RelayInstanceId
  connectionToken: RelayConnectionToken
  revision: number
  expiresAt: number
}

/** Non-secret metadata returned only after one credential digest is authorized. */
export interface RelayAuthorization {
  revision: number
  pairingSelector?: RelayPairingSelector
}

/** Ciphertext-only forwarding or content-free invalidation carried between Platform Instances. */
export type RelayCoordinationEvent =
  | (RelayCiphertextMessage & {
    sourceInstanceId: RelayInstanceId
    targetConnectionToken: RelayConnectionToken
    deliveryId: RelayDeliveryId
    revision: number
  })
  | { type: 'delivered'; deliveryId: RelayDeliveryId }
  | (RelayPeerUpdateMessage & {
    targetConnectionToken: RelayConnectionToken
    revision: number
  })
  | { type: 'invalidate'; routeId: RelayRouteId; revision: number }

/** Shared ephemeral directory, invalidation, and ciphertext Pub/Sub adapter. */
export interface RelayCoordinator {
  /** Subscribe one Platform Instance to direct ephemeral events. */
  listen(
    instanceId: RelayInstanceId,
    listener: (event: RelayCoordinationEvent) => Promise<void>,
  ): Promise<() => Promise<void>>
  /** Publish or replace one expiring live-attachment directory entry. */
  register(entry: RelayDirectoryEntry, signal?: AbortSignal): Promise<void>
  /** Extend one still-current directory entry. */
  refresh(entry: RelayDirectoryEntry): Promise<boolean>
  /** Remove one entry only when its connection token is still current. */
  unregister(entry: RelayDirectoryEntry): Promise<void>
  /** Resolve one live target without creating durable delivery state. */
  locate(routeId: RelayRouteId, attachmentId: RelayAttachmentId): Promise<RelayDirectoryEntry | undefined>
  /** List current route attachments for a bounded server-control projection. */
  list(routeId: RelayRouteId): Promise<readonly RelayDirectoryEntry[]>
  /** Publish one ephemeral coordination event to a currently subscribed Platform Instance. */
  publish(instanceId: RelayInstanceId, event: Exclude<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<boolean>
  /** Fan out one content-free route invalidation. */
  invalidate(event: Extract<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<void>
}

/** One newly rotated Desktop Relay credential; only its digest enters persistence. */
export interface RelayCredentialGrant {
  routeId: RelayRouteId
  /** Endpoint kind that may present this credential. */
  endpoint: 'mobile' | 'desktop'
  credential: RelayCredential
  revision: number
  /** Mobile-only selector sealed with this grant and retained beside its digest. */
  pairingSelector?: RelayPairingSelector
}

/** Stable, content-free Relay Transport failure.
 *  HTTP Consumers map this class by `instanceof`; the host provider bundle
 *  imports it from the public package entry so both sides share one constructor. */
export class RemoteRelayError extends Error {
  /** @param code - Relay Transport failure category. @param retryAfterMs - optional capacity retry delay. */
  constructor(readonly code: RelayErrorCode, message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'RemoteRelayError'
  }
}

/** Live endpoint attachment admitted by {@link RemoteRelayService}. */
export interface RemoteRelayAttachment {
  /** Accept one decoded Relay Transport frame from this endpoint. */
  receive(message: RelayCiphertextMessage | RelayHeartbeatMessage): Promise<void>
  /** Remove this live attachment from the shared directory and drain its writer. */
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteRelay: RemoteRelayService
  }
}

/** Public Remote Access Relay capability used by the WSS Consumer. */
export abstract class RemoteRelayService extends Service {
  /** @param ctx - Platform composition context receiving the Relay capability. */
  constructor(ctx: Context) { super(ctx, 'remoteRelay') }

  /** Activate one endpoint-generated digest and replace same-endpoint authority.
   * @param routeId - route receiving endpoint-owned authority.
   * @param endpoint - endpoint kind bound to the digest.
   * @param credentialDigest - SHA-256 digest of the endpoint-owned public key.
   * @param pairingSelector - optional non-secret Personal Pairing selector.
   * @returns new route revision.
   */
  abstract activateCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number>
  /**
   * Register endpoint-generated authority without receiving its bearer credential.
   * @param routeId - active route receiving Mobile authority.
   * @param endpoint - endpoint kind bound to the digest.
   * @param credentialDigest - SHA-256 digest of the endpoint-owned credential.
   * @param pairingSelector - non-secret pairing selector retained beside the digest.
   * @returns current active route revision.
   */
  abstract registerCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    pairingSelector?: RelayPairingSelector,
  ): Promise<number>
  /** Register one pairing's endpoint-owned Desktop and Mobile digests atomically.
   * @param routeId - route allocated to the authenticated Desktop installation.
   * @param pairingSelector - non-secret Personal Pairing selector.
   * @param desktopCredentialDigest - digest of the Desktop-owned signing credential.
   * @param mobileCredentialDigest - digest of the Mobile-owned signing credential.
   * @returns active route revision shared by both endpoint authorities.
   */
  abstract registerPairingCredentialDigests(
    routeId: RelayRouteId,
    pairingSelector: RelayPairingSelector,
    desktopCredentialDigest: Uint8Array,
    mobileCredentialDigest: Uint8Array,
  ): Promise<number>
  /** Remove endpoint-generated authority by its retained digest.
   * @param routeId - route owning the authority.
   * @param endpoint - endpoint kind bound to the digest.
   * @param credentialDigest - exact retained SHA-256 digest.
   */
  abstract revokeCredentialDigest(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
  ): Promise<void>
  /**
   * Revoke one route and close its attachments across Platform Instances.
   * @param routeId - opaque route whose current authority becomes invalid.
   */
  abstract revokeRoute(routeId: RelayRouteId): Promise<void>
  /**
   * Authenticate one outbound Mobile or Desktop attachment and register it only after `announce` flushes ready.
   * @param input - attach frame, socket writer, optional close callback, and optional ready flush.
   * @returns the admitted attachment receiving later frames from that socket.
   */
  abstract attach(input: {
    message: RelayAttachMessage
    deliver: (message: RelayCiphertextMessage | RelayPeerUpdateMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: (message: RelayReadyMessage) => Promise<void>
  }): Promise<RemoteRelayAttachment>
}

/**
 * Parse an opaque Platform Instance id at a coordination boundary.
 * @param value - untrusted coordination value.
 * @returns branded Platform Instance id.
 */
export function parseRelayInstanceId(value: unknown): RelayInstanceId {
  return parseIdentifier(value, 'Relay instance id') as RelayInstanceId
}

/**
 * Parse a stale-cleanup-safe live connection token at a coordination boundary.
 * @param value - untrusted coordination value.
 * @returns branded live connection token.
 */
export function parseRelayConnectionToken(value: unknown): RelayConnectionToken {
  return parseIdentifier(value, 'Relay connection token') as RelayConnectionToken
}

/**
 * Parse a content-free live-delivery correlation at a coordination boundary.
 * @param value - untrusted coordination value.
 * @returns branded live-delivery correlation.
 */
export function parseRelayDeliveryId(value: unknown): RelayDeliveryId {
  return parseIdentifier(value, 'Relay delivery id') as RelayDeliveryId
}

/**
 * Parse a content-free Relay credential fingerprint.
 * @param value - untrusted durable or adapter value.
 * @returns branded credential fingerprint.
 */
export function parseRelayCredentialFingerprint(value: unknown): RelayCredentialFingerprint {
  return parseIdentifier(value, 'Relay credential fingerprint') as RelayCredentialFingerprint
}

function parseIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${name} must be 1-128 base64url characters`)
  }
  return value
}
