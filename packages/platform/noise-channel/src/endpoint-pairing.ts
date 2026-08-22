/** Endpoint-owned XKpsk3 state bridged by the Platform opaque pairing mailbox. */

import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  finishPairingResponder,
  generateSnowKeypair,
  sealPairingTransport,
  writePairingMessage2,
} from './wasm.ts'
import { concatBytes, hexPrefix } from './bytes.ts'

const INVITATION_VERSION = 1
const KEY_BYTES = 32
const RECONNECT_BYTES = KEY_BYTES * 3

interface DesktopPairingState {
  desktopPrivate: Uint8Array
  desktopPublic: Uint8Array
  ephemeralPrivate: Uint8Array
  psk: Uint8Array
  message1?: Uint8Array
  message2?: Uint8Array
  message3?: Uint8Array
  mobilePublic?: Uint8Array
  handshakeHash?: Uint8Array
  reconnectState?: Uint8Array
}

/** Safely protected Desktop XKpsk3 recovery allocation persisted only by the endpoint. */
export interface SnowDesktopEndpointPairingRecoveryState {
  desktopPrivate: Uint8Array
  desktopPublic: Uint8Array
  ephemeralPrivate: Uint8Array
  psk: Uint8Array
  message1?: Uint8Array
  message2?: Uint8Array
  message3?: Uint8Array
  mobilePublic?: Uint8Array
  handshakeHash?: Uint8Array
  reconnectState?: Uint8Array
}

/** Desktop-owned XKpsk3 responder whose private state never enters Platform persistence. */
export class SnowDesktopEndpointPairingOwner {
  private state: DesktopPairingState | undefined

  /** Restore endpoint-protected XKpsk3 state after a Desktop process restart.
   * @param recovery - decoded owner-only recovery allocation.
   * @returns owner resuming the exact handshake transcript.
   */
  static restore(recovery: SnowDesktopEndpointPairingRecoveryState): SnowDesktopEndpointPairingOwner {
    validateRecovery(recovery)
    const owner = new SnowDesktopEndpointPairingOwner()
    owner.state = cloneRecovery(recovery)
    return owner
  }

  /** Create one opaque public invitation payload while retaining every secret locally.
   * @param expiresAt - absolute invitation expiry.
   * @returns opaque invitation bytes and human-readable Desktop fingerprint.
   */
  async createInvitation(expiresAt: number): Promise<{ invitationPayload: Uint8Array; desktopFingerprint: string }> {
    this.wipe()
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new TypeError('Snow endpoint invitation expiry must be in the future')
    }
    const desktop = await generateSnowKeypair()
    const ephemeral = await generateSnowKeypair()
    const psk = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
    this.state = {
      desktopPrivate: desktop.privateKey,
      desktopPublic: desktop.publicKey,
      ephemeralPrivate: ephemeral.privateKey,
      psk,
    }
    ephemeral.publicKey.fill(0)
    return {
      invitationPayload: encodeInvitation({
        version: INVITATION_VERSION,
        expiresAt,
        desktopPublic: desktop.publicKey,
        psk,
      }),
      desktopFingerprint: `snow-${hexPrefix(desktop.publicKey, 16)}`,
    }
  }

  /** Consume Mobile message 1 and produce Desktop message 2.
   * @param message1 - opaque XKpsk3 initiator message from the mailbox.
   * @returns XKpsk3 responder message 2.
   */
  async acceptMessage1(message1: Uint8Array): Promise<Uint8Array> {
    const state = this.requireState()
    if (state.message1 !== undefined) {
      if (!bytesEqual(state.message1, message1) || state.message2 === undefined) {
        throw new Error('Snow endpoint message 1 replay is stale')
      }
      return state.message2.slice()
    }
    const message2 = await writePairingMessage2({
      desktopStaticPrivate: state.desktopPrivate,
      desktopEphemeralPrivate: state.ephemeralPrivate,
      psk: state.psk,
      message1,
    })
    state.message1 = message1.slice()
    state.message2 = message2.slice()
    return message2
  }

  /** Finish Mobile message 3 and authenticate its static key.
   * @param message3 - opaque XKpsk3 finish from the mailbox.
   * @returns public authentication hash for Desktop words.
   */
  async finishMessage3(message3: Uint8Array): Promise<Uint8Array> {
    const state = this.requireState()
    if (state.message1 === undefined || state.message2 === undefined) {
      throw new Error('Snow endpoint message 1 is not complete')
    }
    if (state.message3 !== undefined) {
      if (!bytesEqual(state.message3, message3) || state.handshakeHash === undefined) {
        throw new Error('Snow endpoint message 3 replay is stale')
      }
      return state.handshakeHash.slice()
    }
    const finished = await finishPairingResponder({
      desktopStaticPrivate: state.desktopPrivate,
      desktopEphemeralPrivate: state.ephemeralPrivate,
      psk: state.psk,
      message1: state.message1,
      message3,
    })
    state.message3 = message3.slice()
    state.mobilePublic = finished.mobilePublic
    state.handshakeHash = finished.handshakeHash
    return finished.handshakeHash.slice()
  }

  /** Seal Mobile Relay authority as the first completed XKpsk3 transport payload.
   * @param grant - locally assembled Mobile grant whose credential never enters Platform plaintext.
   * @returns opaque transport ciphertext for the mailbox.
   */
  async sealMobileRelayAuthority(grant: RelayCredentialGrant): Promise<Uint8Array> {
    const state = this.requireFinished()
    const sealed = await sealPairingTransport({
      desktopStaticPrivate: state.desktopPrivate,
      desktopEphemeralPrivate: state.ephemeralPrivate,
      psk: state.psk,
      message1: state.message1,
      message3: state.message3,
      plaintext: new TextEncoder().encode(JSON.stringify(grant)),
    })
    state.reconnectState = concatBytes(state.desktopPrivate, state.desktopPublic, state.mobilePublic)
    wipe(state.ephemeralPrivate, state.psk, state.message1, state.message2, state.message3, state.handshakeHash)
    return sealed
  }

  /** Export Desktop static state after Relay authority sealing.
   * @returns Desktop private/public and authenticated Mobile public keys.
   */
  exportReconnectState(): Uint8Array {
    const state = this.requireState()
    if (state.reconnectState === undefined || state.reconnectState.byteLength !== RECONNECT_BYTES) {
      throw new Error('Snow endpoint reconnect state is unavailable before grant sealing')
    }
    return state.reconnectState.slice()
  }

  /** Export a defensive copy for endpoint-protected crash recovery.
   * @returns current private handshake allocation.
   */
  exportRecoveryState(): SnowDesktopEndpointPairingRecoveryState {
    return cloneRecovery(this.requireState())
  }

  /** Read the authenticated transcript hash after message 3.
   * @returns defensive authentication hash copy.
   */
  exportAuthenticationHash(): Uint8Array {
    return this.requireFinished().handshakeHash.slice()
  }

  /** Zero every Desktop endpoint pairing allocation. */
  wipe(): void {
    if (this.state !== undefined) wipeRecord(this.state)
    this.state = undefined
  }

  private requireState(): DesktopPairingState {
    if (this.state === undefined) throw new Error('Snow endpoint pairing has no invitation state')
    return this.state
  }

  private requireFinished(): DesktopPairingState & {
    message1: Uint8Array
    message3: Uint8Array
    mobilePublic: Uint8Array
    handshakeHash: Uint8Array
  } {
    const state = this.requireState()
    if (state.message1 === undefined || state.message3 === undefined
      || state.mobilePublic === undefined || state.handshakeHash === undefined) {
      throw new Error('Snow endpoint pairing has not finished message 3')
    }
    return state as ReturnType<SnowDesktopEndpointPairingOwner['requireFinished']>
  }
}

function validateRecovery(state: SnowDesktopEndpointPairingRecoveryState): void {
  for (const [name, value] of [
    ['desktopPrivate', state.desktopPrivate], ['desktopPublic', state.desktopPublic],
    ['ephemeralPrivate', state.ephemeralPrivate], ['psk', state.psk],
  ] as const) {
    if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) {
      throw new TypeError(`Snow endpoint recovery ${name} must contain ${String(KEY_BYTES)} bytes`)
    }
  }
  if ((state.message1 === undefined) !== (state.message2 === undefined)) {
    throw new TypeError('Snow endpoint recovery messages 1 and 2 must settle together')
  }
  if (state.message3 !== undefined && (state.message1 === undefined || state.mobilePublic === undefined
    || state.handshakeHash === undefined)) {
    throw new TypeError('Snow endpoint recovery message 3 is incomplete')
  }
  if (state.reconnectState !== undefined && state.reconnectState.byteLength !== RECONNECT_BYTES) {
    throw new TypeError('Snow endpoint recovery reconnect state is invalid')
  }
}

function cloneRecovery(state: SnowDesktopEndpointPairingRecoveryState): SnowDesktopEndpointPairingRecoveryState {
  return {
    desktopPrivate: state.desktopPrivate.slice(),
    desktopPublic: state.desktopPublic.slice(),
    ephemeralPrivate: state.ephemeralPrivate.slice(),
    psk: state.psk.slice(),
    ...(state.message1 === undefined ? {} : { message1: state.message1.slice() }),
    ...(state.message2 === undefined ? {} : { message2: state.message2.slice() }),
    ...(state.message3 === undefined ? {} : { message3: state.message3.slice() }),
    ...(state.mobilePublic === undefined ? {} : { mobilePublic: state.mobilePublic.slice() }),
    ...(state.handshakeHash === undefined ? {} : { handshakeHash: state.handshakeHash.slice() }),
    ...(state.reconnectState === undefined ? {} : { reconnectState: state.reconnectState.slice() }),
  }
}

/** Decode one opaque invitation inside the Mobile endpoint, never on Platform.
 * @param payload - endpoint-owned invitation bytes received through the mailbox.
 * @returns expiry, Desktop public key, and invitation PSK for local XKpsk3.
 */
export function decodeSnowEndpointInvitation(payload: Uint8Array): {
  expiresAt: number
  desktopPublic: Uint8Array
  psk: Uint8Array
} {
  const value: unknown = JSON.parse(new TextDecoder().decode(payload))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Snow endpoint invitation must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = ['version', 'expiresAt', 'desktopPublic', 'psk']
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))) {
    throw new TypeError('Snow endpoint invitation contains unsupported fields')
  }
  if (record.version !== INVITATION_VERSION) throw new TypeError('Snow endpoint invitation version is unsupported')
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= Date.now()) {
    throw new TypeError('Snow endpoint invitation expired')
  }
  return {
    expiresAt: record.expiresAt as number,
    desktopPublic: decodeKey(record.desktopPublic, 'Desktop public key'),
    psk: decodeKey(record.psk, 'invitation PSK'),
  }
}

function encodeInvitation(input: {
  version: number
  expiresAt: number
  desktopPublic: Uint8Array
  psk: Uint8Array
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: input.version,
    expiresAt: input.expiresAt,
    desktopPublic: [...input.desktopPublic],
    psk: [...input.psk],
  }))
}

function decodeKey(value: unknown, name: string): Uint8Array {
  if (!Array.isArray(value) || value.length !== KEY_BYTES
    || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError(`Snow endpoint ${name} must contain ${String(KEY_BYTES)} bytes`)
  }
  return Uint8Array.from(value as number[])
}

function wipeRecord(record: DesktopPairingState): void {
  for (const value of Object.values(record)) if (value instanceof Uint8Array) value.fill(0)
}

function wipe(...values: Array<Uint8Array | undefined>): void {
  for (const value of values) value?.fill(0)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
