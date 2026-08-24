/** Endpoint-owned Snow IK handshake carried inside opaque Relay ciphertext frames. */

import {
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayRouteId,
  type RelayAttachmentId,
  type RelayPairingSelector,
  type RelayPeerUpdateMessage,
  type RelayReadyMessage,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  acceptSnowDesktopReconnect,
  beginSnowMobileReconnect,
  type SnowReconnectBinding,
} from './reconnect.ts'
import {
  beginSnowCompanionProtocol,
  type SnowCompanionProtocolChannel,
  type SnowCompanionProtocolNegotiation,
} from './protocol-channel.ts'

interface SnowReconnectEnvelope {
  type: 'snow-ik-1' | 'snow-ik-2'
  version: 1
  routeId: RelayRouteId
  pairingSelector: RelayPairingSelector
  desktopAttachmentId: RelayAttachmentId
  mobileAttachmentId: RelayAttachmentId
  generation: number
  message: Uint8Array
  companionOffer?: Uint8Array
}

interface PendingMobileReconnect {
  envelope: SnowReconnectEnvelope
  finish(message2: Uint8Array, desktopOffer: Uint8Array): {
    payload: Uint8Array
    finish(): SnowCompanionProtocolChannel
    cancel(): void
  }
  cancel(): void
}

/** Mobile-owned initiator for one verified Relay ready projection. */
export class SnowMobileAttachmentOwner {
  private pending: PendingMobileReconnect | undefined
  private readonly reconnectState: Uint8Array
  private disposed = false

  /** @param reconnectState - Mobile static state. @param pairingSelector - this Personal Pairing. */
  constructor(
    reconnectState: Uint8Array,
    private readonly pairingSelector: RelayPairingSelector,
    private readonly companionMajors: readonly (1 | 2 | 3 | 4)[] = [4, 3],
  ) {
    this.reconnectState = reconnectState.slice()
  }

  /**
   * Begin IK for the one Desktop peer projected under this pairing selector.
   * @param ready - route-bound Relay attachment acknowledgement.
   * @returns target attachment and encoded IK message 1.
   */
  async begin(ready: RelayReadyMessage | RelayPeerUpdateMessage): Promise<{ targetAttachmentId: RelayAttachmentId; payload: Uint8Array }> {
    if (this.disposed) throw new Error('Mobile Snow attachment owner is disposed')
    const peers = ready.peers.filter(peer => peer.pairingSelector === this.pairingSelector)
    if (peers.length !== 1) throw new Error('Mobile Snow reconnect requires exactly one Desktop peer')
    this.pending?.cancel()
    const peer = peers[0] as RelayReadyMessage['peers'][number]
    const binding: SnowReconnectBinding = {
      routeId: ready.routeId,
      pairingSelector: peer.pairingSelector,
      desktopAttachmentId: peer.attachmentId,
      mobileAttachmentId: ready.attachmentId,
      generation: peer.generation,
    }
    const attempt = await beginSnowMobileReconnect(this.reconnectState, binding)
    const envelope: SnowReconnectEnvelope = { type: 'snow-ik-1', version: 1, ...binding, message: attempt.message1 }
    this.pending = {
      envelope,
      finish: (message2, desktopOffer) => {
        const negotiation = beginSnowCompanionProtocol(
          attempt.finish(message2), 'mobile', this.companionMajors,
        )
        return {
          payload: negotiation.payload,
          finish: () => negotiation.finish(desktopOffer),
          cancel: () => { negotiation.cancel() },
        }
      },
      cancel: () => { attempt.cancel() },
    }
    return { targetAttachmentId: peer.attachmentId, payload: encodeEnvelope(envelope) }
  }

  /**
   * Finish the current IK attempt only from its exact Desktop attachment and transcript tuple.
   * @param payload - encoded IK message 2.
   * @param sourceAttachmentId - Relay-authenticated frame source.
   * @returns encrypted Mobile offer plus a codec factory for after that offer is sent.
   */
  finish(payload: Uint8Array, sourceAttachmentId: RelayAttachmentId): {
    targetAttachmentId: RelayAttachmentId
    payload: Uint8Array
    finish(): SnowCompanionProtocolChannel
    cancel(): void
  } {
    if (this.disposed) throw new Error('Mobile Snow attachment owner is disposed')
    const pending = this.pending
    if (pending === undefined) throw new Error('Mobile Snow reconnect has no pending attempt')
    const response = decodeEnvelope(payload)
    if (response.type !== 'snow-ik-2' || sourceAttachmentId !== response.desktopAttachmentId
      || response.companionOffer === undefined || !sameBinding(pending.envelope, response)) {
      throw new Error('Mobile Snow reconnect response does not match its pending attachment transcript')
    }
    this.pending = undefined
    return {
      targetAttachmentId: response.desktopAttachmentId,
      ...pending.finish(response.message, response.companionOffer),
    }
  }

  /** Cancel and zero a pending IK initiator allocation. */
  cancel(): void {
    this.pending?.cancel()
    this.pending = undefined
  }

  /** Cancel pending work and wipe the owner-held reconnect secret. */
  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.reconnectState.fill(0)
    this.disposed = true
  }
}

/** Desktop-owned responder selecting static state by a non-secret pairing selector. */
export class SnowDesktopAttachmentOwner {
  /** @param reconnectState - lookup for Desktop-owned static state. */
  constructor(
    private readonly reconnectState: (selector: RelayPairingSelector) => Uint8Array | undefined,
    private readonly companionMajors: readonly (1 | 2 | 3 | 4)[] = [4, 3],
  ) {}

  /**
   * Authenticate one Mobile IK message under the exact local Relay attachment tuple.
   * @param payload - encoded IK message 1.
   * @param sourceAttachmentId - Relay-authenticated Mobile frame source.
   * @param routeId - current local route.
   * @param attachmentId - current local Desktop attachment.
   * @returns IK message 2 with the encrypted Desktop offer and its pending codec negotiation.
   */
  async accept(
    payload: Uint8Array,
    sourceAttachmentId: RelayAttachmentId,
    routeId: RelayRouteId,
    attachmentId: RelayAttachmentId,
  ): Promise<{
    targetAttachmentId: RelayAttachmentId
    payload: Uint8Array
    negotiation: Pick<SnowCompanionProtocolNegotiation, 'finish' | 'cancel'>
    pairingSelector: RelayPairingSelector
    generation: number
  }> {
    const request = decodeEnvelope(payload)
    if (request.type !== 'snow-ik-1' || request.routeId !== routeId
      || request.desktopAttachmentId !== attachmentId
      || request.mobileAttachmentId !== sourceAttachmentId) {
      throw new Error('Desktop Snow reconnect request does not belong to its live Relay attachment')
    }
    const state = this.reconnectState(request.pairingSelector)
    if (state === undefined) throw new Error('Desktop Snow reconnect selector has no local Personal Pairing')
    const binding = bindingFromEnvelope(request)
    const accepted = await acceptSnowDesktopReconnect(state, binding, request.message)
    const negotiation = beginSnowCompanionProtocol(
      accepted.channel, 'desktop', this.companionMajors,
    )
    const response: SnowReconnectEnvelope = {
      type: 'snow-ik-2', version: 1, ...binding,
      message: accepted.message2, companionOffer: negotiation.payload,
    }
    return {
      targetAttachmentId: request.mobileAttachmentId,
      payload: encodeEnvelope(response),
      negotiation,
      pairingSelector: request.pairingSelector,
      generation: request.generation,
    }
  }
}

function encodeEnvelope(envelope: SnowReconnectEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    ...envelope,
    message: [...envelope.message],
    ...(envelope.companionOffer === undefined ? {} : { companionOffer: [...envelope.companionOffer] }),
  }))
}

function decodeEnvelope(payload: Uint8Array): SnowReconnectEnvelope {
  const value: unknown = JSON.parse(new TextDecoder().decode(payload))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Snow IK envelope must be an object')
  const record = value as Record<string, unknown>
  const keys = [
    'type', 'version', 'routeId', 'pairingSelector', 'desktopAttachmentId',
    'mobileAttachmentId', 'generation', 'message',
    ...(record.type === 'snow-ik-2' ? ['companionOffer'] : []),
  ]
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))) {
    throw new TypeError('Snow IK envelope contains unsupported fields')
  }
  if (record.type !== 'snow-ik-1' && record.type !== 'snow-ik-2') throw new TypeError('Snow IK envelope type is unsupported')
  if (record.version !== 1) throw new TypeError('Snow IK envelope version must be 1')
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) <= 0) {
    throw new TypeError('Snow IK envelope generation must be positive')
  }
  if (!Array.isArray(record.message) || record.message.length === 0
    || record.message.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError('Snow IK envelope message must contain bytes')
  }
  if (record.type === 'snow-ik-2' && (!Array.isArray(record.companionOffer)
    || record.companionOffer.length === 0
    || record.companionOffer.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
    throw new TypeError('Snow IK envelope Companion offer must contain bytes')
  }
  return {
    type: record.type,
    version: 1,
    routeId: parseRelayRouteId(record.routeId),
    pairingSelector: parseRelayPairingSelector(record.pairingSelector),
    desktopAttachmentId: parseRelayAttachmentId(record.desktopAttachmentId),
    mobileAttachmentId: parseRelayAttachmentId(record.mobileAttachmentId),
    generation: record.generation as number,
    message: Uint8Array.from(record.message as number[]),
    ...(record.type === 'snow-ik-2'
      ? { companionOffer: Uint8Array.from(record.companionOffer as number[]) }
      : {}),
  }
}

function bindingFromEnvelope(envelope: SnowReconnectEnvelope): SnowReconnectBinding {
  return {
    routeId: envelope.routeId,
    pairingSelector: envelope.pairingSelector,
    desktopAttachmentId: envelope.desktopAttachmentId,
    mobileAttachmentId: envelope.mobileAttachmentId,
    generation: envelope.generation,
  }
}

function sameBinding(left: SnowReconnectEnvelope, right: SnowReconnectEnvelope): boolean {
  return left.routeId === right.routeId
    && left.pairingSelector === right.pairingSelector
    && left.desktopAttachmentId === right.desktopAttachmentId
    && left.mobileAttachmentId === right.mobileAttachmentId
    && left.generation === right.generation
}
