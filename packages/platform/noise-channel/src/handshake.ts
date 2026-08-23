/** Snow XKpsk3 Personal Pairing adapter and Mobile peer. */

import {
  parsePairingCompletionId,
  parsePairingInvitationLink,
} from '@deepseek-ai/dsh-remote-access'
import type {
  PairingCompletionId,
  ActivePairingKey,
  CompletedPairingHandshake,
  PairingChallengeState,
  PairingHandshakeChallenge,
  PairingHandshakeProvider,
  PendingPairingKey,
  PersonalPairingKeyReference,
  RelayCredentialGrant,
} from '@deepseek-ai/dsh-remote-access'
import {
  finishPairingResponder,
  generateSnowKeypair,
  openPairingTransport,
  sealPairingTransport,
  writePairingMessage1,
  writePairingMessage2,
  writePairingMessage3,
} from './wasm.ts'
import { decodeSnowEndpointInvitation } from './endpoint-pairing.ts'
import { concatBytes, hexPrefix } from './bytes.ts'
import { decodeRelayAuthorityEnvelope, encodeRelayAuthorityEnvelope } from './relay-authority-envelope.ts'

const CHALLENGE_VERSION = 1
const OPEN_VERSION = 2
const FINISHED_VERSION = 3
const ACTIVE_VERSION = 4
const RECONNECT_VERSION = 5
const MOBILE_RECOVERY_PREPARED_VERSION = 6
const MOBILE_RECOVERY_FINISHED_VERSION = 7
const KEY_BYTES = 32
const CHALLENGE_BYTES = 1 + KEY_BYTES * 3
const RECONNECT_RECORD_BYTES = KEY_BYTES * 3

/** Product Snow provider; pairing grants are sealed by the completed XKpsk3 transport. */
export class SnowPairingHandshakeProvider implements PairingHandshakeProvider {
  /** Prepare one Desktop static key and one single-use pairing ephemeral. */
  async createChallenge(input: {
    invitationSecret: Uint8Array
    expiresAt: number
  }): Promise<PairingHandshakeChallenge & { desktopStaticPublicKey: Uint8Array }> {
    assertKey(input.invitationSecret, 'Snow invitation secret')
    const desktop = await generateSnowKeypair()
    const ephemeral = await generateSnowKeypair()
    const state = new Uint8Array(CHALLENGE_BYTES)
    state[0] = CHALLENGE_VERSION
    state.set(desktop.privateKey, 1)
    state.set(desktop.publicKey, 1 + KEY_BYTES)
    state.set(ephemeral.privateKey, 1 + KEY_BYTES * 2)
    desktop.privateKey.fill(0)
    ephemeral.privateKey.fill(0)
    ephemeral.publicKey.fill(0)
    return {
      desktopFingerprint: `snow-${hexPrefix(desktop.publicKey, 16)}`,
      desktopStaticPublicKey: desktop.publicKey,
      state,
    }
  }

  /** Consume Mobile message 1 and retain the exact single-use state needed for message 3. */
  async completeChallenge(input: {
    invitationSecret: Uint8Array
    challengeState: PairingChallengeState
    mobileHandshake: Uint8Array
  }): Promise<CompletedPairingHandshake> {
    assertKey(input.invitationSecret, 'Snow invitation secret')
    const challenge = decodeChallenge(input.challengeState)
    try {
      const desktopHandshake = await writePairingMessage2({
        desktopStaticPrivate: challenge.desktopPrivate,
        desktopEphemeralPrivate: challenge.ephemeralPrivate,
        psk: input.invitationSecret,
        message1: input.mobileHandshake,
      })
      return {
        handshakeHash: new Uint8Array(KEY_BYTES),
        desktopHandshake,
        pendingPairingKey: encodeOpenPending({
          ...challenge,
          psk: input.invitationSecret,
          message1: input.mobileHandshake,
        }),
      }
    } finally {
      wipeRecord(challenge)
    }
  }

  /** Finish message 3 and retain only Snow inputs required to seal the post-confirmation grant. */
  async finishChallenge(input: {
    pendingPairingKey: PendingPairingKey
    mobileFinish: Uint8Array
  }): Promise<{ handshakeHash: Uint8Array; pendingPairingKey: PendingPairingKey }> {
    const open = decodeOpenPending(input.pendingPairingKey)
    try {
      const finished = await finishPairingResponder({
        desktopStaticPrivate: open.desktopPrivate,
        desktopEphemeralPrivate: open.ephemeralPrivate,
        psk: open.psk,
        message1: open.message1,
        message3: input.mobileFinish,
      })
      return {
        handshakeHash: finished.handshakeHash,
        pendingPairingKey: encodeFinishedPending({
          ...open,
          mobilePublic: finished.mobilePublic,
          message3: input.mobileFinish,
        }),
      }
    } finally {
      wipeRecord(open)
    }
  }

  /** Activate the finished pairing without deriving authority from the public handshake hash. */
  async activatePairing(input: { pendingPairingKey: PendingPairingKey }): Promise<{
    keyReference: PersonalPairingKeyReference
    activePairingKey: ActivePairingKey
  }> {
    const finished = decodeFinishedPending(input.pendingPairingKey)
    try {
      const publicIdentity = concatBytes(finished.desktopPublic, finished.mobilePublic)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', localBytes(publicIdentity)))
      return {
        keyReference: `snow-${hexPrefix(digest, 16)}` as PersonalPairingKeyReference,
        activePairingKey: encodeFinishedPending({ ...finished }, ACTIVE_VERSION),
      }
    } finally {
      wipeRecord(finished)
    }
  }

  /** Seal the Mobile grant under the completed XKpsk3 transport, then erase invitation state. */
  async sealMobileRelayAuthority(input: {
    activePairingKey: ActivePairingKey
    grant: RelayCredentialGrant
  }): Promise<Uint8Array> {
    const active = decodeFinishedPending(input.activePairingKey, ACTIVE_VERSION)
    try {
      const sealed = await sealPairingTransport({
        desktopStaticPrivate: active.desktopPrivate,
        desktopEphemeralPrivate: active.ephemeralPrivate,
        psk: active.psk,
        message1: active.message1,
        message3: active.message3,
        plaintext: encodeRelayAuthorityEnvelope(input.grant, crypto.getRandomValues(new Uint8Array(KEY_BYTES))),
      })
      input.activePairingKey.fill(0)
      const reconnect = encodeDesktopReconnect(active)
      input.activePairingKey.set(reconnect)
      return sealed
    } finally {
      wipeRecord(active)
    }
  }

  /**
   * Export the static-key record used only to establish attachment-bound IK channels.
   * @param activePairingKey - activated Snow state after Relay authority sealing.
   * @returns independent Desktop static private/public and authenticated Mobile public keys.
   */
  exportReconnectState(activePairingKey: ActivePairingKey): Uint8Array {
    if (activePairingKey.byteLength < 1 + RECONNECT_RECORD_BYTES || activePairingKey[0] !== RECONNECT_VERSION) {
      throw new TypeError('Snow Desktop reconnect state is unavailable before Relay authority sealing')
    }
    return activePairingKey.slice(1, 1 + RECONNECT_RECORD_BYTES)
  }

  destroyChallenge(state: PairingChallengeState): void { state.fill(0) }
  destroyPendingPairing(state: PendingPairingKey): void { state.fill(0) }
  destroyPairing(activePairingKey: ActivePairingKey): void { activePairingKey.fill(0) }
}

/** Mobile half of the Snow XKpsk3 product pairing flow. */
export class SnowMobileHandshakeClient {
  private mobilePrivate: Uint8Array | undefined
  private mobilePublic: Uint8Array | undefined
  private mobileEphemeral: Uint8Array | undefined
  private desktopPublic: Uint8Array | undefined
  private psk: Uint8Array | undefined
  private message2: Uint8Array | undefined
  private finishMessage: Uint8Array | undefined
  private handshakeHash: Uint8Array | undefined
  private reconnectState: Uint8Array | undefined
  private attachmentKey: Uint8Array | undefined

  /**
   * Prepare Mobile message 1 from a complete one-time invitation.
   * @param oneTimeLink - parsed-at-boundary invitation URL.
   * @returns completion identity and XKpsk3 message 1.
   */
  async begin(oneTimeLink: string): Promise<{ completionId: PairingCompletionId; mobileHandshake: Uint8Array }> {
    const invitation = parsePairingInvitationLink(oneTimeLink)
    try {
      if (invitation.desktopStaticPublicKey === undefined) {
        throw new TypeError('Snow Personal Pairing invitation has no Desktop static public key')
      }
      return {
        completionId: parsePairingCompletionId(`snow-${crypto.randomUUID()}`),
        mobileHandshake: await this.prepare(invitation.desktopStaticPublicKey, invitation.invitationSecret),
      }
    } finally {
      invitation.invitationSecret.fill(0)
    }
  }

  /** Prepare Mobile message 1 from a Desktop-owned opaque invitation payload.
   * @param invitationPayload - mailbox-carried invitation decoded only inside Mobile.
   * @returns XKpsk3 Mobile message 1.
   */
  async beginEndpointInvitation(invitationPayload: Uint8Array): Promise<Uint8Array> {
    const invitation = decodeSnowEndpointInvitation(invitationPayload)
    try {
      return await this.prepare(invitation.desktopPublic, invitation.psk)
    } finally {
      invitation.desktopPublic.fill(0)
      invitation.psk.fill(0)
    }
  }

  /**
   * Consume Desktop message 2 and prepare Mobile message 3.
   * @param desktopHandshake - XKpsk3 responder message 2.
   */
  async acceptDesktopHandshake(desktopHandshake: Uint8Array): Promise<void> {
    const prepared = this.prepared()
    const finished = await writePairingMessage3({
      mobileStaticPrivate: prepared.mobilePrivate,
      mobileEphemeralPrivate: prepared.mobileEphemeral,
      desktopPublic: prepared.desktopPublic,
      psk: prepared.psk,
      message2: desktopHandshake,
    })
    this.message2 = desktopHandshake.slice()
    this.finishMessage = finished.message3
    this.handshakeHash = finished.handshakeHash
  }

  /** Export the prepared XKpsk3 Mobile finish message.
   * @returns XKpsk3 Mobile message 3.
   */
  exportFinishMessage(): Uint8Array {
    if (this.finishMessage === undefined) throw new Error('Snow Personal Pairing has no finish message')
    return this.finishMessage.slice()
  }

  /** Export the public authentication hash for Mobile words.
   * @returns completed XKpsk3 authentication hash.
   */
  exportAuthenticationHash(): Uint8Array {
    if (this.handshakeHash === undefined) throw new Error('Snow Personal Pairing has no authentication hash')
    return this.handshakeHash.slice()
  }

  /**
   * Open the grant as the first XKpsk3 responder transport payload and erase the invitation state.
   * @param sealedAuthority - responder transport ciphertext carrying the Mobile grant.
   * @returns validated Mobile Relay grant.
   */
  async openRelayAuthority(sealedAuthority: Uint8Array): Promise<RelayCredentialGrant> {
    const { plaintext, reconnectState } = await this.openPreparedRelayAuthority(sealedAuthority)
    try {
      const opened = decodeRelayAuthorityEnvelope(plaintext)
      this.reconnectState = reconnectState.slice()
      this.attachmentKey?.fill(0)
      this.attachmentKey = opened.attachmentKey
      this.clearInvitationState()
      return opened.grant
    } finally {
      plaintext.fill(0)
      reconnectState.fill(0)
    }
  }

  /** Open and durably settle Mobile authority before erasing the one-shot invitation state.
   * @param sealedAuthority - responder transport ciphertext carrying the Mobile grant.
   * @param persist - endpoint-owned durable commit for the opened grant and reconnect state.
   * @returns validated Mobile Relay grant after the durable commit settles.
   */
  async openRelayAuthorityDurably(
    sealedAuthority: Uint8Array,
    persist: (grant: RelayCredentialGrant, reconnectState: Uint8Array, attachmentKey: Uint8Array) => Promise<void>,
  ): Promise<RelayCredentialGrant> {
    const { plaintext, reconnectState } = await this.openPreparedRelayAuthority(sealedAuthority)
    try {
      const opened = decodeRelayAuthorityEnvelope(plaintext)
      try {
        await persist({ ...opened.grant }, reconnectState.slice(), opened.attachmentKey.slice())
      } catch (error) {
        opened.attachmentKey.fill(0)
        throw error
      }
      this.reconnectState = reconnectState.slice()
      this.attachmentKey?.fill(0)
      this.attachmentKey = opened.attachmentKey
      this.clearInvitationState()
      return opened.grant
    } finally {
      plaintext.fill(0)
      reconnectState.fill(0)
    }
  }

  private async openPreparedRelayAuthority(sealedAuthority: Uint8Array): Promise<{
    plaintext: Uint8Array
    reconnectState: Uint8Array
  }> {
    const prepared = this.prepared()
    if (this.message2 === undefined || this.finishMessage === undefined || this.mobilePublic === undefined) {
      throw new Error('Snow Personal Pairing has not finished XKpsk3')
    }
    const plaintext = await openPairingTransport({
      mobileStaticPrivate: prepared.mobilePrivate,
      mobileEphemeralPrivate: prepared.mobileEphemeral,
      desktopPublic: prepared.desktopPublic,
      psk: prepared.psk,
      message2: this.message2,
      ciphertext: sealedAuthority,
    })
    return {
      plaintext,
      reconnectState: concatBytes(prepared.mobilePrivate, this.mobilePublic, prepared.desktopPublic),
    }
  }

  /** Export endpoint-local crash recovery before the sealed grant commits.
   * @returns encoded Mobile private XKpsk3 allocation.
   */
  exportRecoveryState(): Uint8Array {
    const prepared = this.prepared()
    if (this.mobilePublic === undefined) throw new Error('Snow Personal Pairing has no Mobile public key')
    const fixed = [
      prepared.mobilePrivate, this.mobilePublic, prepared.mobileEphemeral, prepared.desktopPublic, prepared.psk,
    ]
    const finished = this.message2 !== undefined || this.finishMessage !== undefined || this.handshakeHash !== undefined
    if (!finished) return encodeVariableRecord(MOBILE_RECOVERY_PREPARED_VERSION, fixed, [])
    if (this.message2 === undefined || this.finishMessage === undefined || this.handshakeHash === undefined) {
      throw new Error('Snow Personal Pairing recovery transcript is incomplete')
    }
    return encodeVariableRecord(MOBILE_RECOVERY_FINISHED_VERSION, fixed, [
      this.message2, this.finishMessage, this.handshakeHash,
    ])
  }

  /** Restore endpoint-local XKpsk3 state after a Mobile process restart.
   * @param recovery - encoded private allocation loaded from Account-scoped storage.
   */
  restoreRecoveryState(recovery: Uint8Array): void {
    this.wipe()
    const version = recovery[0]
    const decoded = version === MOBILE_RECOVERY_PREPARED_VERSION
      ? decodeVariableRecord(recovery, MOBILE_RECOVERY_PREPARED_VERSION, 5, 0, 'Mobile prepared recovery')
      : decodeVariableRecord(recovery, MOBILE_RECOVERY_FINISHED_VERSION, 5, 3, 'Mobile finished recovery')
    this.mobilePrivate = decoded.fixed[0]?.slice()
    this.mobilePublic = decoded.fixed[1]?.slice()
    this.mobileEphemeral = decoded.fixed[2]?.slice()
    this.desktopPublic = decoded.fixed[3]?.slice()
    this.psk = decoded.fixed[4]?.slice()
    if (version === MOBILE_RECOVERY_FINISHED_VERSION) {
      this.message2 = decoded.variable[0]?.slice()
      this.finishMessage = decoded.variable[1]?.slice()
      this.handshakeHash = decoded.variable[2]?.slice()
    }
  }

  /** Export the retained endpoint static state after pairing.
   * @returns static-key record used only to establish future attachment-bound IK channels.
   */
  exportReconnectState(): Uint8Array {
    if (this.reconnectState === undefined) throw new Error('Snow Mobile reconnect state is unavailable before Relay authority opening')
    return this.reconnectState.slice()
  }

  /** Export the independent application secret delivered inside Snow transport.
   * @returns defensive attachment-key copy after Relay authority opening.
   */
  exportAttachmentKey(): Uint8Array {
    if (this.attachmentKey === undefined) throw new Error('Snow Mobile attachment key is unavailable before Relay authority opening')
    return this.attachmentKey.slice()
  }

  /** Zero all retained pairing and reconnect state. */
  wipe(): void {
    this.clearInvitationState()
    this.mobilePublic?.fill(0)
    this.reconnectState?.fill(0)
    this.attachmentKey?.fill(0)
    this.mobilePublic = undefined
    this.reconnectState = undefined
    this.attachmentKey = undefined
  }

  private clearInvitationState(): void {
    this.mobilePrivate?.fill(0)
    this.mobileEphemeral?.fill(0)
    this.desktopPublic?.fill(0)
    this.psk?.fill(0)
    this.message2?.fill(0)
    this.finishMessage?.fill(0)
    this.handshakeHash?.fill(0)
    this.mobilePrivate = undefined
    this.mobileEphemeral = undefined
    this.desktopPublic = undefined
    this.psk = undefined
    this.message2 = undefined
    this.finishMessage = undefined
    this.handshakeHash = undefined
  }

  private prepared(): {
    mobilePrivate: Uint8Array
    mobileEphemeral: Uint8Array
    desktopPublic: Uint8Array
    psk: Uint8Array
  } {
    if (this.mobilePrivate === undefined || this.mobileEphemeral === undefined
      || this.desktopPublic === undefined || this.psk === undefined) {
      throw new Error('Snow Personal Pairing has no prepared invitation')
    }
    return {
      mobilePrivate: this.mobilePrivate,
      mobileEphemeral: this.mobileEphemeral,
      desktopPublic: this.desktopPublic,
      psk: this.psk,
    }
  }

  private async prepare(desktopPublicInput: Uint8Array, pskInput: Uint8Array): Promise<Uint8Array> {
    this.wipe()
    const mobile = await generateSnowKeypair()
    const ephemeral = await generateSnowKeypair()
    this.mobilePrivate = mobile.privateKey
    this.mobilePublic = mobile.publicKey
    this.mobileEphemeral = ephemeral.privateKey
    const desktopPublic = desktopPublicInput.slice()
    const psk = pskInput.slice()
    this.desktopPublic = desktopPublic
    this.psk = psk
    ephemeral.publicKey.fill(0)
    return await writePairingMessage1({
      mobileStaticPrivate: mobile.privateKey,
      mobileEphemeralPrivate: ephemeral.privateKey,
      desktopPublic,
      psk,
    })
  }
}

interface ChallengeParts {
  desktopPrivate: Uint8Array
  desktopPublic: Uint8Array
  ephemeralPrivate: Uint8Array
}

interface OpenParts extends ChallengeParts {
  psk: Uint8Array
  message1: Uint8Array
}

interface FinishedParts extends OpenParts {
  mobilePublic: Uint8Array
  message3: Uint8Array
}

function decodeChallenge(state: Uint8Array): ChallengeParts {
  if (state.byteLength !== CHALLENGE_BYTES || state[0] !== CHALLENGE_VERSION) {
    throw new TypeError('Snow challenge state is invalid')
  }
  return {
    desktopPrivate: state.slice(1, 33),
    desktopPublic: state.slice(33, 65),
    ephemeralPrivate: state.slice(65, 97),
  }
}

function encodeOpenPending(input: OpenParts): PendingPairingKey {
  return encodeVariableRecord(OPEN_VERSION, [
    input.desktopPrivate, input.desktopPublic, input.ephemeralPrivate, input.psk,
  ], [input.message1])
}

function decodeOpenPending(state: Uint8Array): OpenParts {
  const decoded = decodeVariableRecord(state, OPEN_VERSION, 4, 1, 'open pairing')
  return {
    desktopPrivate: decoded.fixed[0] as Uint8Array,
    desktopPublic: decoded.fixed[1] as Uint8Array,
    ephemeralPrivate: decoded.fixed[2] as Uint8Array,
    psk: decoded.fixed[3] as Uint8Array,
    message1: decoded.variable[0] as Uint8Array,
  }
}

function encodeFinishedPending(input: FinishedParts, version = FINISHED_VERSION): PendingPairingKey {
  return encodeVariableRecord(version, [
    input.desktopPrivate, input.desktopPublic, input.ephemeralPrivate, input.mobilePublic, input.psk,
  ], [input.message1, input.message3])
}

function decodeFinishedPending(state: Uint8Array, version = FINISHED_VERSION): FinishedParts {
  const decoded = decodeVariableRecord(state, version, 5, 2, 'finished pairing')
  return {
    desktopPrivate: decoded.fixed[0] as Uint8Array,
    desktopPublic: decoded.fixed[1] as Uint8Array,
    ephemeralPrivate: decoded.fixed[2] as Uint8Array,
    mobilePublic: decoded.fixed[3] as Uint8Array,
    psk: decoded.fixed[4] as Uint8Array,
    message1: decoded.variable[0] as Uint8Array,
    message3: decoded.variable[1] as Uint8Array,
  }
}

function encodeDesktopReconnect(input: FinishedParts): Uint8Array {
  const value = new Uint8Array(1 + RECONNECT_RECORD_BYTES)
  value[0] = RECONNECT_VERSION
  value.set(input.desktopPrivate, 1)
  value.set(input.desktopPublic, 33)
  value.set(input.mobilePublic, 65)
  return value
}

function encodeVariableRecord(version: number, fixed: readonly Uint8Array[], variable: readonly Uint8Array[]): Uint8Array {
  for (const field of fixed) assertKey(field, 'Snow state key')
  const bytes = 1 + fixed.length * KEY_BYTES + variable.reduce((total, field) => total + 2 + field.byteLength, 0)
  const value = new Uint8Array(bytes)
  value[0] = version
  let offset = 1
  for (const field of fixed) {
    value.set(field, offset)
    offset += KEY_BYTES
  }
  for (const field of variable) {
    if (field.byteLength > 65_535) throw new TypeError('Snow state message exceeds 65535 bytes')
    value[offset] = field.byteLength >> 8
    value[offset + 1] = field.byteLength & 0xff
    offset += 2
    value.set(field, offset)
    offset += field.byteLength
  }
  return value
}

function decodeVariableRecord(
  state: Uint8Array,
  version: number,
  fixedCount: number,
  variableCount: number,
  name: string,
): { fixed: Uint8Array[]; variable: Uint8Array[] } {
  const minimum = 1 + fixedCount * KEY_BYTES + variableCount * 2
  if (state.byteLength < minimum || state[0] !== version) throw new TypeError(`Snow ${name} state is invalid`)
  let offset = 1
  const fixed: Uint8Array[] = []
  for (let index = 0; index < fixedCount; index += 1) {
    fixed.push(state.slice(offset, offset + KEY_BYTES))
    offset += KEY_BYTES
  }
  const variable: Uint8Array[] = []
  for (let index = 0; index < variableCount; index += 1) {
    const length = ((state[offset] as number) << 8) | (state[offset + 1] as number)
    offset += 2
    if (offset + length > state.byteLength) throw new TypeError(`Snow ${name} state is truncated`)
    variable.push(state.slice(offset, offset + length))
    offset += length
  }
  if (offset !== state.byteLength) throw new TypeError(`Snow ${name} state has trailing bytes`)
  return { fixed, variable }
}

function wipeRecord(record: object): void {
  for (const value of Object.values(record) as Uint8Array[]) value.fill(0)
}

function assertKey(value: Uint8Array, name: string): void {
  if (value.byteLength !== KEY_BYTES) throw new TypeError(`${name} must contain exactly 32 bytes`)
}

function localBytes(value: Uint8Array): Uint8Array<ArrayBuffer> { return new Uint8Array(value) }
