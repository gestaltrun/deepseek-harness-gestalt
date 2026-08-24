import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  AccountProof,
  AccountSessionId,
  LoginAttemptId,
  PlatformAccountId,
  PlatformCapacityState,
} from '@deepseek-ai/dsh-platform-account'
import {
  ACCOUNT_CONCURRENT_CONNECTION_LIMIT,
  ACCOUNT_DESKTOP_INSTALLATION_LIMIT,
  ACCOUNT_MOBILE_INSTALLATION_LIMIT,
  AccountError,
  OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
  parseAccountProofJti,
  parseInstallationId,
  parseLoginAttemptId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'
import {
  ACCESS_TOKEN_TTL_MS,
  ACCOUNT_PROOF_WINDOW_MS,
  LOGIN_ATTEMPT_TTL_MS,
  MAX_REFRESH_TOKEN_TTL_MS,
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  accountProofPayload,
  hashAccountToken,
  type AccountBackend,
  type GitHubIdentity,
  type GitHubIdentityProvider,
  type PlatformAccountConfig,
} from '../src/index.ts'

const NOW = Date.parse('2026-08-17T10:00:00.000Z')
const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development',
    origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'github-client-development',
    credentialReference: 'credentials://platform-account/development/github-oauth-app',
    databaseIdentity: 'database-development',
    identityNamespace: 'gestalt-development',
  },
  production: {
    environment: 'production',
    origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'github-client-production',
    credentialReference: 'credentials://platform-account/production/github-oauth-app',
    databaseIdentity: 'database-production',
    identityNamespace: 'gestalt-production',
  },
}), 'development')

function installationKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }),
    proof(operation: string, binding: string, issuedAt = NOW): AccountProof {
      const jti = parseAccountProofJti(randomUUID())
      return {
        jti,
        issuedAt,
        signature: sign('sha256', accountProofPayload({ operation, binding, issuedAt, jti }), {
          key: pair.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }
    },
  }
}

function github(): GitHubIdentityProvider & { exchanges: Array<{ code: string; verifier: string }> } {
  const exchanges: Array<{ code: string; verifier: string }> = []
  return {
    exchanges,
    environment: ENVIRONMENT,
    authorizationUrl(input) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', 'github-client-development')
      url.searchParams.set('redirect_uri', input.callbackUrl)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },
    async exchange(code, verifier) {
      exchanges.push({ code, verifier })
      return { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
    },
  }
}

const CONFIG: PlatformAccountConfig = {
  tokenSigningKey: Buffer.alloc(32, 7),
  pollingSigningKey: Buffer.alloc(32, 9),
}

function accountHarness(options: {
  backend?: AccountBackend
  invalidation?: MemoryAccountInvalidationBus
  provider?: GitHubIdentityProvider
  clock?: { now(): number }
  config?: PlatformAccountConfig
  capacity?: PlatformCapacityState
} = {}) {
  const backend = options.backend ?? new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
  const invalidation = options.invalidation ?? new MemoryAccountInvalidationBus()
  const provider = options.provider ?? github()
  const clock = options.clock ?? { now: () => NOW }
  const config = options.config ?? CONFIG
  const capacity = options.capacity
  const accountOptions = {
    backend, invalidation, github: provider, environment: ENVIRONMENT, clock, config,
    ...(capacity === undefined ? {} : { capacity }),
  }
  const first = new PlatformAccount(new Context(), accountOptions)
  const second = new PlatformAccount(new Context(), accountOptions)
  return { backend, invalidation, provider, clock, config, first, second }
}

async function login(
  account: PlatformAccount,
  key = installationKey(),
  installationId = parseInstallationId('installation-1'),
  installationKind: 'desktop' | 'mobile' = 'desktop',
): Promise<{ key: ReturnType<typeof installationKey>; session: Extract<Awaited<ReturnType<PlatformAccount['pollLogin']>>, { status: 'complete' }> }> {
  const attempt = await account.beginLogin(installationKind === 'mobile'
    ? {
      installationId,
      installationKind,
      presentation: { name: `${installationId} presentation`, platform: 'ios' },
      publicKey: key.publicKey,
    }
    : {
      installationId, installationKind,
      presentation: { name: `${installationId} presentation`, platform: 'linux' },
      publicKey: key.publicKey,
    })
  await account.completeGitHubCallback({ code: 'code', state: attempt.state })
  const result = await account.pollLogin({
    attemptId: attempt.id,
    pollingToken: attempt.pollingToken,
    proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
  })
  if (result.status !== 'complete') throw new Error('expected complete login')
  return { key, session: result }
}

function replaceEnvelope(token: string, key: Uint8Array, mutate: (payload: Record<string, unknown>) => void): string {
  const encoded = token.split('.')[0]
  if (encoded === undefined) throw new Error('expected signed token')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
  mutate(payload)
  return signEncoded(Buffer.from(JSON.stringify(payload)).toString('base64url'), key)
}

function signEncoded(encoded: string, key: Uint8Array): string {
  return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`
}

function tamperEnvelopeSignature(token: string): string {
  const separator = token.indexOf('.')
  const encoded = token.slice(0, separator)
  const signature = Buffer.from(token.slice(separator + 1), 'base64url')
  const firstByte = signature[0]
  if (firstByte === undefined) throw new Error('expected signed token')
  signature[0] = firstByte ^ 0x80
  return `${encoded}.${signature.toString('base64url')}`
}

function proxyBackend(base: AccountBackend, overrides: Partial<AccountBackend>): AccountBackend {
  return new Proxy(base, {
    get(target, property) {
      const override = Reflect.get(overrides, property) as unknown
      if (override !== undefined) return override
      return Reflect.get(target, property) as unknown
    },
  })
}

describe('PlatformAccount', () => {
  it('preserves absence when consuming a durable login attempt from before Installation presentation', async () => {
    const backend = new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
    const attemptId = parseLoginAttemptId('legacy-attempt')
    await backend.createAttempt({
      id: attemptId,
      environment: ENVIRONMENT.environment,
      identityNamespace: ENVIRONMENT.identityNamespace,
      installationId: parseInstallationId('legacy-installation'),
      installationKind: 'desktop',
      publicKey: installationKey().publicKey,
      state: 'legacy-state',
      codeVerifier: 'legacy-verifier',
      expiresAt: NOW + LOGIN_ATTEMPT_TTL_MS,
      status: 'pending',
    })
    await backend.authorizeAttempt(attemptId, {
      providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat',
    })

    const created = await backend.consumeAuthorizedAttempt(attemptId, 'refresh-hash', NOW + MAX_REFRESH_TOKEN_TTL_MS)

    expect(created.session).not.toHaveProperty('presentation')
  })
  it('rejects a backend from another database identity before serving traffic', () => {
    expect(() => new PlatformAccount(new Context(), {
      backend: new MemoryAccountBackend('database-production'),
      invalidation: new MemoryAccountInvalidationBus(),
      github: github(),
      environment: ENVIRONMENT,
      config: CONFIG,
    })).toThrow('database identity does not match')
    expect(() => new MemoryAccountBackend(' ')).toThrow('must be non-empty')
  })

  it('rejects a GitHub adapter selected from another environment before serving traffic', () => {
    const production = selectPlatformEnvironment(validatePlatformEnvironmentPair({
      development: { ...ENVIRONMENT, environment: 'development' },
      production: {
        environment: 'production', origin: 'https://other.example.com',
        callbackUrl: 'https://other.example.com/v1/account/oauth/github/callback',
        githubClientId: 'other-client', credentialReference: 'credentials://other',
        databaseIdentity: 'other-database', identityNamespace: 'other-namespace',
      },
    }), 'production')
    expect(() => new PlatformAccount(new Context(), {
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
      invalidation: new MemoryAccountInvalidationBus(),
      github: { ...github(), environment: production },
      environment: ENVIRONMENT,
      config: CONFIG,
    })).toThrow('GitHub OAuth adapter does not match')
  })

  it('uses one signed five-minute PKCE attempt without requesting a GitHub scope', async () => {
    const provider = github()
    const { first } = accountHarness({ provider })
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('desktop-installation-1'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: key.publicKey,
    })
    const authorization = new URL(attempt.authorizationUrl)
    expect(authorization.searchParams.has('scope')).toBe(false)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(attempt.expiresAt).toBe(NOW + LOGIN_ATTEMPT_TTL_MS)

    await expect(first.completeGitHubCallback({ code: 'github-code', state: attempt.state }))
      .resolves.toEqual({ completed: true })
    expect(provider.exchanges).toHaveLength(1)
    expect(provider.exchanges[0]?.verifier).toHaveLength(64)

    const proof = key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`)
    const session = await first.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof,
    })
    expect(session.status).toBe('complete')
    if (session.status !== 'complete') throw new Error('expected complete login')
    expect(session.account).toMatchObject({ githubId: 13994321, githubLogin: 'octocat' })
    expect(session.accessExpiresAt).toBe(NOW + ACCESS_TOKEN_TTL_MS)
    expect(session.refreshExpiresAt).toBe(NOW + MAX_REFRESH_TOKEN_TTL_MS)
    await expect(first.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_USED' })
  })

  it('rotates refresh tokens and refuses a replayed proof', async () => {
    const { first } = accountHarness()
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('mobile-installation-1'),
      installationKind: 'mobile',
      presentation: { name: 'Authenticated mobile installation', platform: 'ios' },
      publicKey: key.publicKey,
    })
    await first.completeGitHubCallback({ code: 'code', state: attempt.state })
    const login = await first.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })
    if (login.status !== 'complete') throw new Error('expected complete login')

    const binding = hashAccountToken(login.refreshToken)
    const proof = key.proof('refresh', binding)
    const refreshed = await first.refresh({ refreshToken: login.refreshToken, proof })
    expect(refreshed.refreshToken).not.toBe(login.refreshToken)
    await expect(first.refresh({ refreshToken: login.refreshToken, proof: key.proof('refresh', binding) }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const currentProof = key.proof('current', hashAccountToken(refreshed.accessToken))
    await expect(first.current({ accessToken: refreshed.accessToken, proof: currentProof })).resolves.toEqual(refreshed.account)
    await expect(first.current({ accessToken: refreshed.accessToken, proof: currentProof }))
      .rejects.toMatchObject({ code: 'PROOF_REPLAYED' })
    await expect(first.currentInstallation({
      accessToken: refreshed.accessToken,
      proof: key.proof('current', hashAccountToken(refreshed.accessToken)),
    })).resolves.toEqual({
      account: refreshed.account,
      installation: {
        id: 'mobile-installation-1',
        kind: 'mobile',
        presentation: { name: 'Authenticated mobile installation', platform: 'ios' },
      },
    })
  })

  it('revokes a durable Mobile session that predates Installation presentation', async () => {
    const { first, backend } = accountHarness()
    const key = installationKey()
    const { session } = await login(
      first,
      key,
      parseInstallationId('legacy-mobile-installation'),
      'mobile',
    )
    const readSession = backend.getSession.bind(backend)
    vi.spyOn(backend, 'getSession').mockImplementation(async (sessionId) => {
      const legacy = await readSession(sessionId)
      if (legacy !== undefined) delete legacy.presentation
      return legacy
    })

    await expect(first.currentInstallation({
      accessToken: session.accessToken,
      proof: key.proof('current', hashAccountToken(session.accessToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    await expect(readSession(session.sessionId)).resolves.toMatchObject({ active: false })
  })

  it('invalidates and closes only the current installation across instances', async () => {
    const { first, second } = accountHarness()
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('desktop-installation-2'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: key.publicKey,
    })
    await first.completeGitHubCallback({ code: 'code', state: attempt.state })
    const login = await first.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })
    if (login.status !== 'complete') throw new Error('expected complete login')

    const closed = vi.fn()
    await second.trackConnection(login.sessionId, closed)
    await expect(second.current({
      accessToken: login.accessToken,
      proof: key.proof('current', hashAccountToken(login.accessToken)),
    })).resolves.toEqual(login.account)
    await expect(second.currentInstallation({
      accessToken: login.accessToken,
      proof: key.proof('current', hashAccountToken(login.accessToken)),
    })).resolves.toEqual({
      account: login.account,
      installation: {
        id: 'desktop-installation-2', kind: 'desktop',
        presentation: { name: 'Test Desktop', platform: 'linux' },
      },
    })
    await first.signOut({
      accessToken: login.accessToken,
      proof: key.proof('sign-out', hashAccountToken(login.accessToken)),
    })
    expect(closed).toHaveBeenCalledOnce()
    await expect(second.current({
      accessToken: login.accessToken,
      proof: key.proof('current', hashAccountToken(login.accessToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  it('runs every invalidation listener and connection closer before reporting failures', async () => {
    const bus = new MemoryAccountInvalidationBus()
    const sessionId = 'contained-session' as AccountSessionId
    const firstListener = vi.fn(async () => { throw new Error('listener one failed') })
    const secondListener = vi.fn()
    bus.subscribe(firstListener)
    bus.subscribe(secondListener)

    await expect(bus.publish(sessionId)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'listener one failed' })],
    })
    expect(firstListener).toHaveBeenCalledOnce()
    expect(secondListener).toHaveBeenCalledOnce()

    const harness = accountHarness()
    const { key, session } = await login(harness.first)
    const firstClose = vi.fn(async () => { throw new Error('connection one failed') })
    const secondClose = vi.fn()
    await harness.second.trackConnection(session.sessionId, firstClose)
    await harness.second.trackConnection(session.sessionId, secondClose)

    await expect(harness.first.signOut({
      accessToken: session.accessToken,
      proof: key.proof('sign-out', hashAccountToken(session.accessToken)),
    })).rejects.toThrow('connection one failed')
    expect(firstClose).toHaveBeenCalledOnce()
    expect(secondClose).toHaveBeenCalledOnce()
    await expect(harness.first.current({
      accessToken: session.accessToken,
      proof: key.proof('current', hashAccountToken(session.accessToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  it('rejects a callback with the wrong state without contacting GitHub', async () => {
    const provider = github()
    const { first } = accountHarness({ provider })
    const key = installationKey()
    await first.beginLogin({
      installationId: parseInstallationId('desktop-installation-3'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: key.publicKey,
    })
    await expect(first.completeGitHubCallback({ code: 'code', state: 'wrong-state' }))
      .rejects.toMatchObject({ code: 'LOGIN_STATE_INVALID' })
    expect(provider.exchanges).toHaveLength(0)
  })

  it('returns pending before authorization and replaces only the same installation session', async () => {
    const { first, second } = accountHarness()
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('desktop-reused'), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: key.publicKey,
    })
    await expect(first.pollLogin({
      attemptId: attempt.id, pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })).resolves.toEqual({ status: 'pending' })
    await first.completeGitHubCallback({ code: 'code', state: attempt.state })
    const initial = await first.pollLogin({
      attemptId: attempt.id, pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })
    if (initial.status !== 'complete') throw new Error('expected complete login')
    const closed = vi.fn()
    await second.trackConnection(initial.sessionId, closed)

    const replacement = await login(first, key, parseInstallationId('desktop-reused'))
    expect(replacement.session.account.id).toBe(initial.account.id)
    expect(closed).toHaveBeenCalledOnce()
    await expect(first.current({
      accessToken: initial.accessToken,
      proof: key.proof('current', hashAccountToken(initial.accessToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  it('rejects expired callbacks and invalid provider identities', async () => {
    let now = NOW
    const expiring = accountHarness({ clock: { now: () => now } }).first
    const attempt = await expiring.beginLogin({
      installationId: parseInstallationId('desktop-expired'), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: installationKey().publicKey,
    })
    now += LOGIN_ATTEMPT_TTL_MS + 1
    await expect(expiring.completeGitHubCallback({ code: 'code', state: attempt.state }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_EXPIRED' })

    const identities: GitHubIdentity[] = [
      { providerSubject: Number.NaN, login: 'octocat', avatarUrl: 'avatar' },
      { providerSubject: 0, login: 'octocat', avatarUrl: 'avatar' },
      { providerSubject: 1, login: '', avatarUrl: 'avatar' },
      { providerSubject: 1, login: 'octocat', avatarUrl: '' },
    ]
    for (const identity of identities) {
      const provider: GitHubIdentityProvider = {
        environment: ENVIRONMENT,
        authorizationUrl: () => 'https://github.com/login/oauth/authorize',
        exchange: vi.fn().mockResolvedValue(identity),
      }
      const account = accountHarness({ provider }).first
      const next = await account.beginLogin({
        installationId: parseInstallationId(randomUUID()), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: installationKey().publicKey,
      })
      await expect(account.completeGitHubCallback({ code: 'code', state: next.state })).rejects.toThrow()
    }
  })

  it('rejects callback, polling, and refresh at the exact expiry instant', async () => {
    let callbackNow = NOW
    const callbackAccount = accountHarness({ clock: { now: () => callbackNow } }).first
    const callbackAttempt = await callbackAccount.beginLogin({
      installationId: parseInstallationId('callback-boundary'), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: installationKey().publicKey,
    })
    callbackNow = callbackAttempt.expiresAt
    await expect(callbackAccount.completeGitHubCallback({ code: 'code', state: callbackAttempt.state }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_EXPIRED' })

    let pollingNow = NOW
    const pollingAccount = accountHarness({ clock: { now: () => pollingNow } }).first
    const pollingKey = installationKey()
    const pollingAttempt = await pollingAccount.beginLogin({
      installationId: parseInstallationId('poll-boundary'),
      installationKind: 'mobile',
      presentation: { name: 'Poll boundary installation', platform: 'android' },
      publicKey: pollingKey.publicKey,
    })
    await pollingAccount.completeGitHubCallback({ code: 'code', state: pollingAttempt.state })
    pollingNow = pollingAttempt.expiresAt
    await expect(pollingAccount.pollLogin({
      attemptId: pollingAttempt.id,
      pollingToken: pollingAttempt.pollingToken,
      proof: pollingKey.proof(
        'login-poll',
        `${pollingAttempt.id}:${hashAccountToken(pollingAttempt.pollingToken)}`,
        pollingNow,
      ),
    })).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_EXPIRED' })

    let refreshNow = NOW
    const refreshAccount = accountHarness({ clock: { now: () => refreshNow } }).first
    const { key, session } = await login(refreshAccount)
    refreshNow = session.refreshExpiresAt
    await expect(refreshAccount.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', hashAccountToken(session.refreshToken), refreshNow),
    })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('rejects a late refresh before rotation and accepts the last full access-token window', async () => {
    let refreshNow = NOW
    const refreshAccount = accountHarness({ clock: { now: () => refreshNow } }).first
    const { key, session } = await login(refreshAccount)
    const binding = hashAccountToken(session.refreshToken)

    refreshNow = session.refreshExpiresAt - 1
    await expect(refreshAccount.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', binding, refreshNow),
    })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    refreshNow = session.refreshExpiresAt - ACCESS_TOKEN_TTL_MS
    const refreshed = await refreshAccount.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', binding, refreshNow),
    })
    expect(refreshed.accessExpiresAt).toBe(session.refreshExpiresAt)
    expect(refreshed.refreshExpiresAt).toBe(session.refreshExpiresAt)
  })

  it.each([
    { kty: 'RSA', crv: 'P-256', x: 'x', y: 'y' },
    { kty: 'EC', crv: 'P-384', x: 'x', y: 'y' },
    { kty: 'EC', crv: 'P-256', y: 'y' },
    { kty: 'EC', crv: 'P-256', x: 'x' },
    { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' },
  ])('rejects a non-public P-256 installation key %#', async (publicKey) => {
    await expect(accountHarness().first.beginLogin({
      installationId: parseInstallationId('invalid-key'), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey,
    })).rejects.toMatchObject({ code: 'PROOF_INVALID' })
  })

  it.each([
    { tokenSigningKey: Buffer.alloc(31) },
    { pollingSigningKey: Buffer.alloc(31) },
  ])('rejects invalid provider config %#', (override) => {
    expect(() => accountHarness({ config: { ...CONFIG, ...override } })).toThrow()
  })

  it('rejects malformed, invalid, expired, and wrongly bound polling tokens', async () => {
    const { first } = accountHarness()
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('poll-validation'), installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: key.publicKey,
    })
    const proof = () => key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`)
    for (const token of ['encoded-only', 'a.b.c']) {
      await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: token, proof: proof() }))
        .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    }
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: 'a.b', proof: proof() }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const badSignature = tamperEnvelopeSignature(attempt.pollingToken)
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: badSignature, proof: proof() }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const invalidJson = signEncoded(Buffer.from('{').toString('base64url'), CONFIG.pollingSigningKey)
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: invalidJson, proof: proof() }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })

    const wrongAttempt = replaceEnvelope(attempt.pollingToken, CONFIG.pollingSigningKey, (payload) => { payload.attemptId = 'other' })
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: wrongAttempt, proof: proof() }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
    const wrongNamespace = replaceEnvelope(attempt.pollingToken, CONFIG.pollingSigningKey, (payload) => { payload.namespace = 'other' })
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: wrongNamespace, proof: proof() }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
    const expired = replaceEnvelope(attempt.pollingToken, CONFIG.pollingSigningKey, (payload) => { payload.expiresAt = NOW - 1 })
    await expect(first.pollLogin({ attemptId: attempt.id, pollingToken: expired, proof: proof() }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_EXPIRED' })
    const unknown = replaceEnvelope(attempt.pollingToken, CONFIG.pollingSigningKey, (payload) => { payload.attemptId = 'unknown' })
    await expect(first.pollLogin({ attemptId: parseLoginAttemptId('unknown'), pollingToken: unknown, proof: proof() }))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
  })

  it('enforces access-token identity, lifetime, session revision, and account presence', async () => {
    const harness = accountHarness()
    const { key, session } = await login(harness.first)
    const proof = (token: string) => key.proof('current', hashAccountToken(token))
    const expired = replaceEnvelope(session.accessToken, CONFIG.tokenSigningKey, (payload) => { payload.expiresAt = NOW - 1 })
    await expect(harness.first.current({ accessToken: expired, proof: proof(expired) }))
      .rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    const wrongNamespace = replaceEnvelope(session.accessToken, CONFIG.tokenSigningKey, (payload) => { payload.namespace = 'other' })
    await expect(harness.first.current({ accessToken: wrongNamespace, proof: proof(wrongNamespace) }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const unknownSession = replaceEnvelope(session.accessToken, CONFIG.tokenSigningKey, (payload) => { payload.sessionId = 'unknown' })
    await expect(harness.first.current({ accessToken: unknownSession, proof: proof(unknownSession) }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const wrongRevision = replaceEnvelope(session.accessToken, CONFIG.tokenSigningKey, (payload) => { payload.revision = 99 })
    await expect(harness.first.current({ accessToken: wrongRevision, proof: proof(wrongRevision) }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })

    const missingAccount = accountHarness({
      backend: proxyBackend(harness.backend, { getAccount: async () => undefined }),
      invalidation: harness.invalidation,
    }).first
    await expect(missingAccount.current({ accessToken: session.accessToken, proof: proof(session.accessToken) }))
      .rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  it('enforces proof time, signature, refresh lifetime, and atomic rotation', async () => {
    let now = NOW
    const harness = accountHarness({ clock: { now: () => now } })
    const { key, session } = await login(harness.first)
    const currentBinding = hashAccountToken(session.accessToken)
    await expect(harness.first.current({
      accessToken: session.accessToken,
      proof: key.proof('current', currentBinding, Number.NaN),
    })).rejects.toMatchObject({ code: 'PROOF_INVALID' })
    await expect(harness.first.current({
      accessToken: session.accessToken,
      proof: key.proof('current', currentBinding, NOW - ACCOUNT_PROOF_WINDOW_MS - 1),
    })).rejects.toMatchObject({ code: 'PROOF_INVALID' })
    await expect(harness.first.current({
      accessToken: session.accessToken,
      proof: { jti: parseAccountProofJti(randomUUID()), issuedAt: NOW, signature: 'invalid' },
    })).rejects.toMatchObject({ code: 'PROOF_INVALID' })

    const record = await harness.backend.getSession(session.sessionId)
    if (record === undefined) throw new Error('expected session record')
    const inactive = accountHarness({
      backend: proxyBackend(harness.backend, { getSessionByRefreshHash: async () => ({ ...record, active: false }) }),
      invalidation: harness.invalidation,
      clock: { now: () => now },
    }).first
    await expect(inactive.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', hashAccountToken(session.refreshToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })

    const failedRotation = accountHarness({
      backend: proxyBackend(harness.backend, { rotateRefresh: async () => undefined }),
      invalidation: harness.invalidation,
      clock: { now: () => now },
    }).first
    await expect(failedRotation.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', hashAccountToken(session.refreshToken)),
    })).rejects.toMatchObject({ code: 'SESSION_REVOKED' })

    now = NOW + MAX_REFRESH_TOKEN_TTL_MS + 1
    await expect(harness.first.refresh({
      refreshToken: session.refreshToken,
      proof: key.proof('refresh', hashAccountToken(session.refreshToken), now),
    })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('handles backend compare-and-mutate failures, proof pruning, and bus disposal', async () => {
    const backend = new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
    const missingAttempt = 'missing-attempt' as LoginAttemptId
    const missingSession = 'missing-session' as AccountSessionId
    const missingAccount = 'missing-account' as PlatformAccountId
    await expect(backend.authorizeAttempt(missingAttempt, {
      providerSubject: 1, login: 'octocat', avatarUrl: 'avatar',
    })).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_USED' })
    await expect(backend.consumeAuthorizedAttempt(missingAttempt, 'refresh', NOW))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
    expect(await backend.getAttempt(missingAttempt)).toBeUndefined()
    expect(await backend.getSession(missingSession)).toBeUndefined()
    expect(await backend.getSessionByRefreshHash('missing')).toBeUndefined()
    expect(await backend.getAccount(missingAccount)).toBeUndefined()
    expect(await backend.rotateRefresh(missingSession, 'old', 'new')).toBeUndefined()
    expect(await backend.revokeSession(missingSession)).toBe(false)

    const key = installationKey()
    await backend.createAttempt({
      id: 'attempt' as LoginAttemptId,
      environment: 'development', identityNamespace: 'namespace', installationId: parseInstallationId('installation'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: key.publicKey, state: 'state', codeVerifier: 'verifier',
      expiresAt: NOW, status: 'pending',
    })
    expect(await backend.findAttemptByState('state')).toMatchObject({ status: 'pending' })
    await expect(backend.consumeAuthorizedAttempt('attempt' as LoginAttemptId, 'refresh', NOW))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
    await backend.authorizeAttempt('attempt' as LoginAttemptId, {
      providerSubject: 1, login: 'octocat', avatarUrl: 'avatar',
    })
    await expect(backend.authorizeAttempt('attempt' as LoginAttemptId, {
      providerSubject: 1, login: 'octocat', avatarUrl: 'avatar',
    })).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_USED' })
    const created = await backend.consumeAuthorizedAttempt('attempt' as LoginAttemptId, 'refresh', NOW)
    await expect(backend.consumeAuthorizedAttempt('attempt' as LoginAttemptId, 'refresh-2', NOW))
      .rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_USED' })
    expect(await backend.rotateRefresh(created.session.id, 'wrong', 'new')).toBeUndefined()
    expect(await backend.revokeSession(created.session.id)).toBe(true)
    expect(await backend.revokeSession(created.session.id)).toBe(false)
    expect(await backend.rotateRefresh(created.session.id, 'refresh', 'new')).toBeUndefined()
    await backend.createAttempt({
      id: 'replacement' as LoginAttemptId,
      environment: 'development', identityNamespace: 'namespace', installationId: parseInstallationId('installation'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: key.publicKey, state: 'replacement-state', codeVerifier: 'verifier',
      expiresAt: NOW, status: 'pending',
    })
    await backend.authorizeAttempt('replacement' as LoginAttemptId, {
      providerSubject: 1, login: 'octocat', avatarUrl: 'avatar',
    })
    await backend.consumeAuthorizedAttempt('replacement' as LoginAttemptId, 'replacement-refresh', NOW)
    expect(await backend.consumeProof(parseAccountProofJti('expired'), 1, 0)).toBe(true)
    expect(await backend.consumeProof(parseAccountProofJti('current'), 3, 2)).toBe(true)
    expect(await backend.consumeProof(parseAccountProofJti('current'), 3, 2)).toBe(false)

    const bus = new MemoryAccountInvalidationBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    await bus.publish(created.session.id)
    unsubscribe()
    await bus.publish(created.session.id)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('disposes connection subscriptions and avoids publishing an uncommitted revocation', async () => {
    const harness = accountHarness()
    const { key, session } = await login(harness.first)
    const firstClose = vi.fn()
    const secondClose = vi.fn()
    const disposeFirst = await harness.first.trackConnection(session.sessionId, firstClose)
    const disposeSecond = await harness.first.trackConnection(session.sessionId, secondClose)
    disposeFirst()
    disposeSecond()
    disposeSecond()
    await harness.invalidation.publish('unknown' as AccountSessionId)

    await harness.first.trackConnection(session.sessionId, firstClose)
    await harness.first.dispose()
    expect(firstClose).toHaveBeenCalledOnce()

    const publish = vi.spyOn(harness.invalidation, 'publish')
    const noRevoke = accountHarness({
      backend: proxyBackend(harness.backend, { revokeSession: async () => false }),
      invalidation: harness.invalidation,
    }).first
    await noRevoke.signOut({
      accessToken: session.accessToken,
      proof: key.proof('sign-out', hashAccountToken(session.accessToken)),
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('contains every connection failure during disposal and reports non-Error failures', async () => {
    const harness = accountHarness()
    const first = vi.fn(async () => { throw 'first close failed' })
    const second = vi.fn(async () => { throw new Error('second close failed') })
    const firstLogin = await login(harness.first, installationKey(), parseInstallationId('dispose-a'))
    const secondLogin = await login(harness.first, installationKey(), parseInstallationId('dispose-b'))
    await harness.first.trackConnection(firstLogin.session.sessionId, first)
    await harness.first.trackConnection(secondLogin.session.sessionId, second)

    await expect(harness.first.dispose()).rejects.toThrow('first close failed')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('uses the system clock and disposes through the Cordis effect', async () => {
    const ctx = new Context()
    new PlatformAccount(ctx, {
      backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity), invalidation: new MemoryAccountInvalidationBus(),
      github: github(), environment: ENVIRONMENT, config: CONFIG,
    })
    await ctx.fiber.dispose()
  })

  it('accepts the tenth Desktop and Mobile installation and rejects the eleventh with retry timing', async () => {
    const { first } = accountHarness()
    for (let index = 0; index < ACCOUNT_DESKTOP_INSTALLATION_LIMIT; index += 1) {
      await login(first, installationKey(), parseInstallationId(`desktop-${String(index)}`))
    }
    await expect(login(first, installationKey(), parseInstallationId('desktop-over')))
      .rejects.toMatchObject({
        code: 'QUOTA',
        retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
      })
    await login(first, installationKey(), parseInstallationId('desktop-0'))
    for (let index = 0; index < ACCOUNT_MOBILE_INSTALLATION_LIMIT; index += 1) {
      await login(first, installationKey(), parseInstallationId(`mobile-${String(index)}`), 'mobile')
    }
    await expect(login(first, installationKey(), parseInstallationId('mobile-over'), 'mobile'))
      .rejects.toMatchObject({
        code: 'QUOTA',
        retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
      })
  })

  it('rejects a concurrent eleventh Desktop installation while the tenth completes', async () => {
    const { first, second } = accountHarness()
    for (let index = 0; index < ACCOUNT_DESKTOP_INSTALLATION_LIMIT - 1; index += 1) {
      await login(first, installationKey(), parseInstallationId(`desktop-${String(index)}`))
    }
    const results = await Promise.allSettled([
      login(first, installationKey(), parseInstallationId('desktop-tenth')),
      login(second, installationKey(), parseInstallationId('desktop-eleventh')),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
  })

  it('accepts twenty tracked connections and rejects the next while leaving established closers registered', async () => {
    const { first } = accountHarness()
    const { session } = await login(first)
    const established = vi.fn()
    const stop = await first.trackConnection(session.sessionId, established)
    for (let index = 1; index < ACCOUNT_CONCURRENT_CONNECTION_LIMIT; index += 1) {
      await first.trackConnection(session.sessionId, vi.fn())
    }
    expect(established).not.toHaveBeenCalled()
    await expect(first.trackConnection(session.sessionId, vi.fn())).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
    stop()
    expect(established).not.toHaveBeenCalled()
    await first.trackConnection(session.sessionId, vi.fn())
  })

  it('sheds new login at capacity and leaves an established session usable', async () => {
    const capacity = { shedding: false, retryAfterSeconds: 45 }
    const { first } = accountHarness({ capacity })
    const { key, session } = await login(first)
    capacity.shedding = true
    await expect(first.beginLogin({
      installationId: parseInstallationId('capacity-desktop'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: installationKey().publicKey,
    })).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfter: 45 })
    expect(await first.current({
      accessToken: session.accessToken,
      proof: key.proof('current', hashAccountToken(session.accessToken)),
    })).toMatchObject({ githubLogin: 'octocat' })
  })

  it('registers a second GitHub identity with no account-count ceiling', async () => {
    let subject = 13994321
    const provider = github()
    provider.exchange = async (code, verifier) => {
      provider.exchanges.push({ code, verifier })
      return subject === 13994321
        ? { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
        : { providerSubject: subject, login: 'second', avatarUrl: 'https://avatars.example/second' }
    }
    const { first } = accountHarness({ provider })
    const firstLogin = await login(first)
    expect(firstLogin.session.account.githubLogin).toBe('octocat')
    subject = 7
    const secondLogin = await login(first, installationKey(), parseInstallationId('second-desktop'))
    expect(secondLogin.session.account).toMatchObject({ githubId: 7, githubLogin: 'second' })
    expect(secondLogin.session.account.id).not.toBe(firstLogin.session.account.id)
  })

  it('counts only the owning Account when other sessions are already tracked', async () => {
    let subject = 13994321
    const provider = github()
    provider.exchange = async (code, verifier) => {
      provider.exchanges.push({ code, verifier })
      return subject === 13994321
        ? { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' }
        : { providerSubject: subject, login: 'second', avatarUrl: 'https://avatars.example/second' }
    }
    const { first } = accountHarness({ provider })
    const firstLogin = await login(first)
    subject = 7
    const secondLogin = await login(first, installationKey(), parseInstallationId('second-desktop'))
    await first.trackConnection(firstLogin.session.sessionId, vi.fn())
    await first.trackConnection(secondLogin.session.sessionId, vi.fn())
    for (let index = 1; index < ACCOUNT_CONCURRENT_CONNECTION_LIMIT; index += 1) {
      await first.trackConnection(firstLogin.session.sessionId, vi.fn())
    }
    await expect(first.trackConnection(firstLogin.session.sessionId, vi.fn())).rejects.toMatchObject({
      code: 'QUOTA',
    })
    await first.trackConnection(secondLogin.session.sessionId, vi.fn())
  })

  it('resolves an unbound session through the Account backend before enforcing the connection ceiling', async () => {
    const { first, second } = accountHarness()
    const { session } = await login(first)
    await second.trackConnection(session.sessionId, vi.fn())
    for (let index = 1; index < ACCOUNT_CONCURRENT_CONNECTION_LIMIT; index += 1) {
      await second.trackConnection(session.sessionId, vi.fn())
    }
    await expect(second.trackConnection(session.sessionId, vi.fn())).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: OPEN_REGISTRATION_HARD_CAP_RETRY_AFTER_SECONDS,
    })
    await expect(second.trackConnection('missing' as AccountSessionId, vi.fn())).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    })
  })

  it('treats a missing indexed session as inactive when counting a replacement Installation', async () => {
    const backend = new MemoryAccountBackend(ENVIRONMENT.databaseIdentity)
    const internals = backend as unknown as { installationIndex: Map<string, string> }
    internals.installationIndex.set(`${ENVIRONMENT.identityNamespace}:ghost`, 'missing-session')
    expect(await backend.hasActiveSessionByInstallation(
      ENVIRONMENT.identityNamespace,
      parseInstallationId('ghost'),
    )).toBe(false)
  })

  it('skips installation quota when an authorized attempt has not bound a GitHub identity', async () => {
    const harness = accountHarness()
    const key = installationKey()
    const attempt = await harness.first.beginLogin({
      installationId: parseInstallationId('identity-less'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: key.publicKey,
    })
    await harness.first.completeGitHubCallback({ code: 'code', state: attempt.state })
    const proxied = accountHarness({
      backend: proxyBackend(harness.backend, {
        async getAttempt(id) {
          const record = await harness.backend.getAttempt(id)
          if (record === undefined) return undefined
          const { identity: _identity, ...rest } = record
          return { ...rest, status: 'authorized' }
        },
        consumeAuthorizedAttempt: async () => {
          throw new AccountError('LOGIN_ATTEMPT_INVALID', 'login attempt is not authorized')
        },
      }),
    }).first
    await expect(proxied.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })).rejects.toMatchObject({ code: 'LOGIN_ATTEMPT_INVALID' })
  })

  it('sheds a completing login at capacity after GitHub authorization', async () => {
    const capacity = { shedding: false, retryAfterSeconds: 12 }
    const { first } = accountHarness({ capacity })
    const key = installationKey()
    const attempt = await first.beginLogin({
      installationId: parseInstallationId('capacity-poll'),
      installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
      publicKey: key.publicKey,
    })
    await first.completeGitHubCallback({ code: 'code', state: attempt.state })
    capacity.shedding = true
    await expect(first.pollLogin({
      attemptId: attempt.id,
      pollingToken: attempt.pollingToken,
      proof: key.proof('login-poll', `${attempt.id}:${hashAccountToken(attempt.pollingToken)}`),
    })).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfter: 12 })
  })
})
