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
  issue(routeId: RelayRouteId, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number | undefined>
  /** @returns the current authorized revision, or undefined for wrong/revoked authority. */
  authorize(
    routeId: RelayRouteId,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
    signal?: AbortSignal,
  ): Promise<number | undefined>
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
  instanceId: RelayInstanceId
  connectionToken: RelayConnectionToken
  revision: number
  expiresAt: number
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

  /**
   * Rotate one route to fresh authority and invalidate older attachments.
   * @param routeId - opaque route receiving new attachment authority.
   * @param endpoint - endpoint whose same-endpoint credentials the rotation replaces; defaults to desktop.
   * @returns the one-time credential grant and its persistent revision.
   */
  abstract rotateCredential(routeId: RelayRouteId, endpoint?: 'mobile' | 'desktop'): Promise<RelayCredentialGrant>
  /**
   * Issue distinct endpoint authority without invalidating other credentials on the active route.
   * @param routeId - active route receiving another independently revocable bearer.
   * @param endpoint - endpoint the new credential authorizes; defaults to mobile.
   * @returns a fresh credential at the current route revision.
   */
  abstract issueCredential(routeId: RelayRouteId, endpoint?: 'mobile' | 'desktop'): Promise<RelayCredentialGrant>
  /**
   * Remove one issued endpoint credential without revoking its route peers.
   * @param grant - exact issued authority whose ownership did not commit.
   */
  abstract revokeCredential(grant: RelayCredentialGrant): Promise<void>
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
    deliver: (message: RelayCiphertextMessage) => Promise<void>
    close?: () => void | Promise<void>
    signal?: AbortSignal
    announce?: () => Promise<void>
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
