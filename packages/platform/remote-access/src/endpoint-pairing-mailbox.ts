/** Platform-owned ordering and idempotency for endpoint-owned Personal Pairing messages. */

import type { InstallationId, PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type {
  PairingDeviceDescription,
  PairingChallengeId,
  PairingCompletionId,
  PendingPairingId,
} from './index.ts'

const MAX_OPAQUE_MESSAGE_BYTES = 4_096

/** Durable opaque invitation routing metadata with no Desktop private state. */
export interface EndpointPairingMailboxChallenge {
  challengeId: PairingChallengeId
  accountId: PlatformAccountId
  desktopInstallationId: InstallationId
  expiresAt: number
  completionId?: PairingCompletionId
  pendingPairingId?: PendingPairingId
}

/** Durable ordered endpoint-message exchange and its terminal decision. */
export interface EndpointPairingMailboxPending {
  pendingPairingId: PendingPairingId
  completionId: PairingCompletionId
  challengeId: PairingChallengeId
  accountId: PlatformAccountId
  desktopInstallationId: InstallationId
  mobileInstallationId: InstallationId
  device: PairingDeviceDescription
  expiresAt: number
  message1: Uint8Array
  message2?: Uint8Array
  message3?: Uint8Array
  confirmed: boolean
  rejected: boolean
  pairingId?: import('./index.ts').PersonalPairingId
  sealedRelayAuthority?: Uint8Array
  settledAt?: number
}

/** Serializable Platform state contains only opaque messages and lifecycle metadata. */
export interface EndpointOwnedPairingMailboxState {
  challenges: readonly EndpointPairingMailboxChallenge[]
  pending: readonly EndpointPairingMailboxPending[]
}

/** Platform-allocated Desktop routing projection containing no invitation payload. */
export interface EndpointPairingChallengeView {
  challengeId: PairingChallengeId
  expiresAt: number
  routingLink: string
}

/** Desktop mailbox projection containing only endpoint-owned handshake messages. */
export type EndpointPairingDesktopView = {
  pendingPairingId: PendingPairingId
  challengeId: PairingChallengeId
} & ReturnType<EndpointOwnedPairingMailbox['readDesktop']>

/** Mobile mailbox projection used while the Desktop completes and confirms pairing. */
export type EndpointPairingMobileView = ReturnType<EndpointOwnedPairingMailbox['readMobile']>

/**
 * Ordered opaque mailbox between authenticated Desktop and Mobile installations.
 * Endpoint private keys, invitation PSKs, authentication words, and transport state never enter this owner.
 */
export class EndpointOwnedPairingMailbox {
  private readonly challenges = new Map<PairingChallengeId, EndpointPairingMailboxChallenge>()
  private readonly pending = new Map<PendingPairingId, EndpointPairingMailboxPending>()
  private readonly completions = new Map<PairingCompletionId, EndpointPairingMailboxPending>()

  /** @param options - collision-checked pending identity allocator and optional decoded state. */
  constructor(private readonly options: {
    pendingPairingId(): PendingPairingId
    state?: EndpointOwnedPairingMailboxState
  }) {
    for (const challenge of options.state?.challenges ?? []) {
      if (this.challenges.has(challenge.challengeId)) throw mailboxError('Pairing mailbox challenge state collided')
      this.challenges.set(challenge.challengeId, cloneChallenge(challenge))
    }
    for (const pending of options.state?.pending ?? []) {
      if (this.pending.has(pending.pendingPairingId) || this.completions.has(pending.completionId)) {
        throw mailboxError('Pairing mailbox pending state collided')
      }
      const record = clonePending(pending)
      this.pending.set(record.pendingPairingId, record)
      this.completions.set(record.completionId, record)
    }
  }

  /** Register one Desktop-owned invitation route.
   * @param input - authenticated ownership and expiry metadata.
   */
  createChallenge(input: EndpointPairingMailboxChallenge): void {
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) throw new TypeError('Pairing mailbox expiry must be positive')
    if (this.challenges.has(input.challengeId)) throw mailboxError('Pairing challenge id already exists')
    this.challenges.set(input.challengeId, cloneChallenge(input))
  }

  /** Store Mobile XKpsk3 message 1 once.
   * @param input - authenticated Mobile completion and opaque message 1.
   * @returns stable pending pairing identity.
   */
  submitMessage1(input: {
    challengeId: PairingChallengeId
    completionId: PairingCompletionId
    accountId: PlatformAccountId
    mobileInstallationId: InstallationId
    device: PairingDeviceDescription
    message1: Uint8Array
    now: number
  }): { pendingPairingId: PendingPairingId } {
    assertOpaque(input.message1, 'message 1')
    const replay = this.completions.get(input.completionId)
    if (replay !== undefined) {
      assertMobile(replay, input.accountId, input.mobileInstallationId)
      if (replay.challengeId !== input.challengeId || !bytesEqual(replay.message1, input.message1)) {
        throw mailboxError('Pairing message 1 replay is stale')
      }
      return { pendingPairingId: replay.pendingPairingId }
    }
    const challenge = this.challenges.get(input.challengeId)
    if (challenge === undefined) throw mailboxError('Pairing challenge is invalid')
    if (challenge.accountId !== input.accountId) throw mailboxError('Pairing challenge account does not match')
    if (input.now > challenge.expiresAt) throw mailboxError('Pairing challenge expired')
    if (challenge.completionId !== undefined) throw mailboxError('Pairing challenge was already used')
    const pendingPairingId = this.options.pendingPairingId()
    if (this.pending.has(pendingPairingId)) throw mailboxError('Pairing pending id collided')
    const record: EndpointPairingMailboxPending = {
      pendingPairingId,
      completionId: input.completionId,
      challengeId: input.challengeId,
      accountId: input.accountId,
      desktopInstallationId: challenge.desktopInstallationId,
      mobileInstallationId: input.mobileInstallationId,
      device: { ...input.device },
      expiresAt: challenge.expiresAt,
      message1: input.message1.slice(),
      confirmed: false,
      rejected: false,
    }
    challenge.completionId = input.completionId
    challenge.pendingPairingId = pendingPairingId
    this.pending.set(pendingPairingId, record)
    this.completions.set(input.completionId, record)
    return { pendingPairingId }
  }

  /** Read the current opaque Desktop work item.
   * @param pendingPairingId - pending mailbox identity.
   * @param accountId - authenticated Desktop account.
   * @param desktopInstallationId - authenticated Desktop installation.
   * @returns message 1 or message 3 stage.
   */
  readDesktop(
    pendingPairingId: PendingPairingId,
    accountId: PlatformAccountId,
    desktopInstallationId: InstallationId,
  ):
    | { stage: 'message1'; message1: Uint8Array; device: PairingDeviceDescription }
    | { stage: 'message3'; message1: Uint8Array; message2: Uint8Array; message3: Uint8Array; device: PairingDeviceDescription }
    | { stage: 'confirmed'; device: PairingDeviceDescription } {
    const record = this.requirePending(pendingPairingId)
    assertDesktop(record, accountId, desktopInstallationId)
    if (record.confirmed) return { stage: 'confirmed', device: { ...record.device } }
    if (record.message3 !== undefined && record.message2 !== undefined) return {
      stage: 'message3',
      message1: record.message1.slice(),
      message2: record.message2.slice(),
      message3: record.message3.slice(),
      device: { ...record.device },
    }
    return { stage: 'message1', message1: record.message1.slice(), device: { ...record.device } }
  }

  /** Store Desktop XKpsk3 message 2 idempotently.
   * @param input - authenticated Desktop ownership and opaque message 2.
   * @returns Mobile completion identity receiving the response.
   */
  submitMessage2(input: {
    pendingPairingId: PendingPairingId
    accountId: PlatformAccountId
    desktopInstallationId: InstallationId
    message2: Uint8Array
  }): { completionId: PairingCompletionId } {
    assertOpaque(input.message2, 'message 2')
    const record = this.requirePending(input.pendingPairingId)
    assertDesktop(record, input.accountId, input.desktopInstallationId)
    if (record.message2 !== undefined) {
      if (!bytesEqual(record.message2, input.message2)) throw mailboxError('Pairing message 2 replay is stale')
      return { completionId: record.completionId }
    }
    record.message2 = input.message2.slice()
    return { completionId: record.completionId }
  }

  /** Read Mobile response state without consuming it.
   * @param completionId - Mobile-owned idempotency identity.
   * @param accountId - authenticated Mobile account.
   * @param mobileInstallationId - authenticated Mobile installation.
   * @returns waiting, message 2, or confirmed sealed-authority state.
   */
  readMobile(
    completionId: PairingCompletionId,
    accountId: PlatformAccountId,
    mobileInstallationId: InstallationId,
  ):
    | { stage: 'awaiting-desktop'; pendingPairingId: PendingPairingId }
    | {
      stage: 'message2'
      pendingPairingId: PendingPairingId
      message2: Uint8Array
      device: PairingDeviceDescription
    }
    | { stage: 'awaiting-authority'; pendingPairingId: PendingPairingId }
    | { stage: 'rejected'; pendingPairingId: PendingPairingId }
    | { stage: 'confirmed'; pendingPairingId: PendingPairingId; pairingId: import('./index.ts').PersonalPairingId; sealedRelayAuthority: Uint8Array } {
    const record = this.completions.get(completionId)
    if (record === undefined) throw mailboxError('Pairing completion is invalid')
    assertMobile(record, accountId, mobileInstallationId)
    if (record.rejected) return { stage: 'rejected', pendingPairingId: record.pendingPairingId }
    if (record.sealedRelayAuthority !== undefined && record.pairingId !== undefined) return {
      stage: 'confirmed', pendingPairingId: record.pendingPairingId,
      pairingId: record.pairingId,
      sealedRelayAuthority: record.sealedRelayAuthority.slice(),
    }
    if (record.confirmed) return { stage: 'awaiting-authority', pendingPairingId: record.pendingPairingId }
    if (record.message2 !== undefined) return {
      stage: 'message2', pendingPairingId: record.pendingPairingId,
      message2: record.message2.slice(), device: { ...record.device },
    }
    return { stage: 'awaiting-desktop', pendingPairingId: record.pendingPairingId }
  }

  /** Store Mobile XKpsk3 message 3 idempotently.
   * @param input - authenticated Mobile ownership and opaque message 3.
   * @returns Desktop pending identity receiving the finish.
   */
  submitMessage3(input: {
    completionId: PairingCompletionId
    accountId: PlatformAccountId
    mobileInstallationId: InstallationId
    message3: Uint8Array
  }): { pendingPairingId: PendingPairingId } {
    assertOpaque(input.message3, 'message 3')
    const record = this.completions.get(input.completionId)
    if (record === undefined) throw mailboxError('Pairing completion is invalid')
    assertMobile(record, input.accountId, input.mobileInstallationId)
    if (record.message2 === undefined) throw mailboxError('Pairing message 2 is not available')
    if (record.message3 !== undefined) {
      if (!bytesEqual(record.message3, input.message3)) throw mailboxError('Pairing message 3 replay is stale')
      return { pendingPairingId: record.pendingPairingId }
    }
    record.message3 = input.message3.slice()
    return { pendingPairingId: record.pendingPairingId }
  }

  /** Confirm that authenticated Desktop finished message 3 locally.
   * @param input - Desktop ownership of the pending pairing.
   */
  confirm(input: {
    pendingPairingId: PendingPairingId
    accountId: PlatformAccountId
    desktopInstallationId: InstallationId
    pairingId: import('./index.ts').PersonalPairingId
    now: number
  }): void {
    const record = this.requirePending(input.pendingPairingId)
    assertDesktop(record, input.accountId, input.desktopInstallationId)
    if (record.message3 === undefined) throw mailboxError('Pairing message 3 is not available')
    if (record.rejected) throw mailboxError('Pairing was rejected')
    if (record.confirmed && record.pairingId !== input.pairingId) throw mailboxError('Pairing confirmation replay is stale')
    record.confirmed = true
    record.pairingId = input.pairingId
    record.settledAt ??= input.now
  }

  /** Remove one unused endpoint invitation owned by Desktop.
   * @param challengeId - invitation identity to remove.
   * @param accountId - authenticated owning Account.
   * @param desktopInstallationId - authenticated owning Desktop Installation.
   */
  cancelChallenge(challengeId: PairingChallengeId, accountId: PlatformAccountId, desktopInstallationId: InstallationId): void {
    const challenge = this.challenges.get(challengeId)
    if (challenge === undefined || challenge.accountId !== accountId
      || challenge.desktopInstallationId !== desktopInstallationId || challenge.pendingPairingId !== undefined) {
      throw mailboxError('Pairing challenge is invalid or unavailable')
    }
    this.challenges.delete(challengeId)
  }

  /** Mark one unconfirmed endpoint pairing rejected for Mobile polling.
   * @param input - authenticated Desktop ownership and pending identity.
   */
  reject(input: {
    pendingPairingId: PendingPairingId
    accountId: PlatformAccountId
    desktopInstallationId: InstallationId
    now: number
  }): void {
    const record = this.requirePending(input.pendingPairingId)
    assertDesktop(record, input.accountId, input.desktopInstallationId)
    if (record.confirmed) throw mailboxError('Pairing is already confirmed')
    record.rejected = true
    record.settledAt ??= input.now
  }

  /** Expire invitations, retain terminal outcomes briefly, and bound durable state growth.
   * @param now - current epoch milliseconds.
   * @param replayRetentionMs - terminal replay retention lifetime.
   */
  evict(now: number, replayRetentionMs: number): void {
    const cutoff = now - replayRetentionMs
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(challengeId)
    }
    for (const [pendingPairingId, record] of this.pending) {
      if (!record.confirmed && !record.rejected && record.expiresAt <= now) {
        record.rejected = true
        record.settledAt = now
        record.message1.fill(0)
        record.message2?.fill(0)
        record.message3?.fill(0)
      }
      if (record.settledAt !== undefined && record.settledAt <= cutoff) {
        this.pending.delete(pendingPairingId)
        this.completions.delete(record.completionId)
        record.message1.fill(0)
        record.message2?.fill(0)
        record.message3?.fill(0)
        record.sealedRelayAuthority?.fill(0)
      }
    }
  }

  /** Reject every retained record owned by a disabled Desktop installation.
   * @param accountId - owning Platform Account.
   * @param desktopInstallationId - disabled Desktop installation.
   * @param now - terminal settlement time.
   */
  disable(accountId: PlatformAccountId, desktopInstallationId: InstallationId, now: number): void {
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.accountId === accountId && challenge.desktopInstallationId === desktopInstallationId) {
        this.challenges.delete(challengeId)
      }
    }
    for (const record of this.pending.values()) {
      if (record.accountId === accountId && record.desktopInstallationId === desktopInstallationId) {
        record.rejected = true
        record.settledAt ??= now
        record.sealedRelayAuthority?.fill(0)
        delete record.sealedRelayAuthority
      }
    }
  }

  /** Store Desktop-sealed Relay authority without inspecting it.
   * @param input - confirmed Desktop ownership and sealed bytes.
   */
  deliverSealedAuthority(input: {
    pendingPairingId: PendingPairingId
    accountId: PlatformAccountId
    desktopInstallationId: InstallationId
    sealedRelayAuthority: Uint8Array
  }): void {
    assertOpaque(input.sealedRelayAuthority, 'sealed Relay authority')
    const record = this.requirePending(input.pendingPairingId)
    assertDesktop(record, input.accountId, input.desktopInstallationId)
    if (!record.confirmed) throw mailboxError('Pairing is not confirmed')
    if (record.sealedRelayAuthority !== undefined
      && !bytesEqual(record.sealedRelayAuthority, input.sealedRelayAuthority)) {
      throw mailboxError('Sealed Relay authority replay is stale')
    }
    record.sealedRelayAuthority ??= input.sealedRelayAuthority.slice()
  }

  /** Export a defensive copy for the deployment-owned state codec.
   * @returns opaque mailbox state with no endpoint private allocation.
   */
  exportState(): EndpointOwnedPairingMailboxState {
    return {
      challenges: [...this.challenges.values()].map(cloneChallenge),
      pending: [...this.pending.values()].map(clonePending),
    }
  }

  private requirePending(pendingPairingId: PendingPairingId): EndpointPairingMailboxPending {
    const record = this.pending.get(pendingPairingId)
    if (record === undefined) throw mailboxError('Pairing pending identity is invalid')
    return record
  }
}

function assertDesktop(
  record: EndpointPairingMailboxPending,
  accountId: PlatformAccountId,
  installationId: InstallationId,
): void {
  if (record.accountId !== accountId) throw mailboxError('Pairing mailbox account does not match')
  if (record.desktopInstallationId !== installationId) throw mailboxError('Pairing mailbox Desktop installation does not match')
}

function assertMobile(
  record: EndpointPairingMailboxPending,
  accountId: PlatformAccountId,
  installationId: InstallationId,
): void {
  if (record.accountId !== accountId) throw mailboxError('Pairing mailbox account does not match')
  if (record.mobileInstallationId !== installationId) throw mailboxError('Pairing mailbox Mobile installation does not match')
}

function assertOpaque(value: Uint8Array, name: string): void {
  if (value.byteLength === 0 || value.byteLength > MAX_OPAQUE_MESSAGE_BYTES) {
    throw new TypeError(`Pairing mailbox ${name} must contain 1-${String(MAX_OPAQUE_MESSAGE_BYTES)} bytes`)
  }
}

function cloneChallenge(record: EndpointPairingMailboxChallenge): EndpointPairingMailboxChallenge {
  return { ...record }
}

function clonePending(record: EndpointPairingMailboxPending): EndpointPairingMailboxPending {
  return {
    ...record,
    device: { ...record.device },
    message1: record.message1.slice(),
    ...(record.message2 === undefined ? {} : { message2: record.message2.slice() }),
    ...(record.message3 === undefined ? {} : { message3: record.message3.slice() }),
    ...(record.sealedRelayAuthority === undefined
      ? {}
      : { sealedRelayAuthority: record.sealedRelayAuthority.slice() }),
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function mailboxError(message: string): Error { return new Error(message) }
