/** Account-scoped Mobile retention of Snow reconnect state and sealed-delivered Relay authority. */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parsePersonalPairingId, type PersonalPairingId, type RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { MobileEndpointPairingRecovery, MobilePairingKeyRetention } from './personal-pairing.ts'

/** Maximum Personal Pairings whose key material one Mobile installation retains. */
export const MAX_RETAINED_PAIRING_KEYS = 16

interface StoredMobilePairingState {
  pairingId: PersonalPairingId
  material: Uint8Array
  grant?: RelayCredentialGrant
}

interface StoredMobilePairingDocument {
  active: readonly StoredMobilePairingState[]
  pending?: MobileEndpointPairingRecovery
}

/** IndexedDB persistence isolated by signed-in Platform Account. */
export class IndexedDbMobilePairingStateStore {
  private readonly database: Promise<IDBDatabase>

  constructor(databaseName: string) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('pairings') }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Mobile pairing IndexedDB open failed')) }
    })
  }

  async load(accountId: PlatformAccountId): Promise<StoredMobilePairingDocument> {
    const database = await this.database
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('pairings', 'readonly').objectStore('pairings').get(accountId)
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Mobile pairing IndexedDB read failed')) }
    })
    if (value === undefined) return { active: [] }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Mobile pairing state must contain an object')
    }
    const document = value as Record<string, unknown>
    if (!Array.isArray(document.active) || document.active.length > MAX_RETAINED_PAIRING_KEYS) {
      throw new TypeError('Mobile pairing active state must contain a bounded array')
    }
    return {
      active: document.active.map(parseStoredState),
      ...(document.pending === undefined ? {} : { pending: parseEndpointRecovery(document.pending) }),
    }
  }

  async save(accountId: PlatformAccountId, document: StoredMobilePairingDocument): Promise<void> {
    const database = await this.database
    const encoded = {
      active: document.active.map(record => ({
        pairingId: record.pairingId,
        material: record.material.slice(),
        ...(record.grant === undefined ? {} : { grant: { ...record.grant } }),
      })),
      ...(document.pending === undefined ? {} : { pending: cloneEndpointRecovery(document.pending) }),
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('pairings', 'readwrite')
      transaction.objectStore('pairings').put(encoded, accountId)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Mobile pairing IndexedDB write failed')) }
    })
  }
}

/** Retained independent pairing keys for confirmed Personal Pairings. */
export class PairingCompanionKeyVault implements MobilePairingKeyRetention {
  private readonly materials = new Map<string, Uint8Array>()
  private readonly grants = new Map<string, RelayCredentialGrant>()
  private pending: MobileEndpointPairingRecovery | undefined
  private accountId: PlatformAccountId | undefined
  private persistence: Promise<void> = Promise.resolve()

  constructor(private readonly store?: IndexedDbMobilePairingStateStore) {}

  async selectAccount(accountId: PlatformAccountId): Promise<void> {
    if (this.accountId === accountId) return
    this.clearMemory()
    this.accountId = accountId
    const state = await this.store?.load(accountId) ?? { active: [] }
    for (const record of state.active) {
      this.materials.set(record.pairingId, record.material.slice())
      if (record.grant !== undefined) this.grants.set(record.pairingId, { ...record.grant })
    }
    this.pending = state.pending === undefined ? undefined : cloneEndpointRecovery(state.pending)
  }

  /**
   * Retain the independent key material of one confirmed Personal Pairing.
   * @param pairingId - confirmed Personal Pairing identity.
   * @param material - at least 32 bytes of pairing key material; stored as a copy.
   */
  retain(pairingId: PersonalPairingId, material: Uint8Array): void {
    if (material.byteLength < 32) throw new TypeError('Personal Pairing key material must contain at least 256 bits')
    if (!this.materials.has(pairingId) && this.materials.size >= MAX_RETAINED_PAIRING_KEYS) {
      throw new Error('Mobile retained Personal Pairing key limit reached')
    }
    const previous = this.materials.get(pairingId)
    previous?.fill(0)
    this.materials.set(pairingId, material.slice())
    this.persist()
  }

  /** Retain one confirmed pairing in a single durable store snapshot. */
  retainConfirmedPairing(pairingId: PersonalPairingId, material: Uint8Array, grant: RelayCredentialGrant): void {
    if (material.byteLength < 32) throw new TypeError('Personal Pairing key material must contain at least 256 bits')
    if (!this.materials.has(pairingId) && this.materials.size >= MAX_RETAINED_PAIRING_KEYS) {
      throw new Error('Mobile retained Personal Pairing key limit reached')
    }
    this.materials.get(pairingId)?.fill(0)
    this.materials.set(pairingId, material.slice())
    this.grants.set(pairingId, { ...grant })
    this.clearPendingMemory()
    this.persist()
  }

  retainEndpointRecovery(recovery: MobileEndpointPairingRecovery): void {
    if (recovery.accountId !== this.accountId) throw new Error('Mobile pairing recovery belongs to another Account')
    this.clearPendingMemory()
    this.pending = cloneEndpointRecovery(recovery)
    this.persist()
  }

  endpointRecovery(): MobileEndpointPairingRecovery | undefined {
    return this.pending === undefined ? undefined : cloneEndpointRecovery(this.pending)
  }

  clearEndpointRecovery(): void {
    this.clearPendingMemory()
    this.persist()
  }

  retainRelayAuthority(pairingId: PersonalPairingId, grant: RelayCredentialGrant): void {
    if (!this.materials.has(pairingId)) throw new Error('Mobile Relay grant has no retained Snow pairing state')
    this.grants.set(pairingId, { ...grant })
    this.persist()
  }

  relayAuthority(): RelayCredentialGrant | undefined {
    const grant = [...this.grants.values()].at(-1)
    return grant === undefined ? undefined : { ...grant }
  }

  /**
   * Read one retained pairing key.
   * @param pairingId - confirmed Personal Pairing identity.
   * @returns copy of the retained key material, or undefined when absent.
   */
  pairingKeyMaterial(pairingId: PersonalPairingId): Uint8Array | undefined {
    return this.materials.get(pairingId)?.slice()
  }

  /** @param pairingId - confirmed Personal Pairing whose material is released and zeroed. */
  release(pairingId: PersonalPairingId): void {
    const material = this.materials.get(pairingId)
    if (material === undefined) return
    material.fill(0)
    this.materials.delete(pairingId)
    this.grants.delete(pairingId)
    this.persist()
  }

  /** Zero every retained pairing key, leaving the vault empty. */
  wipe(): void {
    this.clearMemory()
    this.persist()
  }

  async flush(): Promise<void> { await this.persistence }

  private clearMemory(): void {
    for (const material of this.materials.values()) material.fill(0)
    this.materials.clear()
    this.grants.clear()
    this.clearPendingMemory()
  }

  private persist(): void {
    if (this.store === undefined || this.accountId === undefined) return
    const accountId = this.accountId
    const active = [...this.materials].map(([pairingId, material]) => {
      const grant = this.grants.get(pairingId)
      return {
        pairingId: parsePersonalPairingId(pairingId),
        material: material.slice(),
        ...(grant === undefined ? {} : { grant: { ...grant } }),
      }
    })
    const pending = this.pending === undefined ? undefined : cloneEndpointRecovery(this.pending)
    this.persistence = this.persistence.catch(() => undefined).then(async () => {
      try { await this.store?.save(accountId, { active, ...(pending === undefined ? {} : { pending }) }) } finally {
        for (const record of active) record.material.fill(0)
        wipeEndpointRecovery(pending)
      }
    })
  }

  private clearPendingMemory(): void {
    wipeEndpointRecovery(this.pending)
    this.pending = undefined
  }
}

function cloneEndpointRecovery(recovery: MobileEndpointPairingRecovery): MobileEndpointPairingRecovery {
  return {
    ...recovery,
    mobileHandshake: recovery.mobileHandshake.slice(),
    handshakeRecovery: recovery.handshakeRecovery.slice(),
  }
}

function wipeEndpointRecovery(recovery: MobileEndpointPairingRecovery | undefined): void {
  recovery?.mobileHandshake.fill(0)
  recovery?.handshakeRecovery.fill(0)
}

function parseEndpointRecovery(value: unknown): MobileEndpointPairingRecovery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Mobile endpoint pairing recovery must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.link !== 'string' || !Number.isSafeInteger(record.expiresAt)
    || typeof record.accountId !== 'string' || typeof record.completionId !== 'string'
    || !(record.mobileHandshake instanceof Uint8Array) || !(record.handshakeRecovery instanceof Uint8Array)
    || !['prepared', 'possibly-committed', 'pending'].includes(String(record.transmission))
    || typeof record.endpointChallengeId !== 'string' || typeof record.endpointHandshakeFinished !== 'boolean') {
    throw new TypeError('Mobile endpoint pairing recovery is invalid')
  }
  return cloneEndpointRecovery(record as unknown as MobileEndpointPairingRecovery)
}

function parseStoredState(value: unknown): StoredMobilePairingState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Mobile pairing state record must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.pairingId !== 'string' || !(record.material instanceof Uint8Array)
    || record.material.byteLength !== 96) {
    throw new TypeError('Mobile pairing state record is invalid')
  }
  let grant: RelayCredentialGrant | undefined
  if (record.grant !== undefined) {
    if (typeof record.grant !== 'object' || record.grant === null || Array.isArray(record.grant)) {
      throw new TypeError('Mobile pairing Relay grant is invalid')
    }
    const value = record.grant as Record<string, unknown>
    if (value.endpoint !== 'mobile' || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) {
      throw new TypeError('Mobile pairing Relay grant is invalid')
    }
    grant = {
      routeId: parseRelayRouteId(value.routeId), endpoint: 'mobile',
      credential: parseRelayCredential(value.credential), revision: value.revision as number,
      ...(value.pairingSelector === undefined ? {} : { pairingSelector: parseRelayPairingSelector(value.pairingSelector) }),
    }
  }
  return {
    pairingId: parsePersonalPairingId(record.pairingId), material: record.material.slice(),
    ...(grant === undefined ? {} : { grant }),
  }
}
