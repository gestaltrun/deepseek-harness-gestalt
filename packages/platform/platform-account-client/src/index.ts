/**
 * Desktop/Mobile installation client for Platform Account login, proof, refresh,
 * account-scoped local state, and current-installation sign-out.
 * @module @deepseek-ai/dsh-platform-account-client
 */

import {
  ACCOUNT_PRIVACY_NOTICE,
  AccountError,
  parseAccountSessionView,
  parseAccountProofJti,
  parseLoginAttemptView,
  parseLoginPollResult,
  parsePlatformAccountView,
  type AccountProof,
  type AccountErrorCode,
  type AccountSessionView,
  type InstallationId,
  type InstallationKind,
  type LoginAttemptId,
  type LoginAttemptView,
  type LoginPollResult,
  type PlatformAccountId,
  type PlatformAccountView,
  type PlatformEnvironment,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'

export { ACCOUNT_PRIVACY_NOTICE }

/** Transport operations used by one installation controller. */
export interface PlatformAccountTransport {
  /** Deployment identity owning every request. */
  readonly environment: SelectedPlatformEnvironment
  beginLogin(input: {
    installationId: InstallationId
    installationKind: InstallationKind
    publicKey: JsonWebKey
  }): Promise<LoginAttemptView>
  pollLogin(input: { attemptId: LoginAttemptId; pollingToken: string; proof: AccountProof }): Promise<LoginPollResult>
  refresh(input: { refreshToken: string; proof: AccountProof }): Promise<AccountSessionView>
  current(input: { accessToken: string; proof: AccountProof }): Promise<PlatformAccountView>
  signOut(input: { accessToken: string; proof: AccountProof }): Promise<void>
}

/** HTTP transport construction inputs. */
export interface PlatformAccountHttpTransportOptions {
  environment: SelectedPlatformEnvironment
  fetch?: typeof fetch
}

/** Browser/native HTTP transport for the public Account routes. */
export class PlatformAccountHttpTransport implements PlatformAccountTransport {
  private readonly origin: string
  private readonly fetch: typeof fetch
  /** Deployment identity owning every request. */
  readonly environment: SelectedPlatformEnvironment

  /** @param options - validated deployment identity and HTTP adapter. */
  constructor(options: PlatformAccountHttpTransportOptions) {
    this.environment = options.environment
    this.origin = options.environment.origin
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  beginLogin(input: {
    installationId: InstallationId
    installationKind: InstallationKind
    publicKey: JsonWebKey
  }): Promise<LoginAttemptView> {
    return this.json('/v1/account/login-attempts', { method: 'POST', body: JSON.stringify(input) }, parseLoginAttemptView)
  }

  pollLogin(input: { attemptId: LoginAttemptId; pollingToken: string; proof: AccountProof }): Promise<LoginPollResult> {
    return this.json('/v1/account/login-poll', { method: 'POST', body: JSON.stringify(input) }, parseLoginPollResult)
  }

  refresh(input: { refreshToken: string; proof: AccountProof }): Promise<AccountSessionView> {
    return this.json('/v1/account/session/refresh', { method: 'POST', body: JSON.stringify(input) }, parseAccountSessionView)
  }

  current(input: { accessToken: string; proof: AccountProof }): Promise<PlatformAccountView> {
    return this.json('/v1/account/session', {
      method: 'GET',
      headers: proofHeaders(input.accessToken, input.proof),
    }, parsePlatformAccountView)
  }

  async signOut(input: { accessToken: string; proof: AccountProof }): Promise<void> {
    await this.request('/v1/account/session', {
      method: 'DELETE',
      headers: proofHeaders(input.accessToken, input.proof),
    })
  }

  private async json<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    const response = await this.request(path, init)
    return parse(await response.json())
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = headerRecord(init.headers)
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetch(`${this.origin}${path}`, { ...init, headers })
    if (response.ok) return response
    let message = `Platform Account request failed with HTTP ${response.status}`
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // A non-JSON proxy failure has no stable Platform error body.
    }
    if (isErrorBody(body)) {
      if (isAccountErrorCode(body.error.code)) {
        throw new AccountError(body.error.code, body.error.message, body.error.retryAfter)
      }
      message = `${body.error.code}: ${body.error.message}`
    }
    throw new Error(message)
  }
}

interface PendingLogin {
  attempt: LoginAttemptView
  privateKey: CryptoKey
}

/** Local current-installation session, including its non-exported signing key. */
export interface StoredInstallationSession {
  environment: PlatformEnvironment
  session: AccountSessionView
  privateKey: CryptoKey
}

/** Persistence used for session recovery and account-scoped product material. */
export interface InstallationAccountStore {
  loadSession(environment: PlatformEnvironment): Promise<StoredInstallationSession | undefined>
  saveSession(record: StoredInstallationSession): Promise<void>
  clearSession(environment: PlatformEnvironment): Promise<void>
  savePending(environment: PlatformEnvironment, pending: PendingLogin): Promise<void>
  loadPending(environment: PlatformEnvironment): Promise<PendingLogin | undefined>
  clearPending(environment: PlatformEnvironment): Promise<void>
}

/** In-memory installation store for keyless compositions and tests. */
export class MemoryInstallationAccountStore implements InstallationAccountStore {
  private readonly sessions = new Map<PlatformEnvironment, StoredInstallationSession>()
  private readonly pending = new Map<PlatformEnvironment, PendingLogin>()
  private readonly material = new Map<string, Map<string, unknown>>()

  loadSession(environment: PlatformEnvironment): Promise<StoredInstallationSession | undefined> {
    return Promise.resolve(this.sessions.get(environment))
  }

  saveSession(record: StoredInstallationSession): Promise<void> {
    this.sessions.set(record.environment, record)
    return Promise.resolve()
  }

  clearSession(environment: PlatformEnvironment): Promise<void> {
    this.sessions.delete(environment)
    return Promise.resolve()
  }

  savePending(environment: PlatformEnvironment, pending: PendingLogin): Promise<void> {
    this.pending.set(environment, pending)
    return Promise.resolve()
  }

  loadPending(environment: PlatformEnvironment): Promise<PendingLogin | undefined> {
    return Promise.resolve(this.pending.get(environment))
  }

  clearPending(environment: PlatformEnvironment): Promise<void> {
    this.pending.delete(environment)
    return Promise.resolve()
  }

  /**
   * Store test and adapter material under one account-specific namespace.
   * @param accountId - Platform Account owning the material.
   * @param key - adapter-owned material name.
   * @param value - adapter-owned material value.
   */
  setAccountMaterial(accountId: string, key: string, value: unknown): void {
    let scope = this.material.get(accountId)
    if (scope === undefined) {
      scope = new Map()
      this.material.set(accountId, scope)
    }
    scope.set(key, value)
  }

  /**
   * Read test and adapter material from one account-specific namespace.
   * @param accountId - Platform Account owning the material.
   * @param key - adapter-owned material name.
   * @returns stored value, or `undefined` when absent.
   */
  getAccountMaterial(accountId: string, key: string): unknown {
    return this.material.get(accountId)?.get(key)
  }
}

/** IndexedDB installation store for stable Mobile webview origins. */
export class IndexedDbInstallationAccountStore implements InstallationAccountStore {
  private readonly database: Promise<IDBDatabase>

  /** @param databaseName - application-owned database name; defaults to the Gestalt account store. */
  constructor(databaseName = 'deepseek-gestalt-platform-account') {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('records') }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error ?? new Error('Platform Account IndexedDB open failed')) }
    })
  }

  loadSession(environment: PlatformEnvironment): Promise<StoredInstallationSession | undefined> {
    return this.read(`${environment}:session`, value => parseStoredInstallationSession(value, environment))
  }

  saveSession(record: StoredInstallationSession): Promise<void> {
    return this.write(`${record.environment}:session`, record)
  }

  clearSession(environment: PlatformEnvironment): Promise<void> {
    return this.remove(`${environment}:session`)
  }

  savePending(environment: PlatformEnvironment, pending: PendingLogin): Promise<void> {
    return this.write(`${environment}:pending`, pending)
  }

  loadPending(environment: PlatformEnvironment): Promise<PendingLogin | undefined> {
    return this.read(`${environment}:pending`, value => parsePendingLogin(value))
  }

  clearPending(environment: PlatformEnvironment): Promise<void> {
    return this.remove(`${environment}:pending`)
  }

  private async read<T>(key: string, parse: (value: unknown) => T): Promise<T | undefined> {
    const database = await this.database
    return new Promise((resolve, reject) => {
      const request = database.transaction('records', 'readonly').objectStore('records').get(key)
      request.onsuccess = () => {
        try {
          resolve(request.result === undefined ? undefined : parse(request.result))
        } catch (error) {
          reject(new Error(String(error), { cause: error }))
        }
      }
      request.onerror = () => { reject(request.error ?? new Error('Platform Account IndexedDB read failed')) }
    })
  }

  private async write(key: string, value: unknown): Promise<void> {
    const database = await this.database
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('records', 'readwrite')
      transaction.objectStore('records').put(value, key)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Platform Account IndexedDB write failed')) }
    })
  }

  private async remove(key: string): Promise<void> {
    const database = await this.database
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('records', 'readwrite')
      transaction.objectStore('records').delete(key)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('Platform Account IndexedDB delete failed')) }
    })
  }
}

function parseStoredInstallationSession(
  value: unknown,
  environment: PlatformEnvironment,
): StoredInstallationSession {
  const record = durableRecord(value, 'stored installation session')
  if (record.environment !== environment) {
    throw new TypeError('stored installation session belongs to another environment')
  }
  return {
    environment,
    session: parseAccountSessionView(record.session),
    privateKey: parseP256PrivateKey(record.privateKey),
  }
}

function parsePendingLogin(value: unknown): PendingLogin {
  const record = durableRecord(value, 'pending login')
  return {
    attempt: parseLoginAttemptView(record.attempt),
    privateKey: parseP256PrivateKey(record.privateKey),
  }
}

function parseP256PrivateKey(value: unknown): CryptoKey {
  if (!(value instanceof CryptoKey)) {
    throw new TypeError('installation private key must be a signing P-256 CryptoKey')
  }
  const record = durableRecord(value, 'installation private key')
  const algorithm = durableRecord(record.algorithm, 'installation private-key algorithm')
  if (record.type !== 'private' || algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256'
    || !Array.isArray(record.usages) || !record.usages.includes('sign')) {
    throw new TypeError('installation private key must be a signing P-256 CryptoKey')
  }
  return value
}

function durableRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Build the stable local prefix for pairing keys, caches, and operation receipts.
 * @param environment - deployment environment owning the material.
 * @param accountId - Platform Account owning the material.
 * @returns account-specific storage namespace.
 */
export function accountStorageNamespace(environment: PlatformEnvironment, accountId: PlatformAccountId): string {
  return `platform-account:${environment}:${accountId}`
}

/** Observable installation state consumed by Desktop and Mobile presentation. */
export interface PlatformAccountInstallationSnapshot {
  status: 'idle' | 'preparing' | 'ready' | 'polling' | 'signed-in' | 'signing-out' | 'failed'
  privacyAccepted: boolean
  account?: PlatformAccountView
  error?: string
}

/** Native or Desktop system-browser capability used for OAuth authorization. */
export interface SystemBrowser {
  /** Open one trusted HTTPS authorization URL outside the app webview. */
  open(url: string): void | Promise<void>
}

/** Serial owner for current-installation lifecycle mutations. */
export class AccountLifecycleTransitions {
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * Run one transition after every earlier transition has settled.
   * @param transition - lifecycle mutation with exclusive access to local state.
   * @returns the transition result.
   */
  run<T>(transition: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AccountLifecycleClosedError())
    const result = this.tail.then(transition)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Refuse new transitions and drain every transition already admitted. */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }
}

/** Expected rejection when a lifecycle transition arrives after owner shutdown. */
export class AccountLifecycleClosedError extends Error {
  constructor() {
    super('Platform Account lifecycle transition owner is closed')
    this.name = 'AccountLifecycleClosedError'
  }
}

/** Controller construction inputs. */
export interface PlatformAccountInstallationOptions {
  environment: SelectedPlatformEnvironment
  installationId: InstallationId
  installationKind: InstallationKind
  transport: PlatformAccountTransport
  store: InstallationAccountStore
  systemBrowser: SystemBrowser
  transitions?: AccountLifecycleTransitions
  crypto?: Crypto
  now?: () => number
}

/** Access token and proof for one authenticated current-Installation operation. */
export interface CurrentInstallationAuthorization {
  /** Current short-lived Platform access token. */
  accessToken: string
  /** One-use proof bound to that access token and Installation key. */
  proof: AccountProof
}

/**
 * One Desktop or Mobile installation's Account lifecycle. OAuth callbacks
 * return only to Platform; the installation completes through signed polling.
 */
export class PlatformAccountInstallation {
  private snapshot: PlatformAccountInstallationSnapshot = { status: 'idle', privacyAccepted: false }
  private readonly listeners = new Set<() => void>()
  private readonly crypto: Crypto
  private readonly now: () => number
  private readonly transitions: AccountLifecycleTransitions
  private preparedAuthorizationUrl: string | undefined

  /** @param options - environment, installation identity, adapters, and browser opener. */
  constructor(private readonly options: PlatformAccountInstallationOptions) {
    this.crypto = options.crypto ?? globalThis.crypto
    this.now = options.now ?? Date.now
    this.transitions = options.transitions ?? new AccountLifecycleTransitions()
    if (options.transport.environment !== options.environment) {
      throw new TypeError('Platform Account transport does not match the selected installation environment')
    }
  }

  /** Read the current observable installation lifecycle state.
   * @returns the stable current snapshot until the next lifecycle transition.
   */
  getSnapshot(): PlatformAccountInstallationSnapshot {
    return this.snapshot
  }

  /**
   * Observe snapshot replacements.
   * @param listener - callback invoked after the snapshot reference changes.
   * @returns disposer that removes the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Authorize one current-Installation service operation without exposing the private key.
   * @returns current access token and fresh proof after any required refresh.
   */
  async authorizeCurrentInstallation(): Promise<CurrentInstallationAuthorization> {
    return this.transitions.run(async () => {
      const stored = await this.options.store.loadSession(this.options.environment.environment)
      if (stored === undefined) throw new AccountError('SESSION_REVOKED', 'Installation is not signed in')
      let session = stored.session
      if (session.refreshExpiresAt <= this.now()) {
        await this.options.store.clearSession(this.options.environment.environment)
        throw new AccountError('SESSION_EXPIRED', 'Installation Account Session expired')
      }
      if (session.accessExpiresAt <= this.now()) {
        session = await this.options.transport.refresh({
          refreshToken: session.refreshToken,
          proof: await this.proof(stored.privateKey, 'refresh', await hashToken(this.crypto, session.refreshToken)),
        })
        await this.options.store.saveSession({ ...stored, session })
        this.publish({ status: 'signed-in', privacyAccepted: this.snapshot.privacyAccepted, account: session.account })
      }
      return {
        accessToken: session.accessToken,
        proof: await this.proof(stored.privateKey, 'current', await hashToken(this.crypto, session.accessToken)),
      }
    })
  }

  /** Record acceptance of the bilingual notice for this presentation run. */
  acceptPrivacy(): void {
    this.publish({ ...withoutError(this.snapshot), privacyAccepted: true })
  }

  /** Restore a current-installation session, or resume a still-valid pending login. */
  async load(): Promise<void> {
    await this.transitions.run(async () => { await this.loadTransition() })
  }

  private async loadTransition(): Promise<void> {
    const stored = await this.options.store.loadSession(this.options.environment.environment)
    if (stored === undefined) {
      const pending = await this.options.store.loadPending(this.options.environment.environment)
      if (pending === undefined) return
      if (pending.attempt.expiresAt <= this.now()) {
        await this.options.store.clearPending(this.options.environment.environment)
        return
      }
      this.publish({ status: 'polling', privacyAccepted: true })
      return
    }
    if (stored.session.refreshExpiresAt <= this.now()) {
      await this.options.store.clearSession(this.options.environment.environment)
      return
    }
    try {
      let session = stored.session
      if (session.accessExpiresAt <= this.now()) {
        const proof = await this.proof(
          stored.privateKey,
          'refresh',
          await hashToken(this.crypto, session.refreshToken),
        )
        session = await this.options.transport.refresh({ refreshToken: session.refreshToken, proof })
      } else {
        const proof = await this.proof(
          stored.privateKey,
          'current',
          await hashToken(this.crypto, session.accessToken),
        )
        const account = await this.options.transport.current({ accessToken: session.accessToken, proof })
        session = { ...session, account }
      }
      await this.options.store.saveSession({ ...stored, session })
      this.publish({ status: 'signed-in', privacyAccepted: this.snapshot.privacyAccepted, account: session.account })
    } catch (error) {
      if (isTerminalSessionError(error)) {
        await this.options.store.clearSession(this.options.environment.environment)
        this.publish({ status: 'idle', privacyAccepted: this.snapshot.privacyAccepted })
        return
      }
      this.fail(error)
    }
  }

  /** Generate a fresh P-256 key and persist the attempt before the authorization click. */
  async prepareLogin(): Promise<void> {
    await this.transitions.run(async () => { await this.prepareLoginTransition() })
  }

  private async prepareLoginTransition(): Promise<void> {
    if (!this.snapshot.privacyAccepted) throw new Error('privacy notice must be accepted before authorization')
    this.publish({ status: 'preparing', privacyAccepted: true })
    try {
      const pair = await this.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
      const publicKey = await this.crypto.subtle.exportKey('jwk', pair.publicKey)
      const attempt = await this.options.transport.beginLogin({
        installationId: this.options.installationId,
        installationKind: this.options.installationKind,
        publicKey,
      })
      await this.options.store.savePending(this.options.environment.environment, { attempt, privateKey: pair.privateKey })
      this.preparedAuthorizationUrl = attempt.authorizationUrl
      this.publish({ status: 'ready', privacyAccepted: true })
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Open the prepared URL synchronously from the user activation callback. */
  openLogin(): void {
    if (this.preparedAuthorizationUrl === undefined || this.snapshot.status !== 'ready') {
      throw new Error('login authorization is not prepared')
    }
    const opened = this.options.systemBrowser.open(this.preparedAuthorizationUrl)
    this.preparedAuthorizationUrl = undefined
    this.publish({ status: 'polling', privacyAccepted: true })
    if (opened !== undefined) void Promise.resolve(opened).catch((error: unknown) => { this.fail(error) })
  }

  /** Prepare and open login for hosts whose system-browser API does not require user activation. */
  async beginLogin(): Promise<void> {
    await this.prepareLogin()
    this.openLogin()
  }

  /**
   * Poll the active five-minute attempt once.
   * @returns pending state or the newly issued current-installation session.
   */
  async pollLogin(): Promise<LoginPollResult> {
    return this.transitions.run(async () => this.pollLoginTransition())
  }

  private async pollLoginTransition(): Promise<LoginPollResult> {
    const pending = await this.options.store.loadPending(this.options.environment.environment)
    if (pending === undefined) throw new Error('no login attempt is pending')
    const proof = await this.proof(
      pending.privateKey,
      'login-poll',
      `${pending.attempt.id}:${await hashToken(this.crypto, pending.attempt.pollingToken)}`,
    )
    try {
      const result = await this.options.transport.pollLogin({
        attemptId: pending.attempt.id,
        pollingToken: pending.attempt.pollingToken,
        proof,
      })
      if (result.status === 'pending') return result
      await this.options.store.saveSession({
        environment: this.options.environment.environment,
        session: result,
        privateKey: pending.privateKey,
      })
      await this.options.store.clearPending(this.options.environment.environment)
      this.publish({ status: 'signed-in', privacyAccepted: true, account: result.account })
      return result
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Revoke this installation session and retain every account-scoped material namespace. */
  async signOut(): Promise<void> {
    await this.transitions.run(async () => { await this.signOutTransition() })
  }

  private async signOutTransition(): Promise<void> {
    const stored = await this.options.store.loadSession(this.options.environment.environment)
    if (stored === undefined) return
    this.publish({ ...withoutError(this.snapshot), status: 'signing-out' })
    try {
      const proof = await this.proof(
        stored.privateKey,
        'sign-out',
        await hashToken(this.crypto, stored.session.accessToken),
      )
      await this.options.transport.signOut({ accessToken: stored.session.accessToken, proof })
      await this.options.store.clearSession(this.options.environment.environment)
      this.publish({ status: 'idle', privacyAccepted: this.snapshot.privacyAccepted })
    } catch (error) {
      if (isTerminalSessionError(error)) {
        await this.options.store.clearSession(this.options.environment.environment)
        this.publish({ status: 'idle', privacyAccepted: this.snapshot.privacyAccepted })
        return
      }
      this.fail(error)
      throw error
    }
  }

  private async proof(privateKey: CryptoKey, operation: string, binding: string): Promise<AccountProof> {
    const issuedAt = this.now()
    const jti = parseAccountProofJti(this.crypto.randomUUID())
    const payload = new TextEncoder().encode(`${operation}\n${binding}\n${issuedAt}\n${jti}`)
    const signature = await this.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, payload)
    return { jti, issuedAt, signature: base64url(new Uint8Array(signature)) }
  }

  private fail(error: unknown): void {
    this.publish({
      ...this.snapshot,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private publish(snapshot: PlatformAccountInstallationSnapshot): void {
    this.snapshot = snapshot
    const failures: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      console.error(
        '[platform-account-client] subscriber failures:',
        new AggregateError(failures, 'Platform Account installation subscribers failed'),
      )
    }
  }
}

async function hashToken(crypto: Crypto, token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return base64url(new Uint8Array(digest))
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}

function proofHeaders(accessToken: string, proof: AccountProof): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Gestalt-Proof-Jti': proof.jti,
    'X-Gestalt-Proof-Issued-At': String(proof.issuedAt),
    'X-Gestalt-Proof-Signature': proof.signature,
  }
}

function isErrorBody(value: unknown): value is { error: { code: string; message: string; retryAfter?: number } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = value.error
  if (typeof error !== 'object' || error === null
    || !('code' in error) || typeof error.code !== 'string'
    || !('message' in error) || typeof error.message !== 'string') {
    return false
  }
  if ('retryAfter' in error && error.retryAfter !== undefined && !Number.isSafeInteger(error.retryAfter)) return false
  return true
}

function isAccountErrorCode(value: string): value is AccountErrorCode {
  return [
    'LOGIN_ATTEMPT_EXPIRED',
    'LOGIN_ATTEMPT_INVALID',
    'LOGIN_ATTEMPT_USED',
    'LOGIN_STATE_INVALID',
    'PROOF_INVALID',
    'PROOF_REPLAYED',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'QUOTA',
    'PLATFORM_CAPACITY',
  ].includes(value)
}

function withoutError(snapshot: PlatformAccountInstallationSnapshot): PlatformAccountInstallationSnapshot {
  if (snapshot.error === undefined) return snapshot
  const clean: PlatformAccountInstallationSnapshot = {
    status: snapshot.status,
    privacyAccepted: snapshot.privacyAccepted,
    ...(snapshot.account === undefined ? {} : { account: snapshot.account }),
  }
  return clean
}

function isTerminalSessionError(error: unknown): boolean {
  return error instanceof AccountError && (error.code === 'SESSION_REVOKED' || error.code === 'SESSION_EXPIRED')
}
