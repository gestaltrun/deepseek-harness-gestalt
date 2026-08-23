import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitHubOAuthIdentityProvider,
  loadOperatedPlatformEnvironment,
  loadPlatformEnvironment,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

const development = {
  environment: 'development' as const,
  origin: 'https://platform.dev.example.com',
  callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
  githubClientId: 'github-development',
  credentialReference: 'credentials://platform-account/development/github-oauth-app',
  databaseIdentity: 'database-development',
  identityNamespace: 'identity-development',
}
const production = {
  environment: 'production' as const,
  origin: 'https://platform.example.com',
  callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
  githubClientId: 'github-production',
  credentialReference: 'credentials://platform-account/production/github-oauth-app',
  databaseIdentity: 'database-production',
  identityNamespace: 'identity-production',
}

function selectedDevelopment() {
  return selectPlatformEnvironment(validatePlatformEnvironmentPair({ development, production }), 'development')
}

function oauthOptions(fetch?: typeof globalThis.fetch) {
  const environment = selectedDevelopment()
  return {
    environment,
    credential: { reference: environment.credentialReference, secret: 'secret-development' },
    ...(fetch === undefined ? {} : { fetch }),
  }
}

describe('GitHubOAuthIdentityProvider', () => {
  it('rejects an OAuth credential resolved from another environment before traffic', () => {
    const environment = selectedDevelopment()
    const fetch = vi.fn()
    expect(() => new GitHubOAuthIdentityProvider({
      environment,
      credential: {
        reference: 'credentials://platform-account/production/github-oauth-app',
        secret: 'secret-production',
      },
      fetch,
    })).toThrow('credential reference does not match')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an empty resolved OAuth secret before traffic', () => {
    const environment = selectedDevelopment()
    const fetch = vi.fn()
    expect(() => new GitHubOAuthIdentityProvider({
      environment,
      credential: { reference: environment.credentialReference, secret: '' },
      fetch,
    })).toThrow('client secret must be non-empty')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requests no scope and retains only numeric id, login, and avatar URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'provider-token',
        token_type: 'bearer',
        scope: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 13994321,
        login: 'octocat',
        avatar_url: 'https://avatars.example/octocat',
        email: 'must-not-be-retained@example.com',
        company: 'must-not-be-retained',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new GitHubOAuthIdentityProvider(oauthOptions(fetch))
    const authorization = new URL(provider.authorizationUrl({
      callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
      state: 'random-state',
      codeChallenge: 'challenge',
    }))
    expect(authorization.searchParams.has('scope')).toBe(false)

    await expect(provider.exchange('github-code', 'pkce-verifier')).resolves.toEqual({
      providerSubject: 13994321,
      login: 'octocat',
      avatarUrl: 'https://avatars.example/octocat',
    })
    const tokenBody = new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)
    expect(tokenBody.get('code_verifier')).toBe('pkce-verifier')
    expect(tokenBody.has('scope')).toBe(false)
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer provider-token' })
  })

  it('rejects an inherited GitHub scope instead of using the broader token', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'provider-token',
      token_type: 'bearer',
      scope: 'repo,user',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new GitHubOAuthIdentityProvider(oauthOptions(fetch))
    await expect(provider.exchange('github-code', 'pkce-verifier'))
      .rejects.toThrow('GitHub returned a token with OAuth scopes')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('defaults to global fetch and enforces the selected fixed callback', () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new GitHubOAuthIdentityProvider(oauthOptions())
    expect(() => provider.authorizationUrl({
      callbackUrl: 'https://other.example/v1/account/oauth/github/callback', state: 'state', codeChallenge: 'challenge',
    })).toThrow('does not match')
  })

  it.each([
    { name: 'token HTTP failure', responses: [new Response('', { status: 502 })], message: 'token exchange failed' },
    { name: 'non-object token body', responses: [json(null)], message: 'no access token' },
    { name: 'missing access token', responses: [json({ scope: '' })], message: 'no access token' },
    { name: 'missing token scope', responses: [json({ access_token: 'token' })], message: 'with OAuth scopes' },
    { name: 'identity HTTP failure', responses: [json({ access_token: 'token', scope: '' }), new Response('', { status: 503 })], message: 'identity lookup failed' },
    { name: 'non-object identity', responses: [json({ access_token: 'token', scope: '' }), json(null)], message: 'missing public identity fields' },
    { name: 'invalid identity id', responses: [json({ access_token: 'token', scope: '' }), json({ id: '1', login: 'octocat', avatar_url: 'avatar' })], message: 'missing public identity fields' },
    { name: 'missing identity login', responses: [json({ access_token: 'token', scope: '' }), json({ id: 1, avatar_url: 'avatar' })], message: 'missing public identity fields' },
    { name: 'missing identity avatar', responses: [json({ access_token: 'token', scope: '' }), json({ id: 1, login: 'octocat' })], message: 'missing public identity fields' },
  ])('rejects $name', async ({ responses, message }) => {
    const fetch = vi.fn()
    for (const response of responses) fetch.mockResolvedValueOnce(response)
    const provider = new GitHubOAuthIdentityProvider(oauthOptions(fetch))
    await expect(provider.exchange('code', 'verifier')).rejects.toThrow(message)
  })
})

describe('validatePlatformEnvironmentPair', () => {
  it('accepts two completely separate deployment identities', () => {
    expect(validatePlatformEnvironmentPair({ development, production })).toEqual({ development, production })
    expect(loadPlatformEnvironment({ selection: 'development', development, production })).toMatchObject(development)
  })

  it('requires an explicit known environment before selecting any deployment identity', () => {
    const pair = validatePlatformEnvironmentPair({ development, production })
    expect(selectPlatformEnvironment(pair, 'development')).toEqual(development)
    expect(selectPlatformEnvironment(pair, 'production')).toEqual(production)
    expect(() => selectPlatformEnvironment(pair, undefined)).toThrow('must be development or production')
    expect(() => selectPlatformEnvironment(pair, '')).toThrow('must be development or production')
    expect(() => selectPlatformEnvironment(pair, 'preview')).toThrow('must be development or production')
  })

  it('rejects selection before validation and parses required deployment fields', () => {
    expect(() => selectPlatformEnvironment({ development, production }, 'development'))
      .toThrow('must be validated before selection')
    expect(() => validatePlatformEnvironmentPair({
      development: { ...development, environment: 'production' as never }, production,
    })).toThrow('development Platform environment tag is invalid')
    expect(() => loadPlatformEnvironment({
      selection: 'development',
      development: { ...development, origin: undefined },
      production,
    })).toThrow('development origin is required')
    expect(() => loadPlatformEnvironment({
      selection: 'development',
      development: { ...development, origin: ' ' },
      production,
    })).toThrow('development origin is required')
  })

  it.each([
    'origin', 'callbackUrl', 'githubClientId', 'credentialReference', 'databaseIdentity', 'identityNamespace',
  ] as const)('rejects a shared %s', (field) => {
    expect(() => validatePlatformEnvironmentPair({
      development,
      production: { ...production, [field]: development[field] },
    })).toThrow(`must use distinct ${field}`)
  })

  it.each([
    { field: 'origin', value: 'http://platform.dev.example.com', message: 'share one HTTPS origin' },
    { field: 'callbackUrl', value: 'http://platform.dev.example.com/v1/account/oauth/github/callback', message: 'share one HTTPS origin' },
    { field: 'callbackUrl', value: 'https://other.example.com/v1/account/oauth/github/callback', message: 'share one HTTPS origin' },
    { field: 'callbackUrl', value: 'https://platform.dev.example.com/wrong', message: 'callback path is invalid' },
    { field: 'githubClientId', value: ' ', message: 'identity fields must be non-empty' },
    { field: 'credentialReference', value: '', message: 'identity fields must be non-empty' },
    { field: 'databaseIdentity', value: '', message: 'identity fields must be non-empty' },
    { field: 'identityNamespace', value: '', message: 'identity fields must be non-empty' },
  ])('rejects invalid development $field', ({ field, value, message }) => {
    expect(() => validatePlatformEnvironmentPair({
      development: { ...development, [field]: value }, production,
    })).toThrow(message)
  })
})

describe('loadOperatedPlatformEnvironment', () => {
  it('accepts one complete non-local production identity', () => {
    expect(loadOperatedPlatformEnvironment(production)).toEqual(production)
  })

  it.each([
    { field: 'environment', value: 'development', message: 'must be production' },
    { field: 'origin', value: 'https://localhost', message: 'must not use a local host' },
    { field: 'origin', value: 'https://127.0.0.1', message: 'must not use a local host' },
    { field: 'callbackUrl', value: 'https://other.example.com/v1/account/oauth/github/callback', message: 'share one HTTPS origin' },
    { field: 'credentialReference', value: undefined, message: 'credential reference is required' },
  ])('rejects operated identity with $field=$value before use', ({ field, value, message }) => {
    expect(() => loadOperatedPlatformEnvironment({ ...production, [field]: value })).toThrow(message)
  })
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
