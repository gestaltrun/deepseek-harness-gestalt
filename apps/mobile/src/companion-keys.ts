/** Account-scoped Mobile retention of Snow reconnect state and sealed-delivered Relay authority. */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parsePersonalPairingId, type PersonalPairingId, type RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { MobileEndpointPairingRecovery, MobilePairingKeyRetention } from './personal-pairing.ts'
import type { MobilePairedDesktop } from './personal-pairing-model.ts'
import type { MobileProtectedStorage } from './native-protected-storage.ts'

/** Maximum Personal Pairings whose attachment key one Mobile installation retains. */
export const MAX_RETAINED_PAIRING_KEYS = 16
const MOBILE_PAIRING_DOCUMENT_VERSION = 2

interface StoredMobilePairingState {
  pairingId: PersonalPairingId
  attachmentKey: Uint8Array
  reconnectState?: Uint8Array
  grant?: RelayCredentialGrant
  desktopName?: string
}

export interface StoredMobilePairingDocument {
  active: readonly StoredMobilePairingState[]
  /** Personal Pairing explicitly selected for Relay and Session authority. */
  selectedPairingId?: PersonalPairingId
  pending?: MobileEndpointPairingRecovery
}

/** Durable document store used by the in-memory key-vault owner. */
export interface MobilePairingStateStore {
  /** Load one Account's retained pairing authority, transferring ownership of every returned secret buffer. */
  load(accountId: PlatformAccountId): Promise<StoredMobilePairingDocument>
  /** Atomically replace one Account's retained pairing authority. */
  save(accountId: PlatformAccountId, document: StoredMobilePairingDocument): Promise<void>
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
    if (document.version !== MOBILE_PAIRING_DOCUMENT_VERSION) {
      throw new TypeError('Mobile pairing document version is unsupported')
    }
    if (!Array.isArray(document.active) || document.active.length > MAX_RETAINED_PAIRING_KEYS) {
      throw new TypeError('Mobile pairing active state must contain a bounded array')
    }
    return validatedDocument({
      active: document.active.map(parseStoredState),
      ...(document.selectedPairingId === undefined
        ? {}
        : { selectedPairingId: parsePersonalPairingId(document.selectedPairingId) }),
      ...(document.pending === undefined ? {} : { pending: parseEndpointRecovery(document.pending) }),
    })
  }

  async save(accountId: PlatformAccountId, document: StoredMobilePairingDocument): Promise<void> {
    const database = await this.database
    const encoded = {
      version: MOBILE_PAIRING_DOCUMENT_VERSION,
      active: document.active.map(record => ({
        pairingId: record.pairingId,
        attachmentKey: record.attachmentKey.slice(),
        ...(record.reconnectState === undefined ? {} : { reconnectState: record.reconnectState.slice() }),
        ...(record.grant === undefined ? {} : { grant: { ...record.grant } }),
        ...(record.desktopName === undefined ? {} : { desktopName: record.desktopName }),
      })),
      ...(document.selectedPairingId === undefined ? {} : { selectedPairingId: document.selectedPairingId }),
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

/** Native protected-store persistence for release builds. */
export class NativeMobilePairingStateStore implements MobilePairingStateStore {
  constructor(
    private readonly storage: MobileProtectedStorage,
    private readonly namespace: string,
  ) {}

  async load(accountId: PlatformAccountId): Promise<StoredMobilePairingDocument> {
    const value = await this.storage.get(this.key(accountId))
    if (value === undefined) return { active: [] }
    let document: unknown
    try { document = JSON.parse(value) } catch {
      throw new TypeError('Native Mobile pairing document must contain JSON')
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new TypeError('Native Mobile pairing document must contain an object')
    }
    const record = document as Record<string, unknown>
    if (record.version !== MOBILE_PAIRING_DOCUMENT_VERSION) {
      throw new TypeError('Native Mobile pairing document version is unsupported')
    }
    if (!Array.isArray(record.active) || record.active.length > MAX_RETAINED_PAIRING_KEYS) {
      throw new TypeError('Native Mobile pairing active state must contain a bounded array')
    }
    return validatedDocument({
      active: record.active.map(parseNativeState),
      ...(record.selectedPairingId === undefined
        ? {}
        : { selectedPairingId: parsePersonalPairingId(record.selectedPairingId) }),
      ...(record.pending === undefined ? {} : { pending: parseNativeRecovery(record.pending) }),
    })
  }

  async save(accountId: PlatformAccountId, document: StoredMobilePairingDocument): Promise<void> {
    const encoded = {
      version: MOBILE_PAIRING_DOCUMENT_VERSION,
      active: document.active.map(record => ({
        pairingId: record.pairingId,
        attachmentKey: encodeBytes(record.attachmentKey),
        ...(record.reconnectState === undefined ? {} : { reconnectState: encodeBytes(record.reconnectState) }),
        ...(record.grant === undefined ? {} : { grant: { ...record.grant } }),
        ...(record.desktopName === undefined ? {} : { desktopName: record.desktopName }),
      })),
      ...(document.selectedPairingId === undefined ? {} : { selectedPairingId: document.selectedPairingId }),
      ...(document.pending === undefined ? {} : {
        pending: {
          ...document.pending,
          mobileHandshake: encodeBytes(document.pending.mobileHandshake),
          handshakeRecovery: encodeBytes(document.pending.handshakeRecovery),
        },
      }),
    }
    await this.storage.set(this.key(accountId), JSON.stringify(encoded))
  }

  private key(accountId: PlatformAccountId): string {
    return `pairings:${this.namespace}:${accountId}`
  }
}

/** Retained independent attachment keys for confirmed Personal Pairings. */
export class PairingCompanionKeyVault implements MobilePairingKeyRetention {
  private readonly attachmentKeys = new Map<string, Uint8Array>()
  private readonly reconnectStates = new Map<string, Uint8Array>()
  private readonly grants = new Map<string, RelayCredentialGrant>()
  private readonly desktopNames = new Map<string, string>()
  private pending: MobileEndpointPairingRecovery | undefined
  private selected: PersonalPairingId | undefined
  private accountId: PlatformAccountId | undefined
  private persistence: Promise<void> = Promise.resolve()
  private selection: Promise<void> = Promise.resolve()

  constructor(private readonly store?: MobilePairingStateStore) {}

  async selectAccount(accountId: PlatformAccountId): Promise<void> {
    const selected = this.selection.then(async () => {
      if (this.accountId === accountId) return
      await this.persistence
      const state = validatedDocument(await this.store?.load(accountId) ?? { active: [] })
      try {
        this.clearMemory()
        this.accountId = accountId
        for (const record of state.active) {
          this.attachmentKeys.set(record.pairingId, record.attachmentKey.slice())
          if (record.reconnectState !== undefined) this.reconnectStates.set(record.pairingId, record.reconnectState.slice())
          if (record.grant !== undefined) this.grants.set(record.pairingId, { ...record.grant })
          if (record.desktopName !== undefined) this.desktopNames.set(record.pairingId, record.desktopName)
        }
        this.selected = state.selectedPairingId
        this.pending = state.pending === undefined ? undefined : cloneEndpointRecovery(state.pending)
      } finally {
        for (const record of state.active) {
          record.attachmentKey.fill(0)
          record.reconnectState?.fill(0)
        }
        wipeEndpointRecovery(state.pending)
      }
    })
    this.selection = selected.then(() => undefined, () => undefined)
    await selected
  }

  /**
   * Retain the independent attachment key of one confirmed Personal Pairing.
   * @param pairingId - confirmed Personal Pairing identity.
   * @param attachmentKey - at least 32 bytes of attachment key material; stored as a copy.
   */
  retain(pairingId: PersonalPairingId, attachmentKey: Uint8Array): void {
    if (attachmentKey.byteLength < 32) throw new TypeError('Personal Pairing attachment key must contain at least 256 bits')
    if (!this.attachmentKeys.has(pairingId) && this.attachmentKeys.size >= MAX_RETAINED_PAIRING_KEYS) {
      throw new Error('Mobile retained Personal Pairing attachment-key limit reached')
    }
    const previous = this.attachmentKeys.get(pairingId)
    previous?.fill(0)
    this.attachmentKeys.set(pairingId, attachmentKey.slice())
    this.persist()
  }

  /** Retain one confirmed pairing in a single durable store snapshot. */
  retainConfirmedPairing(
    pairingId: PersonalPairingId,
    reconnectState: Uint8Array,
    attachmentKey: Uint8Array,
    grant: RelayCredentialGrant,
  ): void {
    if (reconnectState.byteLength !== 96) throw new TypeError('Mobile Snow reconnect state must contain 96 bytes')
    if (attachmentKey.byteLength < 32) throw new TypeError('Personal Pairing attachment key must contain at least 256 bits')
    requirePairingGrant(pairingId, grant)
    if (!this.attachmentKeys.has(pairingId) && this.attachmentKeys.size >= MAX_RETAINED_PAIRING_KEYS) {
      throw new Error('Mobile retained Personal Pairing attachment-key limit reached')
    }
    this.attachmentKeys.get(pairingId)?.fill(0)
    this.reconnectStates.get(pairingId)?.fill(0)
    this.attachmentKeys.set(pairingId, attachmentKey.slice())
    this.reconnectStates.set(pairingId, reconnectState.slice())
    this.grants.set(pairingId, { ...grant })
    this.selected = pairingId
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
    if (!this.attachmentKeys.has(pairingId)) throw new Error('Mobile Relay grant has no retained Snow pairing state')
    requirePairingGrant(pairingId, grant)
    this.grants.set(pairingId, { ...grant })
    this.persist()
  }

  /**
   * Persist the authenticated Desktop name carried by its Companion channel.
   * @param pairingId - Personal Pairing authenticated by the current channel.
   * @param desktopName - Desktop Installation name from the encrypted foreground projection.
   */
  recordDesktopName(pairingId: PersonalPairingId, desktopName: string): void {
    if (!this.attachmentKeys.has(pairingId)) throw new Error('Mobile Desktop name has no retained Personal Pairing')
    if (desktopName.trim() === '' || desktopName.length > 128) {
      throw new TypeError('Paired Desktop name must contain 1-128 characters')
    }
    if (this.desktopNames.get(pairingId) === desktopName) {
      this.persist()
      return
    }
    this.desktopNames.set(pairingId, desktopName)
    this.persist()
  }

  /**
   * Select one complete retained Personal Pairing for Relay and projection authority.
   * @param pairingId - retained Personal Pairing selected by the person.
   */
  selectPairing(pairingId: PersonalPairingId): void {
    if (!this.reconnectStates.has(pairingId) || !this.grants.has(pairingId)) {
      throw new Error('Selected Paired Desktop has no complete retained authority')
    }
    if (this.selected === pairingId) {
      this.persist()
      return
    }
    this.selected = pairingId
    this.persist()
  }

  /** @returns credential-free retained Desktops in stable pairing order. */
  pairedDesktops(): readonly MobilePairedDesktop[] {
    return [...this.attachmentKeys.keys()]
      .filter(pairingId => this.reconnectStates.has(pairingId) && this.grants.has(pairingId))
      .map((pairingId) => {
        const desktopName = this.desktopNames.get(pairingId)
        return {
          pairingId: parsePersonalPairingId(pairingId),
          ...(desktopName === undefined ? {} : { desktopName }),
        }
      })
  }

  /** @returns the explicitly selected retained Personal Pairing. */
  selectedPairingId(): PersonalPairingId | undefined { return this.selected }

  relayAuthority(): RelayCredentialGrant | undefined {
    const grant = this.selected === undefined ? undefined : this.grants.get(this.selected)
    return grant === undefined ? undefined : { ...grant }
  }

  /** @returns explicitly selected confirmed Personal Pairing for the selected Account. */
  retainedPairingId(): PersonalPairingId | undefined {
    return this.selected
  }

  /**
   * Read one retained attachment key.
   * @param pairingId - confirmed Personal Pairing identity.
   * @returns copy of the retained attachment key, or undefined when absent.
   */
  attachmentKeyMaterial(pairingId: PersonalPairingId): Uint8Array | undefined {
    return this.attachmentKeys.get(pairingId)?.slice()
  }

  /** Read one retained Mobile Snow static reconnect record. */
  reconnectState(pairingId: PersonalPairingId): Uint8Array | undefined {
    return this.reconnectStates.get(pairingId)?.slice()
  }

  /** @param pairingId - confirmed Personal Pairing whose attachment key is released and zeroed. */
  release(pairingId: PersonalPairingId): void {
    const attachmentKey = this.attachmentKeys.get(pairingId)
    if (attachmentKey === undefined) return
    attachmentKey.fill(0)
    this.reconnectStates.get(pairingId)?.fill(0)
    this.attachmentKeys.delete(pairingId)
    this.reconnectStates.delete(pairingId)
    this.grants.delete(pairingId)
    this.desktopNames.delete(pairingId)
    if (this.selected === pairingId) this.selected = undefined
    this.persist()
  }

  /** Zero every retained attachment key, leaving the vault empty. */
  wipe(): void {
    this.clearMemory()
    this.persist()
  }

  async flush(): Promise<void> { await this.persistence }

  private clearMemory(): void {
    for (const attachmentKey of this.attachmentKeys.values()) attachmentKey.fill(0)
    this.attachmentKeys.clear()
    for (const state of this.reconnectStates.values()) state.fill(0)
    this.reconnectStates.clear()
    this.grants.clear()
    this.desktopNames.clear()
    this.selected = undefined
    this.clearPendingMemory()
  }

  private persist(): void {
    if (this.store === undefined || this.accountId === undefined) return
    const accountId = this.accountId
    const active = [...this.attachmentKeys].map(([pairingId, attachmentKey]) => {
      const grant = this.grants.get(pairingId)
      const reconnectState = this.reconnectStates.get(pairingId)
      const desktopName = this.desktopNames.get(pairingId)
      return {
        pairingId: parsePersonalPairingId(pairingId),
        attachmentKey: attachmentKey.slice(),
        ...(reconnectState === undefined ? {} : { reconnectState: reconnectState.slice() }),
        ...(grant === undefined ? {} : { grant: { ...grant } }),
        ...(desktopName === undefined ? {} : { desktopName }),
      }
    })
    const selectedPairingId = this.selected
    const pending = this.pending === undefined ? undefined : cloneEndpointRecovery(this.pending)
    this.persistence = this.persistence.catch(() => undefined).then(async () => {
      try {
        await this.store?.save(accountId, {
          active,
          ...(selectedPairingId === undefined ? {} : { selectedPairingId }),
          ...(pending === undefined ? {} : { pending }),
        })
      } finally {
        for (const record of active) {
          record.attachmentKey.fill(0)
          record.reconnectState?.fill(0)
        }
        wipeEndpointRecovery(pending)
      }
    })
  }

  private clearPendingMemory(): void {
    wipeEndpointRecovery(this.pending)
    this.pending = undefined
  }
}

function parseNativeState(value: unknown): StoredMobilePairingState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Native Mobile pairing state record must be an object')
  }
  const record = value as Record<string, unknown>
  return parseStoredState({
    ...record,
    attachmentKey: decodeBytes(record.attachmentKey),
    ...(record.reconnectState === undefined ? {} : { reconnectState: decodeBytes(record.reconnectState) }),
  })
}

function parseNativeRecovery(value: unknown): MobileEndpointPairingRecovery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Native Mobile pairing recovery must be an object')
  }
  const record = value as Record<string, unknown>
  return parseEndpointRecovery({
    ...record,
    mobileHandshake: decodeBytes(record.mobileHandshake),
    handshakeRecovery: decodeBytes(record.handshakeRecovery),
  })
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Native Mobile secret bytes must be base64')
  let binary: string
  try { binary = atob(value) } catch { throw new TypeError('Native Mobile secret bytes must be base64') }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
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
  if (typeof record.pairingId !== 'string' || !(record.attachmentKey instanceof Uint8Array)
    || record.attachmentKey.byteLength < 32
    || (record.reconnectState !== undefined
      && (!(record.reconnectState instanceof Uint8Array) || record.reconnectState.byteLength !== 96))) {
    throw new TypeError('Mobile pairing state record is invalid')
  }
  const pairingId = parsePersonalPairingId(record.pairingId)
  let grant: RelayCredentialGrant | undefined
  if (record.grant !== undefined) {
    if (!(record.reconnectState instanceof Uint8Array)) {
      throw new TypeError('Mobile pairing Relay grant has no reconnect state')
    }
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
    requirePairingGrant(pairingId, grant)
  }
  return {
    pairingId, attachmentKey: record.attachmentKey.slice(),
    ...(record.reconnectState instanceof Uint8Array ? { reconnectState: record.reconnectState.slice() } : {}),
    ...(grant === undefined ? {} : { grant }),
    ...(record.desktopName === undefined ? {} : { desktopName: parseDesktopName(record.desktopName) }),
  }
}

function requirePairingGrant(pairingId: PersonalPairingId, grant: RelayCredentialGrant): void {
  if (grant.endpoint !== 'mobile' || String(grant.pairingSelector) !== String(pairingId)) {
    throw new TypeError('Mobile Relay grant must select its retained Personal Pairing')
  }
}

function validatedDocument(document: StoredMobilePairingDocument): StoredMobilePairingDocument {
  const pairingIds = new Set<PersonalPairingId>()
  for (const record of document.active) {
    if (pairingIds.has(record.pairingId)) {
      rejectStoredDocument(document, 'Mobile pairing document contains a duplicate Personal Pairing id')
    }
    pairingIds.add(record.pairingId)
  }
  if (document.selectedPairingId !== undefined) {
    const selected = document.active.find(record => record.pairingId === document.selectedPairingId)
    if (selected?.reconnectState === undefined || selected.grant === undefined) {
      rejectStoredDocument(document, 'Selected Paired Desktop has no complete retained authority')
    }
  }
  return document
}

function rejectStoredDocument(document: StoredMobilePairingDocument, message: string): never {
  for (const record of document.active) {
    record.attachmentKey.fill(0)
    record.reconnectState?.fill(0)
  }
  wipeEndpointRecovery(document.pending)
  throw new TypeError(message)
}

function parseDesktopName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new TypeError('Paired Desktop name must contain 1-128 characters')
  }
  return value
}
