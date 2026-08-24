/** Attachment-bound Snow IK reconnect and ordered Companion transport. */

import type {
  RelayAttachmentId,
  RelayPairingSelector,
  RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { createIkInitiator, createIkResponder, type NoiseTransport } from './wasm.ts'

const RECORD_BYTES = 96

/** Values authenticated in one physical Relay attachment's IK transcript. */
export interface SnowReconnectBinding {
  routeId: RelayRouteId
  pairingSelector: RelayPairingSelector
  desktopAttachmentId: RelayAttachmentId
  mobileAttachmentId: RelayAttachmentId
  generation: number
}

/** Ordered authenticated Companion channel owned by one completed IK handshake. */
export class SnowCompanionChannel {
  /** @param transport - Snow transport state with independent send and receive nonces. */
  constructor(private readonly transport: NoiseTransport) {}

  /** Encrypt one transport payload.
   * @param plaintext - one versioned Companion message.
   * @returns ordered authenticated ciphertext.
   */
  seal(plaintext: Uint8Array): Uint8Array { return this.transport.seal(plaintext) }
  /** Open one ordered transport payload.
   * @param ciphertext - next ordered authenticated ciphertext.
   * @returns decrypted Companion message.
   */
  open(ciphertext: Uint8Array): Uint8Array { return this.transport.open(ciphertext) }
  /** Zero and release the WebAssembly transport allocation. */
  dispose(): void { this.transport.free() }
}

/**
 * Begin Mobile IK with a fresh Snow-generated ephemeral for this exact attachment tuple.
 * @param mobileState - Mobile static private/public and authenticated Desktop public state.
 * @param binding - route, selector, attachment ids, and connection generation.
 * @returns message 1 plus single-settlement finish and cancellation operations.
 */
export async function beginSnowMobileReconnect(
  mobileState: Uint8Array,
  binding: SnowReconnectBinding,
): Promise<{
  message1: Uint8Array
  finish(message2: Uint8Array): SnowCompanionChannel
  cancel(): void
}> {
  const keys = decodeMobileState(mobileState)
  const initiator = await createIkInitiator(keys.mobilePrivate, keys.desktopPublic, encodeBinding(binding))
  wipe(keys.mobilePublic)
  const message1 = initiator.message1()
  let open = true
  return {
    message1,
    finish: (message2) => {
      if (!open) throw new Error('Snow Mobile reconnect attempt is already settled')
      open = false
      try {
        return new SnowCompanionChannel(initiator.finish(message2))
      } finally {
        initiator.free()
        wipe(keys.mobilePrivate, keys.desktopPublic)
      }
    },
    cancel: () => {
      if (!open) return
      open = false
      initiator.free()
      wipe(keys.mobilePrivate, keys.desktopPublic)
    },
  }
}

/**
 * Authenticate one Mobile static and finish Desktop IK for this exact attachment tuple.
 * @param desktopState - Desktop static private/public and authenticated Mobile public state.
 * @param binding - route, selector, attachment ids, and connection generation.
 * @param message1 - IK initiator message 1.
 * @returns responder message 2 and ordered Desktop transport.
 */
export async function acceptSnowDesktopReconnect(
  desktopState: Uint8Array,
  binding: SnowReconnectBinding,
  message1: Uint8Array,
): Promise<{ message2: Uint8Array; channel: SnowCompanionChannel }> {
  const keys = decodeDesktopState(desktopState)
  const responder = await createIkResponder(keys.desktopPrivate, keys.mobilePublic, encodeBinding(binding))
  try {
    const message2 = responder.accept(message1)
    return { message2, channel: new SnowCompanionChannel(responder.finish()) }
  } finally {
    responder.free()
    wipe(keys.desktopPrivate, keys.desktopPublic, keys.mobilePublic)
  }
}

function encodeBinding(binding: SnowReconnectBinding): Uint8Array {
  if (!Number.isSafeInteger(binding.generation) || binding.generation <= 0) {
    throw new TypeError('Snow reconnect generation must be a positive safe integer')
  }
  return new TextEncoder().encode(JSON.stringify([
    'dsh-mobile-companion-ik-v1',
    binding.routeId,
    binding.pairingSelector,
    binding.desktopAttachmentId,
    binding.mobileAttachmentId,
    binding.generation,
  ]))
}

function decodeMobileState(value: Uint8Array): {
  mobilePrivate: Uint8Array
  mobilePublic: Uint8Array
  desktopPublic: Uint8Array
} {
  assertRecord(value, 'Mobile')
  return { mobilePrivate: value.slice(0, 32), mobilePublic: value.slice(32, 64), desktopPublic: value.slice(64) }
}

function decodeDesktopState(value: Uint8Array): {
  desktopPrivate: Uint8Array
  desktopPublic: Uint8Array
  mobilePublic: Uint8Array
} {
  assertRecord(value, 'Desktop')
  return { desktopPrivate: value.slice(0, 32), desktopPublic: value.slice(32, 64), mobilePublic: value.slice(64) }
}

function assertRecord(value: Uint8Array, endpoint: string): void {
  if (value.byteLength !== RECORD_BYTES) throw new TypeError(`Snow ${endpoint} reconnect state must contain ${String(RECORD_BYTES)} bytes`)
}

function wipe(...values: Uint8Array[]): void {
  for (const value of values) value.fill(0)
}
