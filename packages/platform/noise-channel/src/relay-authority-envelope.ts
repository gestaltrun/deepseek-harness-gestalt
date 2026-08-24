/** Endpoint-secret payload carried by the first XKpsk3 transport message. */

import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  decodeProtocolBase64Url,
  encodeProtocolBase64Url,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const ATTACHMENT_KEY_BYTES = 32

/** Encode Mobile Relay authority and the independent attachment key for Snow sealing.
 * @param grant - Mobile-specific Relay authority.
 * @param attachmentKey - endpoint-generated secret unavailable to the Relay observer.
 * @returns plaintext envelope intended only for XKpsk3 transport encryption.
 */
export function encodeRelayAuthorityEnvelope(
  grant: RelayCredentialGrant,
  attachmentKey: Uint8Array,
): Uint8Array {
  if (attachmentKey.byteLength !== ATTACHMENT_KEY_BYTES) {
    throw new TypeError('Snow attachment key must contain exactly 32 bytes')
  }
  return new TextEncoder().encode(JSON.stringify({
    grant,
    attachmentKey: encodeProtocolBase64Url(attachmentKey),
  }))
}

/** Decode an XKpsk3-opened Relay authority envelope.
 * @param plaintext - authenticated transport plaintext.
 * @returns validated grant and a defensive attachment-key allocation.
 */
export function decodeRelayAuthorityEnvelope(plaintext: Uint8Array): {
  grant: RelayCredentialGrant
  attachmentKey: Uint8Array
} {
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Snow Relay authority envelope must be an object')
  }
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).length !== 2
    || !Object.hasOwn(envelope, 'grant') || !Object.hasOwn(envelope, 'attachmentKey')) {
    throw new TypeError('Snow Relay authority envelope contains unsupported fields')
  }
  if (typeof envelope.grant !== 'object' || envelope.grant === null || Array.isArray(envelope.grant)) {
    throw new TypeError('Snow Relay authority must be an object')
  }
  const record = envelope.grant as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 5
    || keys.some(key => !['endpoint', 'routeId', 'credential', 'revision', 'pairingSelector'].includes(key))) {
    throw new TypeError('Snow Relay authority contains unsupported fields')
  }
  if (record.endpoint !== 'mobile') throw new TypeError('Snow Relay authority endpoint must be mobile')
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) <= 0) {
    throw new TypeError('Snow Relay authority revision must be positive')
  }
  const attachmentKey = decodeProtocolBase64Url(
    envelope.attachmentKey,
    ATTACHMENT_KEY_BYTES,
    'Snow attachment key',
  )
  if (attachmentKey.byteLength !== ATTACHMENT_KEY_BYTES) {
    attachmentKey.fill(0)
    throw new TypeError('Snow attachment key must contain exactly 32 bytes')
  }
  return {
    grant: {
      endpoint: 'mobile',
      routeId: parseRelayRouteId(record.routeId),
      credential: parseRelayCredential(record.credential),
      revision: record.revision as number,
      pairingSelector: parseRelayPairingSelector(record.pairingSelector),
    },
    attachmentKey,
  }
}
