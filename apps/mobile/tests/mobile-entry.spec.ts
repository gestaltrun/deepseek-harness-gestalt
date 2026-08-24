// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  writable: true,
  value: new IDBFactory(),
})

const browserOpen = vi.hoisted(() => vi.fn<(options: { url: string }) => Promise<void>>())
const nativePlatform = vi.hoisted(() => vi.fn(() => true))
const relayLifecycle = vi.hoisted(() => ({
  configure: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isConnected: vi.fn(() => false),
  sendCiphertext: vi.fn(async () => {}),
  onCiphertext: undefined as (() => void) | undefined,
}))

vi.mock('@capacitor/browser', () => ({ Browser: { open: browserOpen } }))
vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>()
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => nativePlatform() } }
})
vi.mock('@deepseek-ai/dsh-remote-access-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-remote-access-client')>()
  return {
    ...actual,
    MobileRelayEndpointLifecycle: class {
      constructor(options: { onCiphertext?: () => void } = {}) {
        relayLifecycle.onCiphertext = options.onCiphertext
      }
      configure = relayLifecycle.configure
      start = relayLifecycle.start
      stop = relayLifecycle.stop
      isConnected = relayLifecycle.isConnected
      sendCiphertext = relayLifecycle.sendCiphertext
    },
  }
})

afterEach(() => {
  cleanup()
  browserOpen.mockReset()
  nativePlatform.mockReset()
  nativePlatform.mockReturnValue(true)
  relayLifecycle.configure.mockReset()
  relayLifecycle.start.mockReset()
  relayLifecycle.stop.mockReset()
  relayLifecycle.isConnected.mockReset()
  relayLifecycle.isConnected.mockReturnValue(false)
  relayLifecycle.sendCiphertext.mockReset()
  relayLifecycle.onCiphertext = undefined
  localStorage.clear()
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: new IDBFactory(),
  })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  vi.resetModules()
})

describe('Mobile Platform Account entry', () => {
  it('fails loud when the browsing context cannot create an Installation id', async () => {
    configureEnvironment()
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    await expect(import('../src/main.tsx')).rejects.toThrow(/secure browsing context/)
  })

  it('opens the prepared GitHub URL through Capacitor from the user click and polls over HTTPS', async () => {
    configureEnvironment()
    document.body.innerHTML = '<div id="root"></div>'
    const windowOpen = vi.spyOn(window, 'open')
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      if (url.endsWith('/login-attempts')) {
        return json({
          id: 'attempt-mobile-entry',
          state: 'state-mobile-entry',
          authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile-development&redirect_uri=https%3A%2F%2Fdev.example%2Fv1%2Faccount%2Foauth%2Fgithub%2Fcallback&state=state-mobile-entry&code_challenge=challenge&code_challenge_method=S256',
          pollingToken: 'signed-polling-token',
          expiresAt: Date.now() + 300_000,
        })
      }
      return json({ status: 'pending' })
    }))

    await import('../src/main.tsx')
    fireEvent.click(await screen.findByRole('checkbox'))
    const button = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(button)

    await waitFor(() => { expect(browserOpen).toHaveBeenCalledOnce() })
    const opened = new URL(browserOpen.mock.calls[0]?.[0].url as string)
    expect(opened.protocol).toBe('https:')
    expect(opened.origin).toBe('https://github.com')
    expect(opened.searchParams.get('redirect_uri')).toBe('https://dev.example/v1/account/oauth/github/callback')
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
    expect(opened.searchParams.has('scope')).toBe(false)
    expect(opened.searchParams.has('access_token')).toBe(false)
    expect(windowOpen).not.toHaveBeenCalled()
    await waitFor(() => { expect(calls.some(call => call.url.endsWith('/login-poll'))).toBe(true) })
    expect(calls.every(call => call.url.startsWith('https://dev.example/'))).toBe(true)
  })

  it('navigates the current browsing context when Capacitor Browser is unavailable', async () => {
    configureEnvironment()
    document.body.innerHTML = '<div id="root"></div>'
    nativePlatform.mockReturnValue(false)
    const assign = vi.fn()
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/login-attempts')) {
        return json({
          id: 'attempt-web-fallback',
          state: 'state-web-fallback',
          authorizationUrl: 'https://127.0.0.1:8443/v1/account/oauth/github/development-complete?state=state-web-fallback',
          pollingToken: 'signed-polling-token',
          expiresAt: Date.now() + 300_000,
        })
      }
      return json({ status: 'pending' })
    }))

    await import('../src/main.tsx')
    fireEvent.click(await screen.findByRole('checkbox'))
    const button = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(button)

    await waitFor(() => { expect(assign).toHaveBeenCalledOnce() })
    expect(browserOpen).not.toHaveBeenCalled()
    expect(String(assign.mock.calls[0]?.[0])).toContain('/v1/account/oauth/github/development-complete')
  })

  it('rewrites loopback HTTPS Account and authorization URLs onto the Vite page origin', async () => {
    configureEnvironment({
      VITE_PLATFORM_DEVELOPMENT_ORIGIN: 'https://127.0.0.1:8443',
      VITE_PLATFORM_DEVELOPMENT_CALLBACK_URL: 'https://127.0.0.1:8443/v1/account/oauth/github/callback',
    })
    document.body.innerHTML = '<div id="root"></div>'
    nativePlatform.mockReturnValue(false)
    const assign = vi.fn()
    vi.stubGlobal('location', { assign, href: 'http://127.0.0.1:5174/', origin: 'http://127.0.0.1:5174' })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.endsWith('/login-attempts')) {
        return json({
          id: 'attempt-loopback-page',
          state: 'state-loopback-page',
          authorizationUrl: 'https://127.0.0.1:8443/v1/account/oauth/github/development-complete?state=state-loopback-page',
          pollingToken: 'signed-polling-token',
          expiresAt: Date.now() + 300_000,
        })
      }
      return json({ status: 'pending' })
    }))

    await import('../src/main.tsx')
    fireEvent.click(await screen.findByRole('checkbox'))
    const button = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(button)

    await waitFor(() => { expect(assign).toHaveBeenCalledOnce() })
    expect(calls.every(url => url.startsWith('http://127.0.0.1:5174/'))).toBe(true)
    expect(String(assign.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:5174/v1/account/oauth/github/development-complete?state=state-loopback-page',
    )
  })

  it('fails before rendering when Installation id creation is not a secure context', async () => {
    configureEnvironment()
    document.body.innerHTML = '<div id="root"></div>'
    vi.stubGlobal('crypto', { randomUUID: undefined })

    await expect(import('../src/main.tsx')).rejects.toThrow('secure browsing context')
    expect(document.getElementById('root')?.childElementCount).toBe(0)
  })

  it('fails before rendering or traffic when deployment selection is missing', async () => {
    configureEnvironment()
    vi.stubEnv('VITE_PLATFORM_ENV', '')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(import('../src/main.tsx')).rejects.toThrow('must be development or production')
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates the development Relay bundle before rendering or network acquisition', async () => {
    configureEnvironment()
    configureRelayEnvironment()
    vi.stubEnv('VITE_REMOTE_RELAY_INBOUND_MAX_BYTES', '1')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(import('../src/main.tsx')).rejects.toThrow('must admit one maximum Relay message')

    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('backgrounding stops the real Relay lifecycle and refuses settlement before sync', async () => {
    configureEnvironment()
    configureRelayEnvironment()
    document.body.innerHTML = '<div id="root"></div>'
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'pending' })))
    let hidden = false
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => hidden ? 'hidden' : 'visible',
    })

    await import('../src/main.tsx')
    const { companionMayMutate, companionRuntime } = await import('../src/companion-push.ts')
    const { settleCompanionInteraction } = await import('../src/companion-approval.ts')
    const runtime = companionRuntime()
    if (runtime === undefined) throw new Error('expected companion runtime')
    expect(companionMayMutate(runtime.getState())).toBe(false)
    runtime.configure({
      routeId: parseRelayRouteId('route-entry'),
      endpoint: 'mobile',
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    })

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(relayLifecycle.stop).toHaveBeenCalled() })
    expect(runtime.getState()).toMatchObject({ foreground: false, socketOpen: false, synchronized: false })
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toBeUndefined()

    relayLifecycle.isConnected.mockReturnValue(true)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(relayLifecycle.start).toHaveBeenCalled() })
    await waitFor(() => {
      expect(relayLifecycle.sendCiphertext).toHaveBeenCalledWith('desktop-development-keyless', Uint8Array.of(1))
    })
    expect(runtime.getState().socketOpen).toBe(true)
    expect(runtime.getState().synchronized).toBe(false)
    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toBeUndefined()

    if (relayLifecycle.onCiphertext === undefined) throw new Error('expected Desktop resync listener')
    relayLifecycle.onCiphertext()
    expect(runtime.getState().synchronized).toBe(true)
    expect(companionMayMutate(runtime.getState())).toBe(true)
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toEqual({ decision: 'once' })

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(companionMayMutate(runtime.getState())).toBe(false) })
    expect(runtime.getState()).toMatchObject({ foreground: false, socketOpen: false, synchronized: false })
  })
})

function configureEnvironment(overrides: Record<string, string> = {}): void {
  const fields: Record<string, string> = {
    VITE_PLATFORM_ENV: 'development',
    VITE_PLATFORM_DEVELOPMENT_ORIGIN: 'https://dev.example',
    VITE_PLATFORM_DEVELOPMENT_CALLBACK_URL: 'https://dev.example/v1/account/oauth/github/callback',
    VITE_PLATFORM_DEVELOPMENT_GITHUB_CLIENT_ID: 'mobile-development',
    VITE_PLATFORM_DEVELOPMENT_CREDENTIAL_REFERENCE: 'credentials://development',
    VITE_PLATFORM_DEVELOPMENT_DATABASE_IDENTITY: 'database-development',
    VITE_PLATFORM_DEVELOPMENT_IDENTITY_NAMESPACE: 'namespace-development',
    VITE_PLATFORM_PRODUCTION_ORIGIN: 'https://prod.example',
    VITE_PLATFORM_PRODUCTION_CALLBACK_URL: 'https://prod.example/v1/account/oauth/github/callback',
    VITE_PLATFORM_PRODUCTION_GITHUB_CLIENT_ID: 'mobile-production',
    VITE_PLATFORM_PRODUCTION_CREDENTIAL_REFERENCE: 'credentials://production',
    VITE_PLATFORM_PRODUCTION_DATABASE_IDENTITY: 'database-production',
    VITE_PLATFORM_PRODUCTION_IDENTITY_NAMESPACE: 'namespace-production',
    ...overrides,
  }
  for (const [key, value] of Object.entries(fields)) vi.stubEnv(key, value)
}

function configureRelayEnvironment(): void {
  const fields: Record<string, string> = {
    VITE_PERSONAL_PAIRING_KEYLESS: '1',
    VITE_REMOTE_RELAY_WSS_URL: 'wss://relay.example/v1/remote-access/relay',
    VITE_REMOTE_RELAY_INBOUND_MAX_BYTES: '9999999',
    VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES: '8',
    VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS: '1000',
    VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS: '5000',
    VITE_REMOTE_RELAY_RECONNECT_DELAY_MS: '100',
  }
  for (const [key, value] of Object.entries(fields)) vi.stubEnv(key, value)
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
