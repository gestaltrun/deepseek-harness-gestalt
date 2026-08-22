/**
 * Platform Account provider: GitHub OAuth, signed polling, P-256 installation
 * proof, rotating Account Sessions, and cross-instance invalidation.
 * @module @deepseek-ai/dsh-platform-account-core
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import AccountService, {
  AccountError,
  ACCOUNT_CONCURRENT_CONNECTION_LIMIT,
  ACCOUNT_DESKTOP_INSTALLATION_LIMIT,
  ACCOUNT_MOBILE_INSTALLATION_LIMIT,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  type AccountProof,
  type AuthenticatedInstallationView,
  type AccountProofJti,
  type AccountSessionId,
  type AccountSessionView,
  type InstallationKind,
  type InstallationId,
  type LoginAttemptId,
  type LoginAttemptView,
  type LoginPollResult,
  type PlatformAccountId,
  type PlatformAccountView,
  type PlatformCapacityState,
  type PlatformEnvironment,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'

export {
  loadOperatedPlatformEnvironment,
  loadPlatformEnvironment,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'
export type {
  OperatedPlatformEnvironmentInput,
  PlatformEnvironmentIdentity,
  PlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'

/** Fixed five-minute Login Attempt lifetime. */
export const LOGIN_ATTEMPT_TTL_MS = 5 * 60 * 1000
/** Fixed fifteen-minute access-token lifetime. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
/** Maximum and issued refresh-token lifetime. */
export const MAX_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Accepted clock skew for one installation proof. */
export const ACCOUNT_PROOF_WINDOW_MS = 60 * 1000

/** GitHub public identity retained after the provider token is discarded. */
export interface GitHubIdentity {
  /** Immutable numeric GitHub user id. */
  providerSubject: number
  /** Current public GitHub login. */
  login: string
  /** Current public GitHub avatar URL. */
  avatarUrl: string
}

/** GitHub OAuth adapter used by the Account provider. */
export interface GitHubIdentityProvider {
  /** Validated deployment identity owning the OAuth App and callback. */
  readonly environment: SelectedPlatformEnvironment
  /** Build the system-browser authorization URL with S256 PKCE and no scope parameter. */
  authorizationUrl(input: { callbackUrl: string; state: string; codeChallenge: string }): string
  /** Exchange one callback code and return only the public identity retained by Platform. */
  exchange(code: string, verifier: string): Promise<GitHubIdentity>
}

/** Construction inputs for the GitHub OAuth HTTP adapter. */
export interface GitHubOAuthIdentityProviderOptions {
  /** Environment selected from the validated deployment pair. */
  environment: SelectedPlatformEnvironment
  /** Secret resolved from the selected environment's credential reference. */
  credential: {
    reference: string
    secret: string
  }
  /** HTTP implementation; defaults to global fetch. */
  fetch?: typeof fetch
}

/** GitHub OAuth App adapter that returns only public identity fields. */
export class GitHubOAuthIdentityProvider implements GitHubIdentityProvider {
  private readonly fetch: typeof fetch
  /** Selected deployment identity owning this adapter. */
  readonly environment: SelectedPlatformEnvironment

  /** @param options - OAuth App identity, callback, secret, and HTTP adapter. */
  constructor(private readonly options: GitHubOAuthIdentityProviderOptions) {
    this.environment = options.environment
    this.fetch = options.fetch ?? globalThis.fetch
    if (options.credential.reference !== options.environment.credentialReference) {
      throw new TypeError('GitHub OAuth credential reference does not match the selected Platform environment')
    }
    if (options.credential.secret === '') throw new TypeError('GitHub OAuth client secret must be non-empty')
  }

  authorizationUrl(input: { callbackUrl: string; state: string; codeChallenge: string }): string {
    if (input.callbackUrl !== this.environment.callbackUrl) {
      throw new TypeError('GitHub OAuth callback does not match the configured fixed callback')
    }
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', this.environment.githubClientId)
    url.searchParams.set('redirect_uri', input.callbackUrl)
    url.searchParams.set('state', input.state)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  async exchange(code: string, verifier: string): Promise<GitHubIdentity> {
    const tokenResponse = await this.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.environment.githubClientId,
        client_secret: this.options.credential.secret,
        code,
        redirect_uri: this.environment.callbackUrl,
        code_verifier: verifier,
      }).toString(),
    })
    if (!tokenResponse.ok) throw new Error(`GitHub token exchange failed with HTTP ${tokenResponse.status}`)
    const tokenBody = await tokenResponse.json() as unknown
    if (!isRecord(tokenBody) || typeof tokenBody.access_token !== 'string') {
      throw new Error('GitHub token exchange returned no access token')
    }
    if (typeof tokenBody.scope !== 'string' || tokenBody.scope !== '') {
      throw new Error('GitHub returned a token with OAuth scopes; Platform Account accepts public identity only')
    }
    const identityResponse = await this.fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenBody.access_token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!identityResponse.ok) throw new Error(`GitHub identity lookup failed with HTTP ${identityResponse.status}`)
    const body = await identityResponse.json() as unknown
    if (!isRecord(body) || !Number.isSafeInteger(body.id)
      || typeof body.login !== 'string' || typeof body.avatar_url !== 'string') {
      throw new Error('GitHub identity response is missing public identity fields')
    }
    return { providerSubject: body.id as number, login: body.login, avatarUrl: body.avatar_url }
  }
}

/** Clock adapter for expiry and deterministic keyless scenarios. */
export interface AccountClock {
  /** @returns current Unix epoch milliseconds. */
  now(): number
}

/** Durable Login Attempt state owned by an {@link AccountBackend}. */
export interface LoginAttemptRecord {
  /** Opaque Login Attempt id. */
  id: LoginAttemptId
  /** Deployment environment that owns the attempt. */
  environment: PlatformEnvironment
  /** Provider identity namespace for the selected environment. */
  identityNamespace: string
  /** Stable id of the requesting installation. */
  installationId: InstallationId
  /** Desktop or Mobile installation class. */
  installationKind: InstallationKind
  /** Installation P-256 public key. */
  publicKey: JsonWebKey
  /** Random OAuth state bound to the attempt. */
  state: string
  /** PKCE verifier retained until the provider callback. */
  codeVerifier: string
  /** Unix epoch milliseconds after which the attempt is invalid. */
  expiresAt: number
  /** Single-use attempt lifecycle state. */
  status: 'pending' | 'authorized' | 'used'
  /** Public GitHub identity present only after callback authorization. */
  identity?: GitHubIdentity
}

/** Environment-scoped durable Platform Account record. */
export interface AccountRecord extends PlatformAccountView {
  /** Provider identity namespace that owns the account. */
  identityNamespace: string
}

/** Durable proof-of-possession Account Session state. */
export interface SessionRecord {
  /** Opaque Account Session id. */
  id: AccountSessionId
  /** Provider identity namespace that owns the session. */
  identityNamespace: string
  /** Platform Account authorized by the session. */
  accountId: PlatformAccountId
  /** Stable id of the authorized installation. */
  installationId: InstallationId
  /** Desktop or Mobile installation class. */
  installationKind: InstallationKind
  /** Installation P-256 public key. */
  publicKey: JsonWebKey
  /** Monotonic refresh-token generation. */
  revision: number
  /** Whether the session still authorizes requests. */
  active: boolean
  /** Hash of the current rotating refresh token. */
  refreshHash: string
  /** Unix epoch milliseconds after which refresh is forbidden. */
  refreshExpiresAt: number
}

/** Atomic result of consuming an authorized Login Attempt. */
export interface CreatedSession {
  /** Newly created session. */
  session: SessionRecord
  /** Platform Account selected or created for the GitHub identity. */
  account: AccountRecord
  /** Earlier session replaced for the same installation, when present. */
  replacedSessionId?: AccountSessionId
}

/** Persistence operations requiring atomic compare-and-mutate behavior. */
export interface AccountBackend {
  /** Durable database identity selected for this deployment. */
  readonly databaseIdentity: string
  /** Persist a new Login Attempt. */
  createAttempt(record: LoginAttemptRecord): Promise<void>
  /** Find the Login Attempt bound to one OAuth state. */
  findAttemptByState(state: string): Promise<LoginAttemptRecord | undefined>
  /** Read one Login Attempt by id. */
  getAttempt(id: LoginAttemptId): Promise<LoginAttemptRecord | undefined>
  /** Attach public provider identity after a valid callback. */
  authorizeAttempt(id: LoginAttemptId, identity: GitHubIdentity): Promise<void>
  /** Atomically consume authorization, enforce the installation quota, and replace the installation session. */
  consumeAuthorizedAttempt(id: LoginAttemptId, refreshHash: string, refreshExpiresAt: number): Promise<CreatedSession>
  /** Find a session by the hash of its current refresh token. */
  getSessionByRefreshHash(hash: string): Promise<SessionRecord | undefined>
  /** Read one session by id. */
  getSession(id: AccountSessionId): Promise<SessionRecord | undefined>
  /** Read one Platform Account by id. */
  getAccount(id: PlatformAccountId): Promise<AccountRecord | undefined>
  /** Atomically rotate the matching refresh token generation. */
  rotateRefresh(sessionId: AccountSessionId, expectedHash: string, replacementHash: string): Promise<SessionRecord | undefined>
  /** Revoke one session and report whether it was active. */
  revokeSession(sessionId: AccountSessionId): Promise<boolean>
  /** Atomically reject replayed proof ids inside their validity window. */
  consumeProof(jti: AccountProofJti, expiresAt: number, now: number): Promise<boolean>
  /** Count live installations of one kind for an Account. */
  countActiveInstallations(accountId: PlatformAccountId, kind: InstallationKind): Promise<number>
  /** Read the Account bound to one GitHub subject inside an identity namespace. */
  findAccountByIdentity(identityNamespace: string, providerSubject: number): Promise<AccountRecord | undefined>
  /** Read the live session bound to one installation, when present. */
  findActiveSessionByInstallation(
    identityNamespace: string,
    installationId: InstallationId,
  ): Promise<SessionRecord | undefined>
}

/** Shared invalidation channel used by every Platform Instance. */
export interface AccountInvalidationBus {
  /** Publish one committed Account Session invalidation after every subscriber settles. */
  publish(sessionId: AccountSessionId): Promise<void>
  /** Subscribe to committed Account Session invalidations. */
  subscribe(listener: (sessionId: AccountSessionId) => void | Promise<void>): () => void
}

/** In-process backend for keyless assembled scenarios and development. */
export class MemoryAccountBackend implements AccountBackend {
  private readonly attempts = new Map<LoginAttemptId, LoginAttemptRecord>()
  private readonly stateIndex = new Map<string, LoginAttemptId>()
  private readonly accounts = new Map<PlatformAccountId, AccountRecord>()
  private readonly accountIndex = new Map<string, PlatformAccountId>()
  private readonly sessions = new Map<AccountSessionId, SessionRecord>()
  private readonly refreshIndex = new Map<string, AccountSessionId>()
  private readonly installationIndex = new Map<string, AccountSessionId>()
  private readonly proofs = new Map<AccountProofJti, number>()

  /**
   * @param databaseIdentity - deployment database identity bound to this backend.
   */
  constructor(readonly databaseIdentity: string) {
    if (databaseIdentity.trim() === '') throw new TypeError('Account backend database identity must be non-empty')
  }

  createAttempt(record: LoginAttemptRecord): Promise<void> {
    this.attempts.set(record.id, structuredClone(record))
    this.stateIndex.set(record.state, record.id)
    return Promise.resolve()
  }

  findAttemptByState(state: string): Promise<LoginAttemptRecord | undefined> {
    const id = this.stateIndex.get(state)
    return Promise.resolve(id === undefined ? undefined : this.cloneAttempt(this.attempts.get(id)))
  }

  getAttempt(id: LoginAttemptId): Promise<LoginAttemptRecord | undefined> {
    return Promise.resolve(this.cloneAttempt(this.attempts.get(id)))
  }

  authorizeAttempt(id: LoginAttemptId, identity: GitHubIdentity): Promise<void> {
    const attempt = this.attempts.get(id)
    if (attempt === undefined || attempt.status !== 'pending') {
      return Promise.reject(new AccountError('LOGIN_ATTEMPT_USED', 'login attempt is no longer pending'))
    }
    attempt.status = 'authorized'
    attempt.identity = structuredClone(identity)
    this.stateIndex.delete(attempt.state)
    return Promise.resolve()
  }

  consumeAuthorizedAttempt(
    id: LoginAttemptId,
    refreshHash: string,
    refreshExpiresAt: number,
  ): Promise<CreatedSession> {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return Promise.reject(new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is unknown'))
    if (attempt.status === 'used') return Promise.reject(new AccountError('LOGIN_ATTEMPT_USED', 'login attempt was already consumed'))
    if (attempt.status !== 'authorized' || attempt.identity === undefined) {
      return Promise.reject(new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is not authorized'))
    }
    const identityKey = `${attempt.identityNamespace}:${attempt.identity.providerSubject}`
    let accountId = this.accountIndex.get(identityKey)
    if (accountId === undefined) {
      accountId = randomUUID() as PlatformAccountId
      this.accountIndex.set(identityKey, accountId)
    }
    const account: AccountRecord = {
      id: accountId,
      identityNamespace: attempt.identityNamespace,
      githubId: attempt.identity.providerSubject,
      githubLogin: attempt.identity.login,
      avatarUrl: attempt.identity.avatarUrl,
    }
    this.accounts.set(accountId, account)

    const installationKey = `${attempt.identityNamespace}:${attempt.installationId}`
    const replacedSessionId = this.installationIndex.get(installationKey)
    if (replacedSessionId !== undefined) {
      this.revoke(replacedSessionId)
    } else if (this.activeInstallationCount(accountId, attempt.installationKind) >= installationLimit(attempt.installationKind)) {
      return Promise.reject(installationQuotaError(attempt.installationKind))
    }
    const session: SessionRecord = {
      id: randomUUID() as AccountSessionId,
      identityNamespace: attempt.identityNamespace,
      accountId,
      installationId: attempt.installationId,
      installationKind: attempt.installationKind,
      publicKey: structuredClone(attempt.publicKey),
      revision: 1,
      active: true,
      refreshHash,
      refreshExpiresAt,
    }
    this.sessions.set(session.id, session)
    this.refreshIndex.set(refreshHash, session.id)
    this.installationIndex.set(installationKey, session.id)
    attempt.status = 'used'
    delete attempt.identity
    return Promise.resolve({
      session: structuredClone(session),
      account: structuredClone(account),
      ...(replacedSessionId === undefined ? {} : { replacedSessionId }),
    })
  }

  getSessionByRefreshHash(hash: string): Promise<SessionRecord | undefined> {
    const id = this.refreshIndex.get(hash)
    return Promise.resolve(id === undefined ? undefined : this.cloneSession(this.sessions.get(id)))
  }

  getSession(id: AccountSessionId): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.cloneSession(this.sessions.get(id)))
  }

  getAccount(id: PlatformAccountId): Promise<AccountRecord | undefined> {
    const account = this.accounts.get(id)
    return Promise.resolve(account === undefined ? undefined : structuredClone(account))
  }

  rotateRefresh(
    sessionId: AccountSessionId,
    expectedHash: string,
    replacementHash: string,
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || !session.active || session.refreshHash !== expectedHash) return Promise.resolve(undefined)
    this.refreshIndex.delete(expectedHash)
    session.refreshHash = replacementHash
    session.revision += 1
    this.refreshIndex.set(replacementHash, session.id)
    return Promise.resolve(structuredClone(session))
  }

  revokeSession(sessionId: AccountSessionId): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || !session.active) return Promise.resolve(false)
    this.revoke(sessionId)
    return Promise.resolve(true)
  }

  consumeProof(jti: AccountProofJti, expiresAt: number, now: number): Promise<boolean> {
    for (const [id, expiry] of this.proofs) {
      if (expiry < now) this.proofs.delete(id)
    }
    if (this.proofs.has(jti)) return Promise.resolve(false)
    this.proofs.set(jti, expiresAt)
    return Promise.resolve(true)
  }

  countActiveInstallations(accountId: PlatformAccountId, kind: InstallationKind): Promise<number> {
    return Promise.resolve(this.activeInstallationCount(accountId, kind))
  }

  private activeInstallationCount(accountId: PlatformAccountId, kind: InstallationKind): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.active && session.accountId === accountId && session.installationKind === kind) count += 1
    }
    return count
  }

  findAccountByIdentity(identityNamespace: string, providerSubject: number): Promise<AccountRecord | undefined> {
    const accountId = this.accountIndex.get(`${identityNamespace}:${providerSubject}`)
    return Promise.resolve(accountId === undefined ? undefined : structuredClone(this.accounts.get(accountId)))
  }

  findActiveSessionByInstallation(
    identityNamespace: string,
    installationId: InstallationId,
  ): Promise<SessionRecord | undefined> {
    const sessionId = this.installationIndex.get(`${identityNamespace}:${installationId}`)
    if (sessionId === undefined) return Promise.resolve(undefined)
    const session = this.sessions.get(sessionId)
    if (session?.active !== true) return Promise.resolve(undefined)
    return Promise.resolve(this.cloneSession(session))
  }

  private revoke(sessionId: AccountSessionId): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined || !session.active) return
    session.active = false
    session.revision += 1
    this.refreshIndex.delete(session.refreshHash)
  }

  private cloneAttempt(record: LoginAttemptRecord | undefined): LoginAttemptRecord | undefined {
    return record === undefined ? undefined : structuredClone(record)
  }

  private cloneSession(record: SessionRecord | undefined): SessionRecord | undefined {
    return record === undefined ? undefined : structuredClone(record)
  }
}

/** In-process invalidation bus for two-instance keyless scenarios. */
export class MemoryAccountInvalidationBus implements AccountInvalidationBus {
  private readonly listeners = new Set<(sessionId: AccountSessionId) => void | Promise<void>>()

  async publish(sessionId: AccountSessionId): Promise<void> {
    const errors: Error[] = []
    for (const listener of this.listeners) {
      try {
        await listener(sessionId)
      } catch (error) {
        errors.push(asError(error))
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Account invalidation failed: ${errors.map(error => error.message).join('; ')}`)
    }
  }

  subscribe(listener: (sessionId: AccountSessionId) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** Secret signing material for one Platform Account provider. */
export interface PlatformAccountConfig {
  /** Shared secret used to sign short-lived access tokens. */
  tokenSigningKey: Uint8Array
  /** Shared secret used to sign five-minute polling tokens. */
  pollingSigningKey: Uint8Array
}

/** Construction dependencies for one Platform Account instance. */
export interface PlatformAccountOptions {
  /** Durable atomic persistence shared by Platform Instances. */
  backend: AccountBackend
  /** Cross-instance channel carrying committed session invalidations. */
  invalidation: AccountInvalidationBus
  /** GitHub public-identity adapter for the selected environment. */
  github: GitHubIdentityProvider
  /** Identity selected from a validated development/production pair. */
  environment: SelectedPlatformEnvironment
  /** Secret signing material for the selected environment. */
  config: PlatformAccountConfig
  /** Optional deterministic time source. */
  clock?: AccountClock
  /** Shared two-instance capacity watermark; omitted compositions never shed login. */
  capacity?: PlatformCapacityState
}

interface SignedAccessPayload {
  sessionId: AccountSessionId
  accountId: PlatformAccountId
  namespace: string
  revision: number
  expiresAt: number
}

interface SignedPollingPayload {
  attemptId: LoginAttemptId
  namespace: string
  expiresAt: number
}

/**
 * Produce canonical bytes signed by installation P-256 keys.
 * @param input - operation, token binding, timestamp, and single-use proof id.
 * @returns UTF-8 signature payload.
 */
export function accountProofPayload(input: {
  operation: string
  binding: string
  issuedAt: number
  jti: AccountProofJti
}): Buffer {
  return Buffer.from(`${input.operation}\n${input.binding}\n${input.issuedAt}\n${input.jti}`, 'utf8')
}

/**
 * Hash a bearer without retaining or logging it.
 * @param token - opaque bearer token.
 * @returns base64url SHA-256 digest.
 */
export function hashAccountToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * Platform Account provider mounted once per Platform Instance. All durable
 * mutation is delegated to the shared backend before invalidation publishes.
 */
export class PlatformAccount extends AccountService {
  private readonly backend: AccountBackend
  private readonly invalidation: AccountInvalidationBus
  private readonly github: GitHubIdentityProvider
  /** Validated deployment identity owning every operation. */
  readonly environment: SelectedPlatformEnvironment
  private readonly config: PlatformAccountConfig
  private readonly clock: AccountClock
  private readonly capacity: PlatformCapacityState | undefined
  private readonly sessionAccounts = new Map<AccountSessionId, PlatformAccountId>()
  private readonly connections = new Map<AccountSessionId, Set<() => void | Promise<void>>>()
  private readonly stopInvalidation: () => void

  /**
   * @param ctx - Platform Cordis context.
   * @param options - shared backend, provider, invalidation, and environment configuration.
   */
  constructor(ctx: Context, options: PlatformAccountOptions) {
    super(ctx)
    this.backend = options.backend
    this.invalidation = options.invalidation
    this.github = options.github
    this.environment = options.environment
    if (this.backend.databaseIdentity !== this.environment.databaseIdentity) {
      throw new TypeError('Account backend database identity does not match the selected Platform environment')
    }
    if (this.github.environment !== this.environment) {
      throw new TypeError('GitHub OAuth adapter does not match the selected Platform environment')
    }
    this.config = validateConfig(options.config)
    this.clock = options.clock ?? { now: Date.now }
    this.capacity = options.capacity
    this.stopInvalidation = this.invalidation.subscribe(async (sessionId) => { await this.closeConnections(sessionId) })
    ctx.effect(() => async () => { await this.dispose() }, 'platform-account: invalidation subscription')
  }

  async beginLogin(input: {
    installationId: InstallationId
    installationKind: InstallationKind
    publicKey: JsonWebKey
  }): Promise<LoginAttemptView> {
    this.assertCapacity()
    validateP256PublicKey(input.publicKey)
    const now = this.clock.now()
    const id = randomUUID() as LoginAttemptId
    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const expiresAt = now + LOGIN_ATTEMPT_TTL_MS
    await this.backend.createAttempt({
      id,
      environment: this.environment.environment,
      identityNamespace: this.environment.identityNamespace,
      installationId: input.installationId,
      installationKind: input.installationKind,
      publicKey: structuredClone(input.publicKey),
      state,
      codeVerifier,
      expiresAt,
      status: 'pending',
    })
    const pollingToken = signEnvelope({
      attemptId: id,
      namespace: this.environment.identityNamespace,
      expiresAt,
    }, this.config.pollingSigningKey)
    return {
      id,
      state,
      authorizationUrl: this.github.authorizationUrl({
        callbackUrl: this.environment.callbackUrl,
        state,
        codeChallenge,
      }),
      pollingToken,
      expiresAt,
    }
  }

  async completeGitHubCallback(input: { code: string; state: string }): Promise<{ completed: true }> {
    const attempt = await this.backend.findAttemptByState(input.state)
    if (attempt === undefined) throw new AccountError('LOGIN_STATE_INVALID', 'login callback state is invalid')
    if (attempt.expiresAt <= this.clock.now()) {
      throw new AccountError('LOGIN_ATTEMPT_EXPIRED', 'login attempt expired before callback')
    }
    const identity = await this.github.exchange(input.code, attempt.codeVerifier)
    validateGitHubIdentity(identity)
    await this.backend.authorizeAttempt(attempt.id, identity)
    return { completed: true }
  }

  async pollLogin(input: {
    attemptId: LoginAttemptId
    pollingToken: string
    proof: AccountProof
  }): Promise<LoginPollResult> {
    const payload = verifyEnvelope(input.pollingToken, this.config.pollingSigningKey) as SignedPollingPayload
    if (payload.attemptId !== input.attemptId || payload.namespace !== this.environment.identityNamespace) {
      throw new AccountError('LOGIN_ATTEMPT_INVALID', 'polling token does not bind this attempt')
    }
    const now = this.clock.now()
    if (payload.expiresAt <= now) throw new AccountError('LOGIN_ATTEMPT_EXPIRED', 'login attempt expired')
    const attempt = await this.backend.getAttempt(payload.attemptId)
    if (attempt === undefined) throw new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is unknown')
    if (attempt.status === 'used') throw new AccountError('LOGIN_ATTEMPT_USED', 'login attempt was already consumed')
    await this.verifyProof(
      attempt.publicKey,
      'login-poll',
      `${attempt.id}:${hashAccountToken(input.pollingToken)}`,
      input.proof,
    )
    if (attempt.status === 'pending') return { status: 'pending' }
    this.assertCapacity()
    await this.assertInstallationQuota(attempt)
    const refreshToken = randomBytes(32).toString('base64url')
    const created = await this.backend.consumeAuthorizedAttempt(
      attempt.id,
      hashAccountToken(refreshToken),
      now + MAX_REFRESH_TOKEN_TTL_MS,
    )
    if (created.replacedSessionId !== undefined) {
      this.sessionAccounts.delete(created.replacedSessionId)
      await this.invalidation.publish(created.replacedSessionId)
    }
    this.sessionAccounts.set(created.session.id, created.account.id)
    return { status: 'complete', ...this.issueSession(created.session, created.account, refreshToken, now) }
  }

  async refresh(input: { refreshToken: string; proof: AccountProof }): Promise<AccountSessionView> {
    const now = this.clock.now()
    const currentHash = hashAccountToken(input.refreshToken)
    const session = await this.backend.getSessionByRefreshHash(currentHash)
    if (session === undefined || !session.active) throw new AccountError('SESSION_REVOKED', 'Account Session is revoked')
    if (session.refreshExpiresAt <= now) {
      await this.revoke(session.id)
      throw new AccountError('SESSION_EXPIRED', 'Account Session refresh lifetime expired')
    }
    if (now > session.refreshExpiresAt - ACCESS_TOKEN_TTL_MS) {
      throw new AccountError('SESSION_EXPIRED', 'Account Session cannot issue a full access-token lifetime')
    }
    await this.verifyProof(session.publicKey, 'refresh', currentHash, input.proof)
    const replacement = randomBytes(32).toString('base64url')
    const rotated = await this.backend.rotateRefresh(session.id, currentHash, hashAccountToken(replacement))
    if (rotated === undefined) throw new AccountError('SESSION_REVOKED', 'Account Session refresh token was already rotated')
    const account = await this.requireAccount(rotated.accountId)
    return this.issueSession(rotated, account, replacement, now)
  }

  async current(input: { accessToken: string; proof: AccountProof }): Promise<PlatformAccountView> {
    const { payload, session } = await this.authorizeAccess(input.accessToken)
    await this.verifyProof(session.publicKey, 'current', hashAccountToken(input.accessToken), input.proof)
    return accountView(await this.requireAccount(payload.accountId))
  }

  async currentInstallation(input: {
    accessToken: string
    proof: AccountProof
  }): Promise<AuthenticatedInstallationView> {
    const { payload, session } = await this.authorizeAccess(input.accessToken)
    await this.verifyProof(session.publicKey, 'current', hashAccountToken(input.accessToken), input.proof)
    return {
      account: accountView(await this.requireAccount(payload.accountId)),
      installation: { id: session.installationId, kind: session.installationKind },
    }
  }

  async signOut(input: { accessToken: string; proof: AccountProof }): Promise<void> {
    const { session } = await this.authorizeAccess(input.accessToken)
    await this.verifyProof(session.publicKey, 'sign-out', hashAccountToken(input.accessToken), input.proof)
    await this.revoke(session.id)
  }

  async trackConnection(sessionId: AccountSessionId, close: () => void | Promise<void>): Promise<() => void> {
    let accountId = this.sessionAccounts.get(sessionId)
    if (accountId === undefined) {
      const session = await this.backend.getSession(sessionId)
      if (session === undefined || !session.active) {
        throw new AccountError('SESSION_REVOKED', 'Account Session is unavailable')
      }
      accountId = session.accountId
      this.sessionAccounts.set(sessionId, accountId)
    }
    if (this.countAccountConnections(accountId) >= ACCOUNT_CONCURRENT_CONNECTION_LIMIT) {
      throw new AccountError(
        'QUOTA',
        'Platform Account has reached its concurrent connection limit',
        OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
      )
    }
    let set = this.connections.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.connections.set(sessionId, set)
    }
    set.add(close)
    return () => {
      const current = this.connections.get(sessionId)
      current?.delete(close)
      if (current?.size === 0) this.connections.delete(sessionId)
    }
  }

  /** Stop the cross-instance subscription and close locally tracked connections. */
  async dispose(): Promise<void> {
    this.stopInvalidation()
    const errors: Error[] = []
    for (const sessionId of [...this.connections.keys()]) {
      try {
        await this.closeConnections(sessionId)
      } catch (error) {
        errors.push(asError(error))
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Account connection disposal failed: ${errors.map(error => error.message).join('; ')}`)
    }
  }

  private async authorizeAccess(accessToken: string): Promise<{ payload: SignedAccessPayload; session: SessionRecord }> {
    const payload = verifyEnvelope(accessToken, this.config.tokenSigningKey) as SignedAccessPayload
    const now = this.clock.now()
    if (payload.expiresAt <= now) throw new AccountError('SESSION_EXPIRED', 'access token expired')
    if (payload.namespace !== this.environment.identityNamespace) {
      throw new AccountError('SESSION_REVOKED', 'access token belongs to another identity namespace')
    }
    const session = await this.backend.getSession(payload.sessionId)
    if (session === undefined || !session.active || session.revision !== payload.revision) {
      throw new AccountError('SESSION_REVOKED', 'Account Session is revoked')
    }
    this.sessionAccounts.set(session.id, session.accountId)
    return { payload, session }
  }

  private issueSession(
    session: SessionRecord,
    account: AccountRecord,
    refreshToken: string,
    now: number,
  ): AccountSessionView {
    const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS
    return {
      sessionId: session.id,
      account: accountView(account),
      accessToken: signEnvelope({
        sessionId: session.id,
        accountId: session.accountId,
        namespace: session.identityNamespace,
        revision: session.revision,
        expiresAt: accessExpiresAt,
      }, this.config.tokenSigningKey),
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    }
  }

  private async verifyProof(
    publicKey: JsonWebKey,
    operation: string,
    binding: string,
    proof: AccountProof,
  ): Promise<void> {
    const now = this.clock.now()
    if (!Number.isSafeInteger(proof.issuedAt) || Math.abs(now - proof.issuedAt) > ACCOUNT_PROOF_WINDOW_MS) {
      throw new AccountError('PROOF_INVALID', 'installation proof is outside the accepted time window')
    }
    const signature = Buffer.from(proof.signature, 'base64url')
    const valid = verify('sha256', accountProofPayload({ operation, binding, ...proof }), {
      key: createPublicKey({ key: publicKey as import('node:crypto').JsonWebKey, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    }, signature)
    if (!valid) throw new AccountError('PROOF_INVALID', 'installation proof signature is invalid')
    const consumed = await this.backend.consumeProof(proof.jti, now + ACCOUNT_PROOF_WINDOW_MS, now)
    if (!consumed) throw new AccountError('PROOF_REPLAYED', 'installation proof was already used')
  }

  private async revoke(sessionId: AccountSessionId): Promise<void> {
    this.sessionAccounts.delete(sessionId)
    if (await this.backend.revokeSession(sessionId)) await this.invalidation.publish(sessionId)
  }

  private async closeConnections(sessionId: AccountSessionId): Promise<void> {
    const connections = this.connections.get(sessionId)
    this.connections.delete(sessionId)
    this.sessionAccounts.delete(sessionId)
    if (connections === undefined) return
    const errors: Error[] = []
    for (const close of connections) {
      try {
        await close()
      } catch (error) {
        errors.push(asError(error))
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Account connection close failed: ${errors.map(error => error.message).join('; ')}`)
    }
  }

  private async requireAccount(id: PlatformAccountId): Promise<AccountRecord> {
    const account = await this.backend.getAccount(id)
    if (account === undefined) throw new AccountError('SESSION_REVOKED', 'Account Session account is unavailable')
    return account
  }

  private assertCapacity(): void {
    if (this.capacity?.shedding !== true) return
    throw new AccountError(
      'PLATFORM_CAPACITY',
      'Platform has reached capacity',
      this.capacity.retryAfterSeconds,
    )
  }

  private async assertInstallationQuota(attempt: LoginAttemptRecord): Promise<void> {
    const existing = await this.backend.findActiveSessionByInstallation(
      attempt.identityNamespace,
      attempt.installationId,
    )
    if (existing !== undefined) return
    const identity = attempt.identity
    if (identity === undefined) return
    const account = await this.backend.findAccountByIdentity(attempt.identityNamespace, identity.providerSubject)
    if (account === undefined) return
    const count = await this.backend.countActiveInstallations(account.id, attempt.installationKind)
    if (count >= installationLimit(attempt.installationKind)) {
      throw installationQuotaError(attempt.installationKind)
    }
  }

  private countAccountConnections(accountId: PlatformAccountId): number {
    let count = 0
    for (const [sessionId, closers] of this.connections) {
      if (this.sessionAccounts.get(sessionId) === accountId) count += closers.size
    }
    return count
  }
}

function accountView(account: AccountRecord): PlatformAccountView {
  return {
    id: account.id,
    githubId: account.githubId,
    githubLogin: account.githubLogin,
    avatarUrl: account.avatarUrl,
  }
}

function installationLimit(kind: InstallationKind): number {
  return kind === 'desktop' ? ACCOUNT_DESKTOP_INSTALLATION_LIMIT : ACCOUNT_MOBILE_INSTALLATION_LIMIT
}

function installationQuotaError(kind: InstallationKind): AccountError {
  return new AccountError(
    'QUOTA',
    `Platform Account has reached its ${kind} installation limit`,
    OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  )
}

function validateConfig(config: PlatformAccountConfig): PlatformAccountConfig {
  if (config.tokenSigningKey.byteLength < 32 || config.pollingSigningKey.byteLength < 32) {
    throw new TypeError('Platform Account signing keys must contain at least 256 bits')
  }
  return config
}

function validateP256PublicKey(key: JsonWebKey): void {
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.d !== undefined) {
    throw new AccountError('PROOF_INVALID', 'installation public key must be a public P-256 JWK')
  }
}

function validateGitHubIdentity(identity: GitHubIdentity): void {
  if (!Number.isSafeInteger(identity.providerSubject) || identity.providerSubject <= 0) {
    throw new TypeError('GitHub identity id must be a positive safe integer')
  }
  if (identity.login === '' || identity.avatarUrl === '') throw new TypeError('GitHub public identity is incomplete')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function signEnvelope(payload: object, key: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyEnvelope(token: string, key: Uint8Array): unknown {
  const [encoded, supplied, extra] = token.split('.')
  if (encoded === undefined || supplied === undefined || extra !== undefined) {
    throw new AccountError('SESSION_REVOKED', 'signed Account token is malformed')
  }
  const expected = createHmac('sha256', key).update(encoded).digest()
  const actual = Buffer.from(supplied, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AccountError('SESSION_REVOKED', 'signed Account token is invalid')
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch (error) {
    throw new AccountError('SESSION_REVOKED', `signed Account token payload is invalid: ${String(error)}`)
  }
}

export default PlatformAccount
