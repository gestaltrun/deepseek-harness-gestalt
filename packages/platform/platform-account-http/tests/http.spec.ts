import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AccountError,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
  type AccountService,
} from '@deepseek-ai/dsh-platform-account'
import { apply } from '../src/index.ts'

const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://desktop.dev.example.com',
    callbackUrl: 'https://desktop.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'http-development', credentialReference: 'credentials://http-development',
    databaseIdentity: 'http-database-development', identityNamespace: 'http-development',
  },
  production: {
    environment: 'production', origin: 'https://desktop.example.com',
    callbackUrl: 'https://desktop.example.com/v1/account/oauth/github/callback',
    githubClientId: 'http-production', credentialReference: 'credentials://http-production',
    databaseIdentity: 'http-database-production', identityNamespace: 'http-production',
  },
}), 'development')

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const openServers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()))
})

describe('Platform Account HTTP consumer', () => {
  it('rejects missing, invalid, duplicate, or environment-mismatched HTTP origins before registering routes', () => {
    const ctx = {
      platformAccount: { environment: ENVIRONMENT },
      webServer: { register() { return () => {} } },
      effect(register: () => () => void) { register() },
    } as unknown as Context
    expect(() => { apply(ctx, {} as never) }).toThrow('origins configuration is required')
    expect(() => { apply(ctx, null as never) }).toThrow('origins configuration is required')
    expect(() => { apply(ctx, { origins: 1 } as never) }).toThrow('origins configuration is required')
    expect(() => { apply(ctx, { origins: [] }) }).toThrow('origins configuration is required')
    expect(() => { apply(ctx, { origins: ['null'] }) }).toThrow('origin is invalid')
    expect(() => { apply(ctx, { origins: [ENVIRONMENT.origin, ENVIRONMENT.origin] }) }).toThrow('origin is duplicated')
    expect(() => { apply(ctx, { origins: ['https://other.example'] }) }).toThrow('do not include the selected Platform environment')
  })

  it('serves the complete lifecycle and bilingual fixed callback with exact CORS', async () => {
    const account = accountService()
    const server = await start(account)
    const origin = ENVIRONMENT.origin
    const begin = await fetch(`${server.origin}/v1/account/login-attempts`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: 'desktop-1',
        installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const },
        publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      }),
    })
    expect(begin.status).toBe(201)
    expect(begin.headers.get('access-control-allow-origin')).toBe(origin)
    expect(await begin.json()).toMatchObject({ id: 'attempt-1' })
    expect(account.beginLogin).toHaveBeenCalledWith(expect.objectContaining({ installationKind: 'desktop' }))

    const callback = await fetch(`${server.origin}/v1/account/oauth/github/callback?code=code&state=state`)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('授权已完成 / Authorization complete')
    expect(account.completeGitHubCallback).toHaveBeenCalledWith({ code: 'code', state: 'state' })

    const polling = await post(server.origin, '/v1/account/login-poll', {
      attemptId: 'attempt-1',
      pollingToken: 'poll',
      proof: { jti: 'proof-1', issuedAt: 1, signature: 'signature' },
    })
    expect(polling.status).toBe(200)
    expect(await polling.json()).toEqual({ status: 'pending' })

    const refresh = await post(server.origin, '/v1/account/session/refresh', {
      refreshToken: 'refresh',
      proof: { jti: 'proof-2', issuedAt: 2, signature: 'signature' },
    })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toMatchObject({ accessToken: 'access' })

    const proofHeaders = {
      authorization: 'Bearer access',
      'x-gestalt-proof-jti': 'proof-3',
      'x-gestalt-proof-issued-at': '3',
      'x-gestalt-proof-signature': 'signature',
    }
    const current = await fetch(`${server.origin}/v1/account/session`, { headers: proofHeaders })
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({ githubLogin: 'octocat' })
    const signOut = await fetch(`${server.origin}/v1/account/session`, { method: 'DELETE', headers: proofHeaders })
    expect(signOut.status).toBe(204)
    expect(account.signOut).toHaveBeenCalledOnce()
  })

  it('binds validated Mobile Installation presentation to the Login Attempt', async () => {
    const account = accountService()
    const server = await start(account)
    const response = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'mobile-authenticated',
      installationKind: 'mobile',
      presentation: { name: 'Authenticated device name', platform: 'android' },
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })

    expect(response.status).toBe(201)
    expect(account.beginLogin).toHaveBeenCalledWith({
      installationId: 'mobile-authenticated',
      installationKind: 'mobile',
      presentation: { name: 'Authenticated device name', platform: 'android' },
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })
  })

  it('handles preflight and rejects untrusted or malformed origins', async () => {
    const server = await start(accountService())
    const preflight = await fetch(`${server.origin}/v1/account/session`, {
      method: 'OPTIONS',
      headers: { origin: ENVIRONMENT.origin },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE')

    const denied = await fetch(`${server.origin}/v1/account/session`, {
      headers: { origin: 'https://attacker.example' },
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } })

    const malformed = await fetch(`${server.origin}/v1/account/session`, {
      headers: { origin: 'not an origin' },
    })
    expect(malformed.status).toBe(403)
  })

  it('admits the fixed Android and iOS Capacitor origins without admitting opaque origins', async () => {
    const server = await start(accountService(), undefined, {
      origins: [ENVIRONMENT.origin, 'https://localhost', 'capacitor://localhost'],
    })

    for (const origin of ['https://localhost', 'capacitor://localhost']) {
      const preflight = await fetch(`${server.origin}/v1/account/login-attempts`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    }

    const opaque = await fetch(`${server.origin}/v1/account/login-attempts`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    })
    expect(opaque.status).toBe(403)
  })

  it('returns stable validation, account, and internal error envelopes', async () => {
    const account = accountService()
    vi.mocked(account.pollLogin).mockRejectedValueOnce(new AccountError('LOGIN_ATTEMPT_EXPIRED', 'expired'))
    vi.mocked(account.beginLogin).mockRejectedValueOnce(new AccountError('PLATFORM_CAPACITY', 'full', 45))
    vi.mocked(account.refresh).mockRejectedValueOnce(new AccountError('SESSION_REVOKED', 'revoked'))
    vi.mocked(account.current).mockRejectedValueOnce(new Error('database unavailable'))
    const server = await start(account)

    const invalidJson = await fetch(`${server.origin}/v1/account/login-attempts`, {
      method: 'POST', body: '{', headers: { 'content-type': 'application/json' },
    })
    expect(await error(invalidJson)).toEqual([400, 'INVALID_JSON'])
    const wrongKind = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'watch', publicKey: {},
    })
    expect(await error(wrongKind)).toEqual([400, 'INVALID_REQUEST'])
    const missingQuery = await fetch(`${server.origin}/v1/account/oauth/github/callback?code=code`)
    expect(await error(missingQuery)).toEqual([400, 'INVALID_REQUEST'])
    const expired = await post(server.origin, '/v1/account/login-poll', {
      attemptId: 'attempt', pollingToken: 'poll', proof: { jti: 'jti', issuedAt: 1, signature: 'sig' },
    })
    expect(await error(expired)).toEqual([400, 'LOGIN_ATTEMPT_EXPIRED'])
    const capacity = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })
    expect(capacity.status).toBe(429)
    expect(capacity.headers.get('retry-after')).toBe('45')
    expect(await capacity.json()).toMatchObject({ error: { code: 'PLATFORM_CAPACITY', retryAfter: 45 } })
    const revoked = await post(server.origin, '/v1/account/session/refresh', {
      refreshToken: 'refresh', proof: { jti: 'jti', issuedAt: 1, signature: 'sig' },
    })
    expect(await error(revoked)).toEqual([401, 'SESSION_REVOKED'])
    const missingBearer = await fetch(`${server.origin}/v1/account/session`)
    expect(await error(missingBearer)).toEqual([401, 'AUTH_REQUIRED'])
    const internal = await fetch(`${server.origin}/v1/account/session`, {
      headers: {
        authorization: 'Bearer access',
        'x-gestalt-proof-jti': 'jti',
        'x-gestalt-proof-issued-at': '1',
        'x-gestalt-proof-signature': 'sig',
      },
    })
    expect(await error(internal)).toEqual([500, 'INTERNAL'])
    const wrongMethod = await fetch(`${server.origin}/v1/account/session`, { method: 'PATCH' })
    expect(await error(wrongMethod)).toEqual([405, 'METHOD_NOT_ALLOWED'])
  })

  it('caps JSON bodies and validates proof and bearer fields', async () => {
    const server = await start(accountService())
    const large = await fetch(`${server.origin}/v1/account/login-attempts`, {
      method: 'POST', body: JSON.stringify({ value: 'x'.repeat(65_537) }),
    })
    expect(await error(large)).toEqual([413, 'REQUEST_TOO_LARGE'])
    const missingProof = await fetch(`${server.origin}/v1/account/session`, {
      headers: { authorization: 'Bearer access' },
    })
    expect(await error(missingProof)).toEqual([400, 'INVALID_REQUEST'])
    const invalidIssuedAt = await fetch(`${server.origin}/v1/account/session`, {
      headers: {
        authorization: 'Bearer access',
        'x-gestalt-proof-jti': 'jti',
        'x-gestalt-proof-issued-at': 'nan',
        'x-gestalt-proof-signature': 'sig',
      },
    })
    expect(await error(invalidIssuedAt)).toEqual([400, 'INVALID_REQUEST'])
    const emptyProofJti = await fetch(`${server.origin}/v1/account/session`, {
      headers: {
        authorization: 'Bearer access',
        'x-gestalt-proof-jti': '',
        'x-gestalt-proof-issued-at': '1',
        'x-gestalt-proof-signature': 'sig',
      },
    })
    expect(await error(emptyProofJti)).toEqual([400, 'INVALID_REQUEST'])
    const emptyBearer = await fetch(`${server.origin}/v1/account/session`, {
      headers: { authorization: 'Bearer ' },
    })
    expect(await error(emptyBearer)).toEqual([401, 'AUTH_REQUIRED'])
  })

  it('rejects invalid request forms before they reach the Account service', async () => {
    const server = await start(accountService())
    const nonObject = await fetch(`${server.origin}/v1/account/login-attempts`, {
      method: 'POST', body: 'null', headers: { 'content-type': 'application/json' },
    })
    expect(await error(nonObject)).toEqual([400, 'INVALID_JSON'])
    const emptyInstallation = await post(server.origin, '/v1/account/login-attempts', {
      installationId: '', installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: {},
    })
    expect(await error(emptyInstallation)).toEqual([400, 'INVALID_REQUEST'])
    const invalidPublicKey = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: null,
    })
    expect(await error(invalidPublicKey)).toEqual([400, 'INVALID_REQUEST'])
    const missingMobilePresentation = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'mobile-1', installationKind: 'mobile', publicKey: {},
    })
    expect(await error(missingMobilePresentation)).toEqual([400, 'INVALID_REQUEST'])
    const missingDesktopPresentation = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop', publicKey: {},
    })
    expect(await error(missingDesktopPresentation)).toEqual([400, 'INVALID_REQUEST'])
    const invalidDesktopPlatform = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop',
      presentation: { name: 'Desktop', platform: 'web' }, publicKey: {},
    })
    expect(await error(invalidDesktopPlatform)).toEqual([400, 'INVALID_REQUEST'])
    const invalidDesktopName = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop',
      presentation: { name: '', platform: 'linux' }, publicKey: {},
    })
    expect(await error(invalidDesktopName)).toEqual([400, 'INVALID_REQUEST'])
    const invalidMobilePlatform = await post(server.origin, '/v1/account/login-attempts', {
      installationId: 'mobile-1', installationKind: 'mobile',
      presentation: { name: 'Browser', platform: 'web' }, publicKey: {},
    })
    expect(await error(invalidMobilePlatform)).toEqual([400, 'INVALID_REQUEST'])
    const invalidProof = await post(server.origin, '/v1/account/login-poll', {
      attemptId: 'attempt-1', pollingToken: 'poll', proof: null,
    })
    expect(await error(invalidProof)).toEqual([400, 'INVALID_REQUEST'])
    const emptyProofJti = await post(server.origin, '/v1/account/login-poll', {
      attemptId: 'attempt-1', pollingToken: 'poll', proof: { jti: '', issuedAt: 1, signature: 'signature' },
    })
    expect(await error(emptyProofJti)).toEqual([400, 'INVALID_REQUEST'])
    const wrongMethod = await fetch(`${server.origin}/v1/account/login-attempts`)
    expect(await error(wrongMethod)).toEqual([405, 'METHOD_NOT_ALLOWED'])

    const encoded = await start(accountService(), (req) => { req.setEncoding('utf8') })
    const encodedBody = await post(encoded.origin, '/v1/account/login-attempts', {
      installationId: 'desktop-1', installationKind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const }, publicKey: {},
    })
    expect(encodedBody.status).toBe(201)

    const missingUrl = await start(accountService(), (req, path) => {
      if (path === '/v1/account/oauth/github/callback') req.url = undefined
    })
    const callback = await fetch(`${missingUrl.origin}/v1/account/oauth/github/callback?code=code&state=state`)
    expect(await error(callback)).toEqual([400, 'INVALID_REQUEST'])
  })

  it('rejects a missing or mismatched Account HTTP origin set at load', () => {
    const ctx = {
      platformAccount: { environment: ENVIRONMENT },
      webServer: { register() { return () => {} } },
      effect(register: () => () => void) { register() },
    } as unknown as Context
    expect(() => { apply(ctx, null as never) }).toThrow('origins configuration is required')
    expect(() => { apply(ctx, { origins: ['https://other.example'] }) }).toThrow('do not include')
  })
})

interface MockAccountService {
  environment: AccountService['environment']
  beginLogin: Mock<AccountService['beginLogin']>
  completeGitHubCallback: Mock<AccountService['completeGitHubCallback']>
  pollLogin: Mock<AccountService['pollLogin']>
  refresh: Mock<AccountService['refresh']>
  current: Mock<AccountService['current']>
  signOut: Mock<AccountService['signOut']>
  trackConnection: Mock<AccountService['trackConnection']>
}

function accountService(): MockAccountService {
  return {
    environment: ENVIRONMENT,
    beginLogin: vi.fn<AccountService['beginLogin']>().mockResolvedValue({
      id: 'attempt-1' as never, state: 'state', authorizationUrl: 'https://github.com/login/oauth/authorize',
      pollingToken: 'poll', expiresAt: 300_000,
    }),
    completeGitHubCallback: vi.fn<AccountService['completeGitHubCallback']>().mockResolvedValue({ completed: true }),
    pollLogin: vi.fn<AccountService['pollLogin']>().mockResolvedValue({ status: 'pending' }),
    refresh: vi.fn<AccountService['refresh']>().mockResolvedValue(session()),
    current: vi.fn<AccountService['current']>().mockResolvedValue(session().account),
    signOut: vi.fn<AccountService['signOut']>().mockResolvedValue(undefined),
    trackConnection: vi.fn<AccountService['trackConnection']>(),
  }
}

function session() {
  return {
    sessionId: 'session-1' as never,
    account: { id: 'account-1' as never, githubId: 13994321, githubLogin: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
    accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: 900_000, refreshExpiresAt: 2_592_000_000,
  }
}

async function start(
  account: MockAccountService,
  mutateRequest?: (request: IncomingMessage, path: string) => void,
  config: Parameters<typeof apply>[1] = { origins: [account.environment.origin] },
): Promise<{ origin: string }> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    platformAccount: account,
    webServer: {
      register(route: RegisteredRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(ctx, config)
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.get(path)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    mutateRequest?.(req, path)
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP test server did not bind TCP')
  const close = async () => { await new Promise<void>((resolve, reject) => {
    http.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }) }
  openServers.push({ close })
  return { origin: `http://127.0.0.1:${String(address.port)}` }
}

async function post(origin: string, path: string, body: unknown): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

async function error(response: Response): Promise<[number, string]> {
  const body = await response.json() as { error: { code: string } }
  return [response.status, body.error.code]
}
