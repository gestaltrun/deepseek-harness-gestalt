import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AccountError,
  parseInstallationId,
  parseAccountProofJti,
  parseLoginAttemptId,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountSessionView,
  type LoginAttemptView,
  type SelectedPlatformEnvironment,
} from '@deepseek-ai/dsh-platform-account'
import {
  ACCOUNT_PRIVACY_NOTICE,
  AccountLifecycleClosedError,
  AccountLifecycleTransitions,
  IndexedDbInstallationAccountStore,
  MemoryInstallationAccountStore,
  PlatformAccountHttpTransport,
  PlatformAccountInstallation,
  accountStorageNamespace,
  type PlatformAccountTransport,
} from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

const PAIR = validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://dev.example',
    callbackUrl: 'https://dev.example/v1/account/oauth/github/callback',
    githubClientId: 'client-development', credentialReference: 'credentials://development',
    databaseIdentity: 'database-development', identityNamespace: 'namespace-development',
  },
  production: {
    environment: 'production', origin: 'https://prod.example',
    callbackUrl: 'https://prod.example/v1/account/oauth/github/callback',
    githubClientId: 'client-production', credentialReference: 'credentials://production',
    databaseIdentity: 'database-production', identityNamespace: 'namespace-production',
  },
})
const DEVELOPMENT = selectPlatformEnvironment(PAIR, 'development')
const PRODUCTION = selectPlatformEnvironment(PAIR, 'production')

const ATTEMPT: LoginAttemptView = {
  id: 'attempt-1' as never,
  state: 'state-1',
  authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=client&state=state-1',
  pollingToken: 'polling-token',
  expiresAt: Date.now() + 300_000,
}

function session(accountId: string, login: string, accessExpiresAt = Date.now() + 900_000): AccountSessionView {
  return {
    sessionId: `session-${accountId}` as never,
    account: {
      id: accountId as never,
      githubId: accountId === 'account-a' ? 1 : 2,
      githubLogin: login,
      avatarUrl: `https://avatars.example/${login}`,
    },
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    accessExpiresAt,
    refreshExpiresAt: Date.now() + 2_592_000_000,
  }
}

interface MockTransport {
  environment: SelectedPlatformEnvironment
  beginLogin: Mock<PlatformAccountTransport['beginLogin']>
  pollLogin: Mock<PlatformAccountTransport['pollLogin']>
  refresh: Mock<PlatformAccountTransport['refresh']>
  current: Mock<PlatformAccountTransport['current']>
  signOut: Mock<PlatformAccountTransport['signOut']>
}

function transport(
  results: AccountSessionView[],
  environment: SelectedPlatformEnvironment = DEVELOPMENT,
): MockTransport {
  return {
    environment,
    beginLogin: vi.fn<PlatformAccountTransport['beginLogin']>().mockResolvedValue(ATTEMPT),
    pollLogin: vi.fn<PlatformAccountTransport['pollLogin']>()
      .mockImplementation(async () => ({ status: 'complete', ...results.shift()! })),
    refresh: vi.fn<PlatformAccountTransport['refresh']>(),
    current: vi.fn<PlatformAccountTransport['current']>(),
    signOut: vi.fn<PlatformAccountTransport['signOut']>().mockResolvedValue(undefined),
  }
}

describe('PlatformAccountInstallation', () => {
  it('contains a throwing subscriber and still notifies later subscribers', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('subscriber-containment'),
      installationKind: 'mobile',
      transport: transport([]),
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    const later = vi.fn()
    installation.subscribe(() => { throw new Error('first subscriber failed') })
    installation.subscribe(later)

    expect(() => { installation.acceptPrivacy() }).not.toThrow()

    expect(later).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledWith(
      '[platform-account-client] subscriber failures:',
      expect.any(AggregateError),
    )
  })

  it('rejects a transport from another environment and an unprepared browser open', () => {
    expect(() => new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('mismatch'),
      installationKind: 'mobile',
      transport: transport([], PRODUCTION),
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })).toThrow('transport does not match')
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('unprepared'),
      installationKind: 'mobile',
      transport: transport([]),
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    expect(() => { installation.openLogin() }).toThrow('not prepared')
  })

  it('keeps a fresh installation idle when no stored session exists', async () => {
    const api = transport([])
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('desktop-fresh'),
      installationKind: 'desktop',
      transport: api,
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })

    await installation.load()

    expect(installation.getSnapshot()).toEqual({ status: 'idle', privacyAccepted: false })
    expect(api.current).not.toHaveBeenCalled()
    expect(api.refresh).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'mobile'] as const)('shows bilingual privacy before %s authorization', async (kind) => {
    const openSystemBrowser = vi.fn()
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId(`${kind}-1`),
      installationKind: kind,
      transport: transport([session('account-a', 'octocat')]),
      store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: openSystemBrowser },
      crypto: webcrypto as Crypto,
    })
    expect(installation.getSnapshot().privacyAccepted).toBe(false)
    await expect(installation.beginLogin()).rejects.toThrow('privacy notice must be accepted')
    installation.acceptPrivacy()
    await installation.beginLogin()
    expect(openSystemBrowser).toHaveBeenCalledWith(ATTEMPT.authorizationUrl)
  })

  it('keeps account-specific material namespaces separate when an installation switches accounts', async () => {
    const store = new MemoryInstallationAccountStore()
    const installation = new PlatformAccountInstallation({
      environment: PRODUCTION,
      installationId: parseInstallationId('mobile-2'),
      installationKind: 'mobile',
      transport: transport([session('account-a', 'octocat'), session('account-b', 'hubot')], PRODUCTION),
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await installation.beginLogin()
    await installation.pollLogin()
    store.setAccountMaterial('account-a', 'pairing-key', 'a-only')
    store.setAccountMaterial('account-a', 'receipt', 'a-receipt')

    await installation.beginLogin()
    await installation.pollLogin()
    expect(installation.getSnapshot().account?.id).toBe('account-b')
    expect(store.getAccountMaterial('account-b', 'pairing-key')).toBeUndefined()
    expect(store.getAccountMaterial('account-a', 'pairing-key')).toBe('a-only')
    expect(accountStorageNamespace('production', 'account-a' as never))
      .not.toBe(accountStorageNamespace('production', 'account-b' as never))
  })

  it('signs out the current installation while preserving account-scoped material', async () => {
    const store = new MemoryInstallationAccountStore()
    const api = transport([session('account-a', 'octocat')])
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('desktop-2'),
      installationKind: 'desktop',
      transport: api,
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await installation.beginLogin()
    await installation.pollLogin()
    store.setAccountMaterial('account-a', 'personal-pairing', 'preserved')
    await installation.signOut()
    expect(installation.getSnapshot().account).toBeUndefined()
    expect(store.getAccountMaterial('account-a', 'personal-pairing')).toBe('preserved')
    expect(api.signOut).toHaveBeenCalledOnce()
  })

  it('creates a fresh current-Installation proof for signed-in service consumers', async () => {
    const store = new MemoryInstallationAccountStore()
    const api = transport([session('account-a', 'octocat')])
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('mobile-authority'),
      installationKind: 'mobile',
      transport: api,
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await installation.beginLogin()
    await installation.pollLogin()

    const authorization = await installation.authorizeCurrentInstallation()

    expect(authorization.accessToken).toBe((await store.loadSession('development'))?.session.accessToken)
    expect(authorization.proof.signature).not.toBe('')
    expect(authorization.proof.jti).not.toBe('')
  })

  it('rejects absent or expired authority and refreshes an expired access token', async () => {
    const emptyStore = new MemoryInstallationAccountStore()
    const api = transport([])
    const missing = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('missing-authority'),
      installationKind: 'mobile',
      transport: api,
      store: emptyStore,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })
    await expect(missing.authorizeCurrentInstallation()).rejects.toMatchObject({ code: 'SESSION_REVOKED' })

    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    const expiredStore = new MemoryInstallationAccountStore()
    await expiredStore.saveSession({
      environment: 'development',
      privateKey: pair.privateKey,
      session: { ...session('account-a', 'octocat', 900), refreshExpiresAt: 999 },
    })
    const expired = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('expired-authority'),
      installationKind: 'desktop',
      transport: api,
      store: expiredStore,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })
    await expect(expired.authorizeCurrentInstallation()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(await expiredStore.loadSession('development')).toBeUndefined()

    const refreshingStore = new MemoryInstallationAccountStore()
    await refreshingStore.saveSession({
      environment: 'development',
      privateKey: pair.privateKey,
      session: { ...session('account-a', 'octocat', 999), refreshExpiresAt: 2_000 },
    })
    const replacement = { ...session('account-a', 'octocat', 2_000), refreshExpiresAt: 3_000 }
    vi.mocked(api.refresh).mockResolvedValue(replacement)
    const refreshing = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('refresh-authority'),
      installationKind: 'desktop',
      transport: api,
      store: refreshingStore,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })
    const authorization = await refreshing.authorizeCurrentInstallation()
    expect(authorization.accessToken).toBe(replacement.accessToken)
    expect(api.refresh).toHaveBeenCalledOnce()
    expect((await refreshingStore.loadSession('development'))?.session).toEqual(replacement)
  })

  it('confirms a restored unexpired session with Platform before publishing the account', async () => {
    const store = new MemoryInstallationAccountStore()
    const restored = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: restored, privateKey: pair.privateKey })
    const api = transport([])
    vi.mocked(api.current).mockResolvedValue(restored.account)
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('desktop-restored'),
      installationKind: 'desktop',
      transport: api,
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })

    await installation.load()

    expect(api.current).toHaveBeenCalledOnce()
    expect(installation.getSnapshot().account).toEqual(restored.account)
  })

  it('resumes a still-valid pending login as polling when no session exists', async () => {
    const store = new MemoryInstallationAccountStore()
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    await store.savePending('development', {
      attempt: { ...ATTEMPT, expiresAt: 2_000 },
      privateKey: pair.privateKey,
    })
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('pending-resume'),
      installationKind: 'mobile',
      transport: transport([]),
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })

    await installation.load()

    expect(installation.getSnapshot()).toMatchObject({ status: 'polling', privacyAccepted: true })
    expect(await store.loadPending('development')).toMatchObject({ attempt: { expiresAt: 2_000 } })
  })

  it('clears an expired pending login without publishing polling', async () => {
    const store = new MemoryInstallationAccountStore()
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    await store.savePending('development', {
      attempt: { ...ATTEMPT, expiresAt: 999 },
      privateKey: pair.privateKey,
    })
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('pending-expired'),
      installationKind: 'mobile',
      transport: transport([]),
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })

    await installation.load()

    expect(installation.getSnapshot().status).toBe('idle')
    expect(await store.loadPending('development')).toBeUndefined()
  })

  it('rotates an expired access token during restoration and persists the replacement', async () => {
    const store = new MemoryInstallationAccountStore()
    const expired = session('account-a', 'octocat', 999)
    const replacement = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'production', session: expired, privateKey: pair.privateKey })
    const api = transport([])
    vi.mocked(api.refresh).mockResolvedValue(replacement)
    const installation = new PlatformAccountInstallation({
      environment: PRODUCTION,
      installationId: parseInstallationId('mobile-restored'),
      installationKind: 'mobile',
      transport: Object.assign(api, { environment: PRODUCTION }),
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })

    await installation.load()

    expect(api.refresh).toHaveBeenCalledOnce()
    expect((await store.loadSession('production'))?.session).toEqual(replacement)
    expect(installation.getSnapshot().account).toEqual(replacement.account)
  })

  it('clears local authorization when Platform reports the session was revoked', async () => {
    const store = new MemoryInstallationAccountStore()
    const restored = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: restored, privateKey: pair.privateKey })
    const api = transport([])
    vi.mocked(api.current).mockRejectedValue(new AccountError('SESSION_REVOKED', 'Account Session is revoked'))
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT,
      installationId: parseInstallationId('desktop-revoked'),
      installationKind: 'desktop',
      transport: api,
      store,
      systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
      now: () => 1_000,
    })

    await installation.load()

    expect(await store.loadSession('development')).toBeUndefined()
    expect(installation.getSnapshot().status).toBe('idle')
  })

  it('handles pending, missing, failed, and terminal installation operations', async () => {
    const store = new MemoryInstallationAccountStore()
    const api = transport([session('account-a', 'octocat')])
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('mobile-errors'), installationKind: 'mobile',
      transport: api, store, systemBrowser: { open: vi.fn() }, crypto: webcrypto as Crypto,
    })
    await expect(installation.pollLogin()).rejects.toThrow('no login attempt')
    await expect(installation.signOut()).resolves.toBeUndefined()

    installation.acceptPrivacy()
    await installation.beginLogin()
    vi.mocked(api.pollLogin).mockResolvedValueOnce({ status: 'pending' })
    await expect(installation.pollLogin()).resolves.toEqual({ status: 'pending' })
    vi.mocked(api.pollLogin).mockRejectedValueOnce('poll failed')
    await expect(installation.pollLogin()).rejects.toBe('poll failed')
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', error: 'poll failed' })
    installation.acceptPrivacy()
    await installation.pollLogin()

    vi.mocked(api.signOut).mockRejectedValueOnce(new AccountError('SESSION_EXPIRED', 'expired'))
    await installation.signOut()
    expect(installation.getSnapshot().status).toBe('idle')
  })

  it('publishes non-terminal load and sign-out failures and removes subscribers', async () => {
    const store = new MemoryInstallationAccountStore()
    const restored = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: restored, privateKey: pair.privateKey })
    const api = transport([])
    vi.mocked(api.current).mockRejectedValueOnce(new Error('network unavailable'))
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('desktop-failure'), installationKind: 'desktop',
      transport: api, store, systemBrowser: { open: vi.fn() }, crypto: webcrypto as Crypto, now: () => 1_000,
    })
    const listener = vi.fn()
    const dispose = installation.subscribe(listener)
    await installation.load()
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', error: 'network unavailable' })
    dispose()
    installation.acceptPrivacy()
    expect(listener).toHaveBeenCalledOnce()

    vi.mocked(api.signOut).mockRejectedValueOnce(new Error('sign-out unavailable'))
    await expect(installation.signOut()).rejects.toThrow('sign-out unavailable')
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', error: 'sign-out unavailable' })
  })

  it('clears an expired refresh lifetime and uses default runtime adapters', async () => {
    const store = new MemoryInstallationAccountStore()
    const expired = session('account-a', 'octocat')
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: { ...expired, refreshExpiresAt: 1 }, privateKey: pair.privateKey })
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('desktop-defaults'), installationKind: 'desktop',
      transport: transport([]), store, systemBrowser: { open: vi.fn() },
    })
    await installation.load()
    expect(await store.loadSession('development')).toBeUndefined()
  })

  it('publishes authorization failures and keeps their message out of the next consent snapshot', async () => {
    const api = transport([])
    vi.mocked(api.beginLogin).mockRejectedValueOnce(new Error('login unavailable'))
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('desktop-login-error'), installationKind: 'desktop',
      transport: api, store: new MemoryInstallationAccountStore(), systemBrowser: { open: vi.fn() },
      crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await expect(installation.beginLogin()).rejects.toThrow('login unavailable')
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', error: 'login unavailable' })
    installation.acceptPrivacy()
    expect(installation.getSnapshot().error).toBeUndefined()
  })

  it('publishes an asynchronous native browser failure after direct invocation', async () => {
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('browser-failure'), installationKind: 'mobile',
      transport: transport([]), store: new MemoryInstallationAccountStore(),
      systemBrowser: { open: vi.fn(async () => { throw new Error('native browser failed') }) },
      crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await installation.prepareLogin()
    installation.openLogin()
    await vi.waitFor(() => {
      expect(installation.getSnapshot()).toMatchObject({ status: 'failed', error: 'native browser failed' })
    })
  })

  it('retains the signed-in account on non-terminal sign-out failure', async () => {
    const store = new MemoryInstallationAccountStore()
    const api = transport([session('account-a', 'octocat')])
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('desktop-signout-error'), installationKind: 'desktop',
      transport: api, store, systemBrowser: { open: vi.fn() }, crypto: webcrypto as Crypto,
    })
    installation.acceptPrivacy()
    await installation.beginLogin()
    await installation.pollLogin()
    vi.mocked(api.signOut).mockRejectedValueOnce('sign-out failed')
    await expect(installation.signOut()).rejects.toBe('sign-out failed')
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', account: { githubLogin: 'octocat' } })
    installation.acceptPrivacy()
    expect(installation.getSnapshot()).toMatchObject({ status: 'failed', account: { githubLogin: 'octocat' } })
  })

  it('serializes StrictMode double load so a stale refresh cannot clear the replacement', async () => {
    const store = new MemoryInstallationAccountStore()
    const expired = session('account-a', 'octocat', 999)
    const replacement = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: expired, privateKey: pair.privateKey })
    const api = transport([])
    const refresh = deferred<AccountSessionView>()
    vi.mocked(api.refresh).mockImplementation(async () => refresh.promise)
    vi.mocked(api.current).mockResolvedValue(replacement.account)
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('strict-mode'), installationKind: 'mobile',
      transport: api, store, systemBrowser: { open: vi.fn() }, crypto: webcrypto as Crypto, now: () => 1_000,
    })

    const first = installation.load()
    const second = installation.load()
    await vi.waitFor(() => { expect(api.refresh).toHaveBeenCalledOnce() })
    refresh.resolve(replacement)
    await Promise.all([first, second])

    expect(api.refresh).toHaveBeenCalledOnce()
    expect(api.current).toHaveBeenCalledOnce()
    expect((await store.loadSession('development'))?.session).toEqual(replacement)
  })

  it('orders refresh before concurrent sign-out so no refreshed session is resurrected', async () => {
    const store = new MemoryInstallationAccountStore()
    const expired = session('account-a', 'octocat', 999)
    const replacement = session('account-a', 'octocat', 2_000)
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    await store.saveSession({ environment: 'development', session: expired, privateKey: pair.privateKey })
    const api = transport([])
    const refresh = deferred<AccountSessionView>()
    vi.mocked(api.refresh).mockImplementation(async () => refresh.promise)
    const installation = new PlatformAccountInstallation({
      environment: DEVELOPMENT, installationId: parseInstallationId('refresh-signout'), installationKind: 'desktop',
      transport: api, store, systemBrowser: { open: vi.fn() }, crypto: webcrypto as Crypto, now: () => 1_000,
    })

    const loading = installation.load()
    const signingOut = installation.signOut()
    await vi.waitFor(() => { expect(api.refresh).toHaveBeenCalledOnce() })
    refresh.resolve(replacement)
    await Promise.all([loading, signingOut])

    expect(api.signOut).toHaveBeenCalledWith(expect.objectContaining({ accessToken: replacement.accessToken }))
    expect(await store.loadSession('development')).toBeUndefined()
    expect(installation.getSnapshot().status).toBe('idle')
  })
})

describe('AccountLifecycleTransitions', () => {
  it('drains admitted work and rejects transitions after close', async () => {
    const transition = deferred<undefined>()
    const transitions = new AccountLifecycleTransitions()
    const running = transitions.run(async () => transition.promise)
    let closed = false
    const closing = transitions.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(transitions.run(async () => undefined)).rejects.toBeInstanceOf(AccountLifecycleClosedError)
    transition.resolve(undefined)
    await Promise.all([running, closing])
  })
})

describe('PlatformAccountHttpTransport', () => {
  const proof = { jti: parseAccountProofJti('proof'), issuedAt: 123, signature: 'signature' }

  it('keeps the default Fetch implementation callable after method extraction', async () => {
    const impl = {
      async fetch(this: unknown) {
        if (this == null) throw new TypeError('Illegal invocation')
        return new Response(JSON.stringify(ATTEMPT), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
    vi.stubGlobal('fetch', impl.fetch.bind(impl))
    const transport = new PlatformAccountHttpTransport({ environment: DEVELOPMENT })
    await expect(transport.beginLogin({
      installationId: parseInstallationId('mobile-1'),
      installationKind: 'mobile',
      publicKey: {},
    })).resolves.toEqual(ATTEMPT)
  })

  it('routes every operation to the selected environment with JSON and proof headers', async () => {
    const calls: Array<[string, RequestInit]> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      calls.push([address, init ?? {}])
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      const value = address.endsWith('/login-attempts')
        ? ATTEMPT
        : address.endsWith('/login-poll')
          ? { status: 'pending' }
          : address.endsWith('/refresh')
            ? session('account-a', 'octocat')
            : session('account-a', 'octocat').account
      return new Response(JSON.stringify(value), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    const transport = new PlatformAccountHttpTransport({
      environment: PRODUCTION,
      fetch,
    })
    await transport.beginLogin({ installationId: parseInstallationId('mobile-1'), installationKind: 'mobile', publicKey: {} })
    await transport.pollLogin({ attemptId: parseLoginAttemptId('attempt'), pollingToken: 'poll', proof })
    await transport.refresh({ refreshToken: 'refresh', proof })
    await transport.current({ accessToken: 'access', proof })
    await transport.signOut({ accessToken: 'access', proof })

    expect(calls.map(([url]) => url)).toEqual([
      'https://prod.example/v1/account/login-attempts',
      'https://prod.example/v1/account/login-poll',
      'https://prod.example/v1/account/session/refresh',
      'https://prod.example/v1/account/session',
      'https://prod.example/v1/account/session',
    ])
    expect(new Headers(calls[0]?.[1].headers).get('content-type')).toBe('application/json')
    expect(new Headers(calls[3]?.[1].headers)).toMatchObject(expect.any(Headers))
    expect(new Headers(calls[3]?.[1].headers).get('x-gestalt-proof-jti')).toBe('proof')
    expect(new Headers(calls[3]?.[1].headers).get('authorization')).toBe('Bearer access')
  })

  it('uses stable Platform errors and falls back for proxy and malformed error bodies', async () => {
    const bodies: Array<{ body: BodyInit; contentType?: string; expected: string }> = [
      { body: JSON.stringify({ error: { code: 'SESSION_REVOKED', message: 'revoked' } }), contentType: 'application/json', expected: 'revoked' },
      { body: 'proxy failure', expected: 'Platform Account request failed with HTTP 502' },
      { body: 'null', contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: '{}', contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: JSON.stringify({ error: null }), contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: JSON.stringify({ error: {} }), contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: JSON.stringify({ error: { code: 1, message: 'bad' } }), contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: JSON.stringify({ error: { code: 'BAD', message: 1 } }), contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
      { body: JSON.stringify({ error: { code: 'BAD', message: 'bad request' } }), contentType: 'application/json', expected: 'BAD: bad request' },
      { body: JSON.stringify({ error: { code: 'QUOTA', message: 'full', retryAfter: 1.5 } }), contentType: 'application/json', expected: 'Platform Account request failed with HTTP 502' },
    ]
    for (const item of bodies) {
      const transport = new PlatformAccountHttpTransport({
        environment: DEVELOPMENT,
        fetch: vi.fn().mockResolvedValue(new Response(item.body, {
          status: 502, headers: item.contentType === undefined ? {} : { 'content-type': item.contentType },
        })),
      })
      await expect(transport.current({ accessToken: 'access', proof })).rejects.toThrow(item.expected)
    }
  })

  it('preserves quota and capacity retry timing', async () => {
    const transport = new PlatformAccountHttpTransport({
      environment: DEVELOPMENT,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code: 'QUOTA', message: 'full', retryAfter: 60 },
      }), { status: 429, headers: { 'content-type': 'application/json' } })),
    })
    await expect(transport.current({ accessToken: 'access', proof })).rejects.toMatchObject({
      code: 'QUOTA',
      retryAfter: 60,
    })
  })

  it('retains the global fetch default without crossing environments', () => {
    expect(() => new PlatformAccountHttpTransport({
      environment: DEVELOPMENT,
    })).not.toThrow()
  })

  it('rejects malformed response variants at every HTTP boundary', async () => {
    const transport = new PlatformAccountHttpTransport({
      environment: DEVELOPMENT,
      fetch: vi.fn(async () => json({})),
    })
    await expect(transport.beginLogin({
      installationId: parseInstallationId('malformed'), installationKind: 'desktop', publicKey: {},
    })).rejects.toThrow('attemptId')
    await expect(transport.pollLogin({
      attemptId: parseLoginAttemptId('malformed'), pollingToken: 'poll', proof,
    })).rejects.toThrow('status')
    await expect(transport.refresh({ refreshToken: 'refresh', proof })).rejects.toThrow('Account Session')
    await expect(transport.current({ accessToken: 'access', proof })).rejects.toThrow('Platform Account')
    const backwards = { ...session('account-a', 'octocat'), accessExpiresAt: 2_000, refreshExpiresAt: 1_000 }
    const backwardsTransport = new PlatformAccountHttpTransport({
      environment: DEVELOPMENT, fetch: vi.fn(async () => json(backwards)),
    })
    await expect(backwardsTransport.refresh({ refreshToken: 'refresh', proof }))
      .rejects.toThrow('refresh expiry must not precede access expiry')
    const nonObject = new PlatformAccountHttpTransport({
      environment: DEVELOPMENT, fetch: vi.fn(async () => json(null)),
    })
    await expect(nonObject.current({ accessToken: 'access', proof })).rejects.toThrow('must be an object')
    const insecureAttempt = new PlatformAccountHttpTransport({
      environment: DEVELOPMENT, fetch: vi.fn(async () => json({ ...ATTEMPT, authorizationUrl: 'http://github.example' })),
    })
    await expect(insecureAttempt.beginLogin({
      installationId: parseInstallationId('insecure'), installationKind: 'mobile', publicKey: {},
    })).rejects.toThrow('must use HTTPS')
  })
})

describe('IndexedDbInstallationAccountStore', () => {
  it('round-trips session and pending records under environment-specific keys', async () => {
    const fake = indexedDbFake()
    vi.stubGlobal('indexedDB', fake.api)
    const store = new IndexedDbInstallationAccountStore()
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    const record = { environment: 'development' as const, session: session('account-a', 'octocat'), privateKey: pair.privateKey }
    await store.saveSession(record)
    expect(await store.loadSession('development')).toEqual(record)
    await store.clearSession('development')
    expect(await store.loadSession('development')).toBeUndefined()
    await store.savePending('production', { attempt: ATTEMPT, privateKey: pair.privateKey })
    expect(await store.loadPending('production')).toMatchObject({ attempt: ATTEMPT })
    await store.clearPending('production')
    expect(await store.loadPending('production')).toBeUndefined()
    expect(fake.opened).toEqual(['deepseek-gestalt-platform-account'])
  })

  it.each(['open', 'read', 'write', 'remove'] as const)('propagates IndexedDB %s failures', async (failure) => {
    const fake = indexedDbFake(failure)
    vi.stubGlobal('indexedDB', fake.api)
    const store = new IndexedDbInstallationAccountStore('failure-db')
    let operation: Promise<unknown>
    if (failure === 'open' || failure === 'read') {
      operation = store.loadSession('development')
    } else {
      const pair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
      )
      operation = failure === 'write'
        ? store.saveSession({ environment: 'development', session: session('account-a', 'octocat'), privateKey: pair.privateKey })
        : store.clearSession('development')
    }
    await expect(operation).rejects.toThrow(`fake ${failure} failure`)
  })

  it.each([
    ['open-null', 'Platform Account IndexedDB open failed'],
    ['read-null', 'Platform Account IndexedDB read failed'],
    ['write-null', 'Platform Account IndexedDB write failed'],
    ['remove-null', 'Platform Account IndexedDB delete failed'],
  ] as const)('supplies a stable fallback for IndexedDB %s failures without an error', async (failure, message) => {
    const fake = indexedDbFake(failure)
    vi.stubGlobal('indexedDB', fake.api)
    const store = new IndexedDbInstallationAccountStore('failure-db')
    let operation: Promise<unknown>
    if (failure === 'open-null' || failure === 'read-null') {
      operation = store.loadSession('development')
    } else {
      const pair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
      )
      operation = failure === 'write-null'
        ? store.saveSession({ environment: 'development', session: session('account-a', 'octocat'), privateKey: pair.privateKey })
        : store.clearSession('development')
    }
    await expect(operation).rejects.toThrow(message)
  })

  it('rejects malformed session, attempt, and P-256 key records from IndexedDB', async () => {
    const fake = indexedDbFake()
    vi.stubGlobal('indexedDB', fake.api)
    const store = new IndexedDbInstallationAccountStore('malformed-db')
    fake.records.set('development:session', {
      environment: 'development', session: {}, privateKey: { type: 'private', algorithm: {}, usages: ['sign'] },
    })
    await expect(store.loadSession('development')).rejects.toThrow('Account Session')
    fake.records.set('development:session', {
      environment: 'production', session: session('account-a', 'octocat'),
      privateKey: { type: 'private', algorithm: { name: 'ECDSA', namedCurve: 'P-256' }, usages: ['sign'] },
    })
    await expect(store.loadSession('development')).rejects.toThrow('another environment')
    fake.records.set('production:pending', {
      attempt: ATTEMPT, privateKey: { type: 'private', algorithm: { name: 'ECDSA', namedCurve: 'P-384' }, usages: ['sign'] },
    })
    await expect(store.loadPending('production')).rejects.toThrow('must be a signing P-256 CryptoKey')
    fake.records.set('production:pending', {
      attempt: ATTEMPT,
      privateKey: { type: 'private', algorithm: { name: 'ECDSA', namedCurve: 'P-256' }, usages: ['sign'] },
    })
    await expect(store.loadPending('production')).rejects.toThrow('must be a signing P-256 CryptoKey')
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    )
    fake.records.set('production:pending', { attempt: ATTEMPT, privateKey: pair.publicKey })
    await expect(store.loadPending('production')).rejects.toThrow('must be a signing P-256 CryptoKey')
    fake.records.set('production:pending', { attempt: ATTEMPT, privateKey: pair.privateKey })
    await expect(store.loadPending('production')).resolves.toMatchObject({ attempt: ATTEMPT })
    fake.records.set('production:pending', null)
    await expect(store.loadPending('production')).rejects.toThrow('pending login must be an object')
  })
})

describe('ACCOUNT_PRIVACY_NOTICE', () => {
  it('states retained data, retention, encrypted blobs, and the absent deletion flow in both languages', () => {
    expect(ACCOUNT_PRIVACY_NOTICE.zh).toContain('7 天')
    expect(ACCOUNT_PRIVACY_NOTICE.zh).toContain('30 天')
    expect(ACCOUNT_PRIVACY_NOTICE.zh).toContain('不提供账号删除')
    expect(ACCOUNT_PRIVACY_NOTICE.en).toContain('7 days')
    expect(ACCOUNT_PRIVACY_NOTICE.en).toContain('30 days')
    expect(ACCOUNT_PRIVACY_NOTICE.en).toContain('does not provide account deletion')
  })
})

function indexedDbFake(failure?: 'open' | 'read' | 'write' | 'remove' | 'open-null' | 'read-null' | 'write-null' | 'remove-null'): {
  api: IDBFactory
  opened: string[]
  records: Map<IDBValidKey, unknown>
} {
  const records = new Map<IDBValidKey, unknown>()
  const opened: string[] = []
  const database = {
    createObjectStore: vi.fn(),
    transaction() {
      const transaction: Record<string, unknown> = {
        error: failure?.endsWith('-null') === true ? null : new Error(`fake ${failure ?? 'transaction'} failure`),
      }
      transaction.objectStore = () => ({
        get(key: IDBValidKey) {
          const request: Record<string, unknown> = {
            result: records.get(key), error: failure === 'read-null' ? null : new Error('fake read failure'),
          }
          queueMicrotask(() => {
            if (failure === 'read' || failure === 'read-null') (request.onerror as (() => void))()
            else (request.onsuccess as (() => void))()
          })
          return request
        },
        put(value: unknown, key: IDBValidKey) {
          records.set(key, value)
          queueMicrotask(() => {
            if (failure === 'write' || failure === 'write-null') (transaction.onerror as (() => void))()
            else (transaction.oncomplete as (() => void))()
          })
        },
        delete(key: IDBValidKey) {
          records.delete(key)
          queueMicrotask(() => {
            if (failure === 'remove' || failure === 'remove-null') (transaction.onerror as (() => void))()
            else (transaction.oncomplete as (() => void))()
          })
        },
      })
      return transaction
    },
  }
  return {
    opened,
    records,
    api: {
      open(name: string) {
        opened.push(name)
        const request: Record<string, unknown> = {
          result: database, error: failure === 'open-null' ? null : new Error('fake open failure'),
        }
        queueMicrotask(() => {
          if (failure === 'open' || failure === 'open-null') (request.onerror as (() => void))()
          else {
            ;(request.onupgradeneeded as (() => void))()
            ;(request.onsuccess as (() => void))()
          }
        })
        return request
      },
    } as unknown as IDBFactory,
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((next) => { resolve = next }), resolve }
}
