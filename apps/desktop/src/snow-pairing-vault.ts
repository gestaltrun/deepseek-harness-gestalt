/** Desktop process ownership for endpoint Snow invitations and reconnect static state. */

import {
  SnowDesktopEndpointPairingOwner,
  type SnowDesktopEndpointPairingRecoveryState,
} from '@deepseek-ai/dsh-noise-channel'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  type EndpointPairingConfirmation,
  parsePairingChallengeId,
  parsePendingPairingId,
  parsePersonalPairingId,
  type RelayCredentialGrant,
  type PairingChallengeId,
  type PendingPairingId,
  type PersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import {
  deriveRelayCredentialDigest,
  generateRelayCredential,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
  type RelayCredential,
  type RelayPairingSelector,
  type RelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

const MAX_PAIRING_STATES = 16

interface PersistedSnowPairingState {
  pairingId: PersonalPairingId
  reconnectState: Uint8Array
  desktopGrant: RelayCredentialGrant
}

interface DesktopSnowConfirmationTransaction {
  desktopCredential: RelayCredential
  desktopCredentialDigest: Uint8Array
  mobileCredential: RelayCredential
  mobileCredentialDigest: Uint8Array
  pairingId?: PersonalPairingId
  routeId?: RelayRouteId
  relayRevision?: number
  sealedRelayAuthority?: Uint8Array
  reconnectState?: Uint8Array
}

interface DesktopSnowVaultState {
  active: readonly PersistedSnowPairingState[]
  challenges: ReadonlyArray<{ challengeId: PairingChallengeId; recovery: SnowDesktopEndpointPairingRecoveryState }>
  pending: ReadonlyArray<{ pendingPairingId: PendingPairingId; recovery: SnowDesktopEndpointPairingRecoveryState }>
  confirmations: ReadonlyArray<{ pendingPairingId: PendingPairingId; transaction: DesktopSnowConfirmationTransaction }>
}

interface DesktopSnowPairingStore {
  load(): Promise<DesktopSnowVaultState>
  save(state: DesktopSnowVaultState): Promise<void>
}

/** Encryption operations supplied by Electron safeStorage. */
export interface DesktopSnowPairingProtection {
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

/** Encrypted owner-only persistence for Desktop Snow reconnect state. */
export class EncryptedDesktopSnowPairingStore {
  constructor(private readonly path: string, private readonly protection: DesktopSnowPairingProtection) {}

  async load(): Promise<DesktopSnowVaultState> {
    let encoded: string
    try { encoded = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyVaultState()
      throw error
    }
    const value: unknown = JSON.parse(this.protection.decrypt(Buffer.from(encoded, 'base64')))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Desktop Snow pairing store must contain an object')
    }
    const document = value as Record<string, unknown>
    const active = boundedArray(document.active, 'active').map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new TypeError('Desktop Snow pairing store record must be an object')
      }
      const record = item as Record<string, unknown>
      if (Object.keys(record).length !== 3 || typeof record.state !== 'string'
        || typeof record.desktopGrant !== 'object' || record.desktopGrant === null) {
        throw new TypeError('Desktop Snow pairing store record is invalid')
      }
      const reconnectState = new Uint8Array(Buffer.from(record.state, 'base64url'))
      if (reconnectState.byteLength !== 96) throw new TypeError('Desktop Snow reconnect state must contain 96 bytes')
      const grant = record.desktopGrant as Record<string, unknown>
      if (grant.endpoint !== 'desktop' || !Number.isSafeInteger(grant.revision)
        || (grant.revision as number) < 1) {
        throw new TypeError('Desktop Snow Relay grant is invalid')
      }
      return {
        pairingId: parsePersonalPairingId(record.pairingId), reconnectState,
        desktopGrant: {
          routeId: parseRelayRouteId(grant.routeId), endpoint: 'desktop',
          credential: parseRelayCredential(grant.credential), revision: grant.revision as number,
          pairingSelector: parseRelayPairingSelector(grant.pairingSelector),
        },
      }
    })
    const challenges = boundedArray(document.challenges, 'challenges').map((item) => {
      const record = recordValue(item, 'challenge')
      return {
        challengeId: parsePairingChallengeId(record.challengeId),
        recovery: decodeRecovery(record.recovery),
      }
    })
    const pending = boundedArray(document.pending, 'pending').map((item) => {
      const record = recordValue(item, 'pending')
      return {
        pendingPairingId: parsePendingPairingId(record.pendingPairingId),
        recovery: decodeRecovery(record.recovery),
      }
    })
    const confirmations = boundedArray(document.confirmations, 'confirmations').map((item) => {
      const record = recordValue(item, 'confirmation')
      return {
        pendingPairingId: parsePendingPairingId(record.pendingPairingId),
        transaction: decodeConfirmation(record.transaction),
      }
    })
    const state = { active, challenges, pending, confirmations }
    assertVaultCapacity(state)
    return state
  }

  async save(state: DesktopSnowVaultState): Promise<void> {
    const plaintext = JSON.stringify({
      active: state.active.map(record => ({
        pairingId: record.pairingId,
        state: Buffer.from(record.reconnectState).toString('base64url'),
        desktopGrant: { ...record.desktopGrant },
      })),
      challenges: state.challenges.map(record => ({
        challengeId: record.challengeId, recovery: encodeByteRecord(record.recovery),
      })),
      pending: state.pending.map(record => ({
        pendingPairingId: record.pendingPairingId, recovery: encodeByteRecord(record.recovery),
      })),
      confirmations: state.confirmations.map(record => ({
        pendingPairingId: record.pendingPairingId,
        transaction: encodeConfirmation(record.transaction),
      })),
    })
    const encrypted = this.protection.encrypt(plaintext)
    await writeFileAtomic(this.path, Buffer.from(encrypted).toString('base64'), { mode: 0o600, dirMode: 0o700 })
  }
}

/** Endpoint-private Snow state never passed to Platform transports or codecs. */
export class DesktopSnowPairingVault {
  private readonly challenges = new Map<PairingChallengeId, SnowDesktopEndpointPairingOwner>()
  private readonly pending = new Map<PendingPairingId, SnowDesktopEndpointPairingOwner>()
  private readonly active = new Map<PersonalPairingId, { reconnectState: Uint8Array; desktopGrant: RelayCredentialGrant }>()
  private readonly confirmations = new Map<PendingPairingId, DesktopSnowConfirmationTransaction>()
  private persistence: Promise<void> = Promise.resolve()

  constructor(private readonly store?: DesktopSnowPairingStore) {}

  /** Load encrypted reconnect state before the Relay lifecycle can attach. */
  static async load(store?: DesktopSnowPairingStore): Promise<DesktopSnowPairingVault> {
    const vault = new DesktopSnowPairingVault(store)
    const state = await store?.load() ?? emptyVaultState()
    assertVaultCapacity(state)
    for (const record of state.active) vault.active.set(record.pairingId, {
      reconnectState: record.reconnectState.slice(), desktopGrant: { ...record.desktopGrant },
    })
    for (const record of state.challenges) {
      vault.challenges.set(record.challengeId, SnowDesktopEndpointPairingOwner.restore(record.recovery))
    }
    for (const record of state.pending) {
      vault.pending.set(record.pendingPairingId, SnowDesktopEndpointPairingOwner.restore(record.recovery))
    }
    for (const record of state.confirmations) {
      vault.confirmations.set(record.pendingPairingId, cloneConfirmation(record.transaction))
    }
    return vault
  }

  /** @returns a fresh endpoint-owned invitation owner and public invitation projection. */
  async createInvitation(expiresAt: number): Promise<{
    owner: SnowDesktopEndpointPairingOwner
    invitationPayload: Uint8Array
    desktopFingerprint: string
  }> {
    if (this.retainedPairingCount() >= MAX_PAIRING_STATES) {
      throw new Error('Desktop Snow pending pairing limit reached')
    }
    const owner = new SnowDesktopEndpointPairingOwner()
    return { owner, ...await owner.createInvitation(expiresAt) }
  }

  /** Retain one invitation under the Platform-assigned challenge id. */
  retainChallenge(challengeId: PairingChallengeId, owner: SnowDesktopEndpointPairingOwner): void {
    const previous = this.challenges.get(challengeId)
    if (previous !== undefined && previous !== owner) throw new Error('Desktop Snow challenge id collided')
    if (previous === undefined && this.retainedPairingCount() >= MAX_PAIRING_STATES) {
      throw new Error('Desktop Snow pending pairing limit reached')
    }
    this.challenges.set(challengeId, owner)
    this.persist()
  }

  /** Move one invitation owner to its stable pending identity. */
  bindPending(challengeId: PairingChallengeId, pendingPairingId: PendingPairingId): SnowDesktopEndpointPairingOwner {
    const existing = this.pending.get(pendingPairingId)
    if (existing !== undefined) return existing
    const owner = this.challenges.get(challengeId)
    if (owner === undefined) throw new Error('Desktop Snow mailbox has no local invitation owner')
    this.challenges.delete(challengeId)
    this.pending.set(pendingPairingId, owner)
    this.persist()
    return owner
  }

  /** Persist the latest pending Snow transcript before publishing another mailbox stage. */
  async checkpointPending(pendingPairingId: PendingPairingId): Promise<void> {
    if (!this.pending.has(pendingPairingId)) throw new Error('Desktop Snow pairing has no pending endpoint owner')
    this.persist()
    await this.flush()
  }

  /** Read a pending endpoint-owned handshake. */
  pendingOwner(pendingPairingId: PendingPairingId): SnowDesktopEndpointPairingOwner | undefined {
    return this.pending.get(pendingPairingId)
  }

  /** @returns whether a durable local credential transaction can resume Platform confirmation. */
  hasConfirmation(pendingPairingId: PendingPairingId): boolean {
    return this.confirmations.has(pendingPairingId)
  }

  /** @returns the authentication hash retained by one finished pending owner. */
  pendingAuthenticationHash(pendingPairingId: PendingPairingId): Uint8Array {
    const owner = this.pending.get(pendingPairingId)
    if (owner === undefined) throw new Error('Desktop Snow pairing has no pending endpoint owner')
    return owner.exportAuthenticationHash()
  }

  /** Create or replay the local credential transaction used for Platform confirmation. */
  async prepareConfirmation(pendingPairingId: PendingPairingId): Promise<{
    desktopCredentialDigest: Uint8Array
    mobileCredentialDigest: Uint8Array
  }> {
    if (!this.pending.has(pendingPairingId)) throw new Error('Desktop Snow pairing has no pending endpoint owner')
    let transaction = this.confirmations.get(pendingPairingId)
    if (transaction === undefined) {
      const desktopCredential = await generateRelayCredential()
      const mobileCredential = await generateRelayCredential()
      transaction = {
        desktopCredential,
        desktopCredentialDigest: await deriveRelayCredentialDigest(desktopCredential),
        mobileCredential,
        mobileCredentialDigest: await deriveRelayCredentialDigest(mobileCredential),
      }
      this.confirmations.set(pendingPairingId, transaction)
      this.persist()
      await this.flush()
    }
    return {
      desktopCredentialDigest: transaction.desktopCredentialDigest.slice(),
      mobileCredentialDigest: transaction.mobileCredentialDigest.slice(),
    }
  }

  /** Seal or replay the exact Mobile authority belonging to a confirmed digest transaction. */
  async prepareSealedAuthority(
    pendingPairingId: PendingPairingId,
    confirmation: EndpointPairingConfirmation,
  ): Promise<{ pairingId: PersonalPairingId; sealedRelayAuthority: Uint8Array }> {
    const transaction = this.confirmations.get(pendingPairingId)
    const owner = this.pending.get(pendingPairingId)
    if (transaction === undefined || owner === undefined) {
      throw new Error('Desktop Snow confirmation transaction is unavailable')
    }
    if (transaction.pairingId !== undefined) {
      if (transaction.pairingId !== confirmation.pairing.id
        || transaction.routeId !== confirmation.routeId
        || transaction.relayRevision !== confirmation.relayRevision
        || transaction.sealedRelayAuthority === undefined || transaction.reconnectState === undefined) {
        throw new Error('Desktop Snow confirmation response replay is stale')
      }
      return {
        pairingId: transaction.pairingId,
        sealedRelayAuthority: transaction.sealedRelayAuthority.slice(),
      }
    }
    const grant = {
      routeId: confirmation.routeId,
      endpoint: 'mobile' as const,
      credential: transaction.mobileCredential,
      revision: confirmation.relayRevision,
      pairingSelector: parseRelayPairingSelector(confirmation.pairing.id),
    }
    const sealedRelayAuthority = await owner.sealMobileRelayAuthority(grant)
    transaction.pairingId = confirmation.pairing.id
    transaction.routeId = confirmation.routeId
    transaction.relayRevision = confirmation.relayRevision
    transaction.sealedRelayAuthority = sealedRelayAuthority.slice()
    transaction.reconnectState = owner.exportReconnectState()
    this.persist()
    await this.flush()
    return { pairingId: confirmation.pairing.id, sealedRelayAuthority }
  }

  /** Read the pairing-scoped Desktop Relay grant before committing its transaction. */
  desktopRelayGrant(pendingPairingId: PendingPairingId): RelayCredentialGrant {
    const transaction = this.confirmations.get(pendingPairingId)
    if (transaction?.pairingId === undefined || transaction.routeId === undefined
      || transaction.relayRevision === undefined) {
      throw new Error('Desktop Snow confirmation transaction has no Relay grant')
    }
    return {
      routeId: transaction.routeId,
      endpoint: 'desktop',
      credential: transaction.desktopCredential,
      revision: transaction.relayRevision,
      pairingSelector: parseRelayPairingSelector(transaction.pairingId),
    }
  }

  /** Persist the active reconnect state before discarding the retryable confirmation transaction. */
  async commitConfirmation(pendingPairingId: PendingPairingId): Promise<void> {
    const transaction = this.confirmations.get(pendingPairingId)
    if (transaction?.pairingId === undefined || transaction.reconnectState === undefined) {
      throw new Error('Desktop Snow confirmation transaction is incomplete')
    }
    const previous = this.active.get(transaction.pairingId)
    previous?.reconnectState.fill(0)
    this.active.set(transaction.pairingId, {
      reconnectState: transaction.reconnectState.slice(),
      desktopGrant: this.desktopRelayGrant(pendingPairingId),
    })
    this.persist(pendingPairingId)
    await this.flush()
    this.pending.get(pendingPairingId)?.wipe()
    this.pending.delete(pendingPairingId)
    wipeConfirmation(transaction)
    this.confirmations.delete(pendingPairingId)
  }

  /** Drop and zero one unused invitation. */
  cancelChallenge(challengeId: PairingChallengeId): void {
    this.challenges.get(challengeId)?.wipe()
    this.challenges.delete(challengeId)
    this.persist()
  }

  /** Drop and zero one rejected pending handshake. */
  rejectPending(pendingPairingId: PendingPairingId): void {
    this.pending.get(pendingPairingId)?.wipe()
    this.pending.delete(pendingPairingId)
    const confirmation = this.confirmations.get(pendingPairingId)
    if (confirmation !== undefined) wipeConfirmation(confirmation)
    this.confirmations.delete(pendingPairingId)
    this.persist()
  }

  /** Read a defensive reconnect-state copy by Relay pairing selector. */
  reconnectState(selector: RelayPairingSelector): Uint8Array | undefined {
    return this.active.get(selector as PersonalPairingId)?.reconnectState.slice()
  }

  /** @returns copies of every pairing-scoped Desktop Relay grant. */
  desktopRelayGrants(): readonly RelayCredentialGrant[] {
    return [...this.active.values()].map(record => ({ ...record.desktopGrant }))
  }

  /** Drop one active pairing and zero its static state. */
  release(pairingId: PersonalPairingId): void {
    const state = this.active.get(pairingId)
    state?.reconnectState.fill(0)
    this.active.delete(pairingId)
    this.persist()
  }

  /** Zero every endpoint-owned invitation and reconnect allocation. */
  clear(): void {
    for (const owner of this.challenges.values()) owner.wipe()
    for (const owner of this.pending.values()) owner.wipe()
    for (const state of this.active.values()) state.reconnectState.fill(0)
    for (const confirmation of this.confirmations.values()) wipeConfirmation(confirmation)
    this.challenges.clear()
    this.pending.clear()
    this.active.clear()
    this.confirmations.clear()
    this.persist()
  }

  /** Wait until every encrypted atomic replacement queued by this owner completes. */
  async flush(): Promise<void> { await this.persistence }

  private persist(excludePendingPairingId?: PendingPairingId): void {
    if (this.store === undefined) return
    const state: DesktopSnowVaultState = {
      active: [...this.active].map(([pairingId, record]) => ({
        pairingId, reconnectState: record.reconnectState.slice(), desktopGrant: { ...record.desktopGrant },
      })),
      challenges: [...this.challenges].map(([challengeId, owner]) => ({
        challengeId, recovery: owner.exportRecoveryState(),
      })),
      pending: [...this.pending].filter(([pendingPairingId]) => pendingPairingId !== excludePendingPairingId)
        .map(([pendingPairingId, owner]) => ({
          pendingPairingId, recovery: owner.exportRecoveryState(),
        })),
      confirmations: [...this.confirmations]
        .filter(([pendingPairingId]) => pendingPairingId !== excludePendingPairingId)
        .map(([pendingPairingId, transaction]) => ({
          pendingPairingId, transaction: cloneConfirmation(transaction),
        })),
    }
    assertVaultCapacity(state)
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      try { await this.store?.save(state) } finally { wipeVaultState(state) }
    })
  }

  private retainedPairingCount(): number {
    return this.active.size + this.challenges.size + this.pending.size
  }
}

function emptyVaultState(): DesktopSnowVaultState {
  return { active: [], challenges: [], pending: [], confirmations: [] }
}

function boundedArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_PAIRING_STATES) {
    throw new TypeError(`Desktop Snow pairing store ${name} must be a bounded array`)
  }
  return value
}

function assertVaultCapacity(state: DesktopSnowVaultState): void {
  if (state.active.length + state.challenges.length + state.pending.length > MAX_PAIRING_STATES) {
    throw new TypeError('Desktop Snow pairing store exceeds its retained state limit')
  }
  const pendingIds = new Set(state.pending.map(record => record.pendingPairingId))
  if (state.confirmations.some(record => !pendingIds.has(record.pendingPairingId))) {
    throw new TypeError('Desktop Snow confirmation has no retained pending owner')
  }
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Desktop Snow pairing store ${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function encodeByteRecord(state: SnowDesktopEndpointPairingRecoveryState): Record<string, string> {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [
    key, Buffer.from(value).toString('base64url'),
  ]))
}

function decodeRecovery(value: unknown): SnowDesktopEndpointPairingRecoveryState {
  const record = recordValue(value, 'recovery')
  const decoded = Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (typeof item !== 'string') throw new TypeError('Desktop Snow recovery field must be encoded bytes')
    return [key, new Uint8Array(Buffer.from(item, 'base64url'))]
  })) as unknown as SnowDesktopEndpointPairingRecoveryState
  const owner = SnowDesktopEndpointPairingOwner.restore(decoded)
  try { return owner.exportRecoveryState() } finally { owner.wipe() }
}

function encodeConfirmation(transaction: DesktopSnowConfirmationTransaction): Record<string, unknown> {
  return {
    desktopCredential: transaction.desktopCredential,
    desktopCredentialDigest: Buffer.from(transaction.desktopCredentialDigest).toString('base64url'),
    mobileCredential: transaction.mobileCredential,
    mobileCredentialDigest: Buffer.from(transaction.mobileCredentialDigest).toString('base64url'),
    ...(transaction.pairingId === undefined ? {} : { pairingId: transaction.pairingId }),
    ...(transaction.routeId === undefined ? {} : { routeId: transaction.routeId }),
    ...(transaction.relayRevision === undefined ? {} : { relayRevision: transaction.relayRevision }),
    ...(transaction.sealedRelayAuthority === undefined ? {} : {
      sealedRelayAuthority: Buffer.from(transaction.sealedRelayAuthority).toString('base64url'),
    }),
    ...(transaction.reconnectState === undefined ? {} : {
      reconnectState: Buffer.from(transaction.reconnectState).toString('base64url'),
    }),
  }
}

function decodeConfirmation(value: unknown): DesktopSnowConfirmationTransaction {
  const record = recordValue(value, 'confirmation transaction')
  const desktopCredentialDigest = decodeFixedBytes(record.desktopCredentialDigest, 32, 'Desktop credential digest')
  const mobileCredentialDigest = decodeFixedBytes(record.mobileCredentialDigest, 32, 'Mobile credential digest')
  if (bytesEqual(desktopCredentialDigest, mobileCredentialDigest)) {
    throw new TypeError('Desktop and Mobile credential digests must be distinct')
  }
  const transaction: DesktopSnowConfirmationTransaction = {
    desktopCredential: parseRelayCredential(record.desktopCredential),
    desktopCredentialDigest,
    mobileCredential: parseRelayCredential(record.mobileCredential),
    mobileCredentialDigest,
  }
  if (record.pairingId !== undefined) transaction.pairingId = parsePersonalPairingId(record.pairingId)
  if (record.routeId !== undefined) transaction.routeId = parseRelayRouteId(record.routeId)
  if (record.relayRevision !== undefined) {
    if (!Number.isSafeInteger(record.relayRevision) || (record.relayRevision as number) < 1) {
      throw new TypeError('Desktop Snow Relay revision must be a positive safe integer')
    }
    transaction.relayRevision = record.relayRevision as number
  }
  if (record.sealedRelayAuthority !== undefined) {
    transaction.sealedRelayAuthority = decodeBytes(record.sealedRelayAuthority, 'sealed Relay authority')
  }
  if (record.reconnectState !== undefined) {
    transaction.reconnectState = decodeFixedBytes(record.reconnectState, 96, 'reconnect state')
  }
  const hasConfirmation = transaction.pairingId !== undefined || transaction.routeId !== undefined
    || transaction.relayRevision !== undefined || transaction.sealedRelayAuthority !== undefined
    || transaction.reconnectState !== undefined
  if (hasConfirmation && (transaction.pairingId === undefined || transaction.routeId === undefined
    || transaction.relayRevision === undefined || transaction.sealedRelayAuthority === undefined
    || transaction.reconnectState === undefined)) {
    throw new TypeError('Desktop Snow confirmation transaction is incomplete')
  }
  return transaction
}

function decodeBytes(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string') throw new TypeError(`Desktop Snow ${name} must be encoded bytes`)
  const decoded = new Uint8Array(Buffer.from(value, 'base64url'))
  if (decoded.byteLength === 0) throw new TypeError(`Desktop Snow ${name} must not be empty`)
  return decoded
}

function decodeFixedBytes(value: unknown, length: number, name: string): Uint8Array {
  const decoded = decodeBytes(value, name)
  if (decoded.byteLength !== length) throw new TypeError(`Desktop Snow ${name} must contain ${String(length)} bytes`)
  return decoded
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.every((byte, index) => byte === right[index])
}

function cloneConfirmation(transaction: DesktopSnowConfirmationTransaction): DesktopSnowConfirmationTransaction {
  return {
    ...transaction,
    desktopCredentialDigest: transaction.desktopCredentialDigest.slice(),
    mobileCredentialDigest: transaction.mobileCredentialDigest.slice(),
    sealedRelayAuthority: transaction.sealedRelayAuthority?.slice(),
    reconnectState: transaction.reconnectState?.slice(),
  }
}

function wipeVaultState(state: DesktopSnowVaultState): void {
  for (const record of state.active) record.reconnectState.fill(0)
  for (const record of state.challenges) wipeRecovery(record.recovery)
  for (const record of state.pending) wipeRecovery(record.recovery)
  for (const record of state.confirmations) wipeConfirmation(record.transaction)
}

function wipeRecovery(state: SnowDesktopEndpointPairingRecoveryState): void {
  state.desktopPrivate.fill(0)
  state.desktopPublic.fill(0)
  state.ephemeralPrivate.fill(0)
  state.psk.fill(0)
  state.message1?.fill(0)
  state.message2?.fill(0)
  state.message3?.fill(0)
  state.mobilePublic?.fill(0)
  state.handshakeHash?.fill(0)
  state.reconnectState?.fill(0)
}

function wipeConfirmation(transaction: DesktopSnowConfirmationTransaction): void {
  transaction.desktopCredentialDigest.fill(0)
  transaction.mobileCredentialDigest.fill(0)
  transaction.sealedRelayAuthority?.fill(0)
  transaction.reconnectState?.fill(0)
}
