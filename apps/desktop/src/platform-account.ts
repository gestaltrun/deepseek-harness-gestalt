/** Desktop Host ownership of the current-installation Platform Account state. */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  AccountProof,
  InstallationId,
  AccountSessionView,
  LoginAttemptView,
  LoginPollResult,
  SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import type { CurrentInstallationAuthorization } from '@deepseek-ai/dsh-platform-account-client'
import {
  AccountLifecycleClosedError,
  AccountLifecycleTransitions,
  type PlatformAccountTransport,
  type SystemBrowser,
} from '@deepseek-ai/dsh-platform-account-client'
import {
  AccountError,
  parseAccountProofJti,
  parseAccountSessionView,
  parseInstallationId,
  parseLoginAttemptView,
} from '@deepseek-ai/dsh-platform-account'
import type { DesktopAccountSnapshot } from '@deepseek-ai/dsh-client-ui-desktop/protocol'

/** Entire encrypted Account record; account-scoped pairing material lives elsewhere. */
export interface PersistedDesktopAccount {
  installationId: InstallationId
  session?: AccountSessionView
  sessionPrivateKey?: string
  pending?: LoginAttemptView
  pendingPrivateKey?: string
}

/** Encryption operations supplied by Electron safeStorage. */
export interface DesktopAccountProtection {
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

/** Protected Desktop account-record persistence. */
export interface DesktopAccountStore {
  load(): Promise<PersistedDesktopAccount | undefined>
  save(record: PersistedDesktopAccount): Promise<void>
}

/** Encrypted, atomically replaced Desktop Account record. */
export class EncryptedDesktopAccountStore implements DesktopAccountStore {
  /** @param path - environment-specific file under Electron userData. */
  constructor(
    private readonly path: string,
    private readonly protection: DesktopAccountProtection,
  ) {}

  async load(): Promise<PersistedDesktopAccount | undefined> {
    let encoded: string
    try {
      encoded = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    }
    const value = JSON.parse(this.protection.decrypt(decodeBase64(encoded))) as unknown
    return parsePersistedDesktopAccount(value)
  }

  async save(record: PersistedDesktopAccount): Promise<void> {
    const encrypted = this.protection.encrypt(JSON.stringify(record))
    await writeFileAtomic(this.path, Buffer.from(encrypted).toString('base64'), { mode: 0o600, dirMode: 0o700 })
  }
}

/** Desktop controller construction inputs. */
export interface DesktopAccountControllerOptions {
  environment: SelectedPlatformEnvironment
  transport: PlatformAccountTransport
  store: DesktopAccountStore
  systemBrowser: SystemBrowser
  transitions?: AccountLifecycleTransitions
  now?: () => number
  schedule?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

/** Desktop Host Account operations exposed through the preload bridge. */
export interface DesktopAccountActions {
  getSnapshot(): DesktopAccountSnapshot
  acceptPrivacy(): Promise<DesktopAccountSnapshot>
  beginLogin(): Promise<DesktopAccountSnapshot>
  signOut(): Promise<DesktopAccountSnapshot>
  /** Authorize a Host-owned current-Installation operation without exposing the private key. */
  authorizeCurrentInstallation(): Promise<CurrentInstallationAuthorization>
  subscribe(listener: (snapshot: DesktopAccountSnapshot) => void): () => void
  start(): Promise<void>
  dispose(): Promise<void>
}

/** Account lifecycle whose private signing key never enters the renderer. */
export class DesktopAccountController implements DesktopAccountActions {
  private snapshot: DesktopAccountSnapshot = { status: 'idle', privacyAccepted: false }
  private record: PersistedDesktopAccount | undefined
  private readonly listeners = new Set<(snapshot: DesktopAccountSnapshot) => void>()
  private readonly now: () => number
  private readonly schedule: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private disposalGeneration = 0
  private readonly transitions: AccountLifecycleTransitions

  /** @param options - trusted transport, protected storage, system browser, and timing adapters. */
  constructor(private readonly options: DesktopAccountControllerOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? setTimeout
    this.transitions = options.transitions ?? new AccountLifecycleTransitions()
    if (options.transport.environment !== options.environment) {
      throw new TypeError('Desktop Account transport does not match the selected environment')
    }
  }

  getSnapshot(): DesktopAccountSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: DesktopAccountSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async start(): Promise<void> {
    await this.transitions.run(async () => { await this.startTransition() })
  }

  private async startTransition(): Promise<void> {
    this.record = await this.options.store.load()
    if (this.record === undefined) {
      this.record = { installationId: parseInstallationId(randomUUID()) }
      return
    }
    if (this.record.pending !== undefined) {
      if (this.record.pending.expiresAt > this.now() && this.record.pendingPrivateKey !== undefined) {
        this.publish({ status: 'polling', privacyAccepted: false })
        this.schedulePoll()
      } else {
        delete this.record.pending
        delete this.record.pendingPrivateKey
        await this.options.store.save(this.record)
      }
    }
    await this.restoreSession()
  }

  acceptPrivacy(): Promise<DesktopAccountSnapshot> {
    this.publish({ ...withoutDesktopError(this.snapshot), privacyAccepted: true })
    return Promise.resolve(this.snapshot)
  }

  async beginLogin(): Promise<DesktopAccountSnapshot> {
    return this.transitions.run(async () => this.beginLoginTransition())
  }

  private async beginLoginTransition(): Promise<DesktopAccountSnapshot> {
    if (!this.snapshot.privacyAccepted) throw new Error('privacy notice must be accepted before authorization')
    const record = this.requireRecord()
    this.publish({ status: 'authorizing', privacyAccepted: true })
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const attempt = await this.options.transport.beginLogin({
        installationId: record.installationId,
        installationKind: 'desktop',
        publicKey: publicKey.export({ format: 'jwk' }),
      })
      record.pending = attempt
      record.pendingPrivateKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      await this.options.systemBrowser.open(attempt.authorizationUrl)
      this.publish({ status: 'polling', privacyAccepted: true })
      this.schedulePoll()
      await this.options.store.save(record)
    } catch (error) {
      this.fail(error)
      throw error
    }
    return this.snapshot
  }

  async signOut(): Promise<DesktopAccountSnapshot> {
    return this.transitions.run(async () => this.signOutTransition())
  }

  async authorizeCurrentInstallation(): Promise<CurrentInstallationAuthorization> {
    return this.transitions.run(async () => {
      const record = this.requireRecord()
      if (record.session === undefined || record.sessionPrivateKey === undefined) {
        throw new AccountError('SESSION_REVOKED', 'Desktop Installation is not signed in')
      }
      if (record.session.refreshExpiresAt <= this.now()) {
        await this.clearSession(record)
        throw new AccountError('SESSION_EXPIRED', 'Desktop Account Session expired')
      }
      if (record.session.accessExpiresAt <= this.now()) {
        record.session = await this.options.transport.refresh({
          refreshToken: record.session.refreshToken,
          proof: desktopProof(
            record.sessionPrivateKey,
            'refresh',
            hash(record.session.refreshToken),
            this.now(),
          ),
        })
        await this.options.store.save(record)
        this.publish({
          status: 'signed-in',
          privacyAccepted: this.snapshot.privacyAccepted,
          account: record.session.account,
        })
      }
      return {
        accessToken: record.session.accessToken,
        proof: desktopProof(
          record.sessionPrivateKey,
          'current',
          hash(record.session.accessToken),
          this.now(),
        ),
      }
    })
  }

  private async signOutTransition(): Promise<DesktopAccountSnapshot> {
    const record = this.requireRecord()
    if (record.session === undefined || record.sessionPrivateKey === undefined) return this.snapshot
    this.publish({ ...withoutDesktopError(this.snapshot), status: 'signing-out' })
    try {
      await this.options.transport.signOut({
        accessToken: record.session.accessToken,
        proof: desktopProof(record.sessionPrivateKey, 'sign-out', hash(record.session.accessToken), this.now()),
      })
    } catch (error) {
      if (!isTerminalSessionError(error)) {
        this.fail(error)
        throw error
      }
    }
    delete record.session
    delete record.sessionPrivateKey
    await this.options.store.save(record)
    this.publish({ status: 'idle', privacyAccepted: this.snapshot.privacyAccepted })
    return this.snapshot
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposalGeneration += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
    await this.transitions.close()
  }

  private async restoreSession(): Promise<void> {
    const record = this.requireRecord()
    if (record.session === undefined || record.sessionPrivateKey === undefined) return
    if (record.session.refreshExpiresAt <= this.now()) {
      await this.clearSession(record)
      return
    }
    try {
      if (record.session.accessExpiresAt <= this.now()) {
        record.session = await this.options.transport.refresh({
          refreshToken: record.session.refreshToken,
          proof: desktopProof(record.sessionPrivateKey, 'refresh', hash(record.session.refreshToken), this.now()),
        })
      } else {
        const account = await this.options.transport.current({
          accessToken: record.session.accessToken,
          proof: desktopProof(record.sessionPrivateKey, 'current', hash(record.session.accessToken), this.now()),
        })
        record.session = { ...record.session, account }
      }
      await this.options.store.save(record)
      this.publish({ status: 'signed-in', privacyAccepted: this.snapshot.privacyAccepted, account: record.session.account })
    } catch (error) {
      if (isTerminalSessionError(error)) {
        await this.clearSession(record)
        return
      }
      this.fail(error)
    }
  }

  private schedulePoll(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.transitions.run(async () => { await this.poll() }).catch((error: unknown) => {
        if (error instanceof AccountLifecycleClosedError) return
        console.error('[desktop-platform-account] background poll failed:', error)
      })
    }, 1_500)
    this.timer.unref()
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    const generation = this.disposalGeneration
    const record = this.requireRecord()
    if (record.pending === undefined || record.pendingPrivateKey === undefined) return
    if (record.pending.expiresAt <= this.now()) {
      delete record.pending
      delete record.pendingPrivateKey
      await this.options.store.save(record)
      this.fail(new Error('GitHub authorization expired'))
      return
    }
    try {
      const result: LoginPollResult = await this.options.transport.pollLogin({
        attemptId: record.pending.id,
        pollingToken: record.pending.pollingToken,
        proof: desktopProof(
          record.pendingPrivateKey,
          'login-poll',
          `${record.pending.id}:${hash(record.pending.pollingToken)}`,
          this.now(),
        ),
      })
      if (generation !== this.disposalGeneration) return
      if (result.status === 'pending') {
        this.schedulePoll()
        return
      }
      record.session = result
      record.sessionPrivateKey = record.pendingPrivateKey
      delete record.pending
      delete record.pendingPrivateKey
      await this.options.store.save(record)
      this.publish({ status: 'signed-in', privacyAccepted: true, account: result.account })
    } catch (error) {
      if (generation !== this.disposalGeneration) return
      this.fail(error)
    }
  }

  private async clearSession(record: PersistedDesktopAccount): Promise<void> {
    delete record.session
    delete record.sessionPrivateKey
    await this.options.store.save(record)
    this.publish({ status: 'idle', privacyAccepted: this.snapshot.privacyAccepted })
  }

  private requireRecord(): PersistedDesktopAccount {
    if (this.record === undefined) throw new Error('Desktop Platform Account has not started')
    return this.record
  }

  private fail(error: unknown): void {
    this.publish({
      ...this.snapshot,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private publish(snapshot: DesktopAccountSnapshot): void {
    this.snapshot = snapshot
    const failures: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      console.error(
        '[desktop-platform-account] subscriber failures:',
        new AggregateError(failures, 'Desktop Platform Account subscribers failed'),
      )
    }
  }
}

/** Disabled Account lifecycle for unconfigured or encryption-incapable Desktop hosts. */
export class UnavailableDesktopAccountController implements DesktopAccountActions {
  private readonly snapshot: DesktopAccountSnapshot

  /** @param reason - non-secret setup or platform-capability explanation. */
  constructor(reason: string) {
    this.snapshot = { status: 'unavailable', privacyAccepted: false, error: reason }
  }

  getSnapshot(): DesktopAccountSnapshot { return this.snapshot }
  acceptPrivacy(): Promise<DesktopAccountSnapshot> { return Promise.resolve(this.snapshot) }
  beginLogin(): Promise<DesktopAccountSnapshot> { return Promise.resolve(this.snapshot) }
  signOut(): Promise<DesktopAccountSnapshot> { return Promise.resolve(this.snapshot) }
  authorizeCurrentInstallation(): Promise<CurrentInstallationAuthorization> {
    return Promise.reject(new AccountError('SESSION_REVOKED', 'Desktop Platform Account is unavailable'))
  }
  subscribe(): () => void { return () => {} }
  start(): Promise<void> { return Promise.resolve() }
  dispose(): Promise<void> { return Promise.resolve() }
}

function desktopProof(privateKey: string, operation: string, binding: string, issuedAt: number): AccountProof {
  const jti = parseAccountProofJti(randomUUID())
  const payload = Buffer.from(`${operation}\n${binding}\n${issuedAt}\n${jti}`, 'utf8')
  return {
    jti,
    issuedAt,
    signature: sign('sha256', payload, {
      key: createPrivateKey(privateKey),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function withoutDesktopError(snapshot: DesktopAccountSnapshot): DesktopAccountSnapshot {
  return {
    status: snapshot.status,
    privacyAccepted: snapshot.privacyAccepted,
    ...(snapshot.account === undefined ? {} : { account: snapshot.account }),
  }
}

function isTerminalSessionError(error: unknown): boolean {
  return error instanceof AccountError && (error.code === 'SESSION_REVOKED' || error.code === 'SESSION_EXPIRED')
}

function parsePersistedDesktopAccount(value: unknown): PersistedDesktopAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Desktop Platform Account record must be an object')
  }
  const record = value as Record<string, unknown>
  const session = record.session === undefined ? undefined : parseAccountSessionView(record.session)
  const sessionPrivateKey = optionalPrivateKey(record.sessionPrivateKey, 'sessionPrivateKey')
  const pending = record.pending === undefined ? undefined : parseLoginAttemptView(record.pending)
  const pendingPrivateKey = optionalPrivateKey(record.pendingPrivateKey, 'pendingPrivateKey')
  if ((session === undefined) !== (sessionPrivateKey === undefined)) {
    throw new TypeError('Desktop Platform Account session and private key must be stored together')
  }
  if ((pending === undefined) !== (pendingPrivateKey === undefined)) {
    throw new TypeError('Desktop Platform Account pending attempt and private key must be stored together')
  }
  const parsed: PersistedDesktopAccount = { installationId: parseInstallationId(record.installationId) }
  if (session !== undefined && sessionPrivateKey !== undefined) {
    parsed.session = session
    parsed.sessionPrivateKey = sessionPrivateKey
  }
  if (pending !== undefined && pendingPrivateKey !== undefined) {
    parsed.pending = pending
    parsed.pendingPrivateKey = pendingPrivateKey
  }
  return parsed
}

function optionalPrivateKey(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new TypeError(`Desktop Platform Account ${name} is invalid`)
  const key = createPrivateKey(value)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new TypeError(`Desktop Platform Account ${name} must be a P-256 private key`)
  }
  return value
}

function decodeBase64(value: string): Buffer {
  if (value === '' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError('Desktop Platform Account encrypted record is not canonical base64')
  }
  return Buffer.from(value, 'base64')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
