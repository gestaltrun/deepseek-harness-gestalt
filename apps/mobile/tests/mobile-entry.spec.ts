// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

const browserOpen = vi.hoisted(() => vi.fn<(options: { url: string }) => Promise<void>>())
const relayLifecycle = vi.hoisted(() => ({
  configure: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isConnected: vi.fn(() => false),
  onCiphertext: undefined as (() => void) | undefined,
  onPeerAttachments: undefined as ((ready: { peers: readonly unknown[] }) => Promise<void>) | undefined,
  onConnectionReady: undefined as (() => void) | undefined,
  onConnectionLost: undefined as (() => void) | undefined,
  onTransportError: undefined as (() => void) | undefined,
}))

vi.mock('@capacitor/browser', () => ({ Browser: { open: browserOpen } }))
vi.mock('@capacitor/device', () => ({
  Device: {
    getInfo: vi.fn(async () => ({
      name: 'Entry test installation',
      model: 'Test mobile model',
      platform: 'ios',
      operatingSystem: 'ios',
    })),
  },
}))
vi.mock('@deepseek-ai/dsh-remote-access-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-remote-access-client')>()
  return {
    ...actual,
    MobileRelayEndpointLifecycle: class {
      constructor(options: {
        onCiphertext?: () => void
        onPeerAttachments?: (ready: { peers: readonly unknown[] }) => Promise<void>
        onConnectionReady?: () => void
        onConnectionLost?: () => void
        onTransportError?: () => void
      } = {}) {
        relayLifecycle.onCiphertext = options.onCiphertext
        relayLifecycle.onPeerAttachments = options.onPeerAttachments
        relayLifecycle.onConnectionReady = options.onConnectionReady
        relayLifecycle.onConnectionLost = options.onConnectionLost
        relayLifecycle.onTransportError = options.onTransportError
      }
      configure = relayLifecycle.configure
      start = relayLifecycle.start
      stop = relayLifecycle.stop
      isConnected = relayLifecycle.isConnected
    },
  }
})
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}))

afterEach(() => {
  cleanup()
  browserOpen.mockReset()
  relayLifecycle.configure.mockReset()
  relayLifecycle.start.mockReset()
  relayLifecycle.stop.mockReset()
  relayLifecycle.isConnected.mockReset()
  relayLifecycle.isConnected.mockReturnValue(false)
  relayLifecycle.onCiphertext = undefined
  relayLifecycle.onPeerAttachments = undefined
  relayLifecycle.onConnectionReady = undefined
  relayLifecycle.onConnectionLost = undefined
  relayLifecycle.onTransportError = undefined
  localStorage.clear()
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
          authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=mobile-production&redirect_uri=https%3A%2F%2Fplatform.example.com%2Fv1%2Faccount%2Foauth%2Fgithub%2Fcallback&state=state-mobile-entry&code_challenge=challenge&code_challenge_method=S256',
          pollingToken: 'signed-polling-token',
          expiresAt: Date.now() + 300_000,
        })
      }
      return json({ status: 'pending' })
    }))

    const { mobileProductStarted } = await import('../src/main.tsx')
    await mobileProductStarted
    fireEvent.click(await screen.findByRole('checkbox'))
    const button = screen.getByRole('button', { name: '使用 GitHub 继续' })
    await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(button)

    await waitFor(() => { expect(browserOpen).toHaveBeenCalledOnce() })
    const opened = new URL(browserOpen.mock.calls[0]?.[0].url as string)
    expect(opened.protocol).toBe('https:')
    expect(opened.origin).toBe('https://github.com')
    expect(opened.searchParams.get('redirect_uri')).toBe('https://platform.example.com/v1/account/oauth/github/callback')
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
    expect(opened.searchParams.has('scope')).toBe(false)
    expect(opened.searchParams.has('access_token')).toBe(false)
    expect(windowOpen).not.toHaveBeenCalled()
    await waitFor(() => { expect(calls.some(call => call.url.endsWith('/login-poll'))).toBe(true) })
    expect(calls.every(call => call.url.startsWith('https://platform.example.com/'))).toBe(true)
  })

  it('fails before rendering or traffic when the operated origin is missing', async () => {
    configureEnvironment()
    vi.stubEnv('VITE_PLATFORM_ORIGIN', '')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(import('../src/main.tsx')).rejects.toThrow('production origin is required')
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates the production Relay bundle before rendering or network acquisition', async () => {
    configureEnvironment()
    vi.stubEnv('VITE_REMOTE_RELAY_INBOUND_MAX_BYTES', '1')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const { mobileProductStarted } = await import('../src/main.tsx')
    await expect(mobileProductStarted).rejects.toThrow('must admit one maximum Relay message')

    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects legacy environment selection before rendering or traffic', async () => {
    configureEnvironment()
    vi.stubEnv('VITE_PLATFORM_ENV', 'development')
    document.body.innerHTML = '<div id="root"></div>'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(import('../src/main.tsx')).rejects.toThrow('legacy environment selection is not accepted')

    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('backgrounding stops the real Relay lifecycle and refuses settlement before sync', async () => {
    configureEnvironment()
    document.body.innerHTML = '<div id="root"></div>'
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'pending' })))
    let hidden = false
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => hidden ? 'hidden' : 'visible',
    })

    const { mobileProductStarted } = await import('../src/main.tsx')
    await mobileProductStarted
    const { companionMayMutate, companionRuntime } = await import('../src/companion-lifecycle.ts')
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
    await waitFor(() => { expect(runtime.getState().foreground).toBe(false) })
    expect(runtime.getState()).toMatchObject({ foreground: false, socketOpen: false, synchronized: false })
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toBeUndefined()

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(runtime.getState().foreground).toBe(true) })
    expect(runtime.getState()).toMatchObject({ foreground: true, socketOpen: false, synchronized: false })
    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toBeUndefined()

    expect(() => { relayLifecycle.onCiphertext?.() }).toThrow('pending Snow IK owner')
    expect(runtime.getState().synchronized).toBe(false)
    relayLifecycle.onConnectionReady?.()
    const firstResync = runtime.bindValidatedDesktopResync()
    if (firstResync === undefined) throw new Error('expected first Desktop resync receiver')
    firstResync.acceptValidatedDesktopResync({ type: 'desktop-resync', version: 1, authenticated: true })
    expect(runtime.getState().synchronized).toBe(true)
    expect(companionMayMutate(runtime.getState())).toBe(true)
    expect(settleCompanionInteraction({
      operationId: 'op-approve', kind: 'approval', summary: 'write a.ts', authorized: ['once'],
    }, { accepted: true, decision: 'once' }, runtime.getState()).settled).toEqual({ decision: 'once' })

    relayLifecycle.onConnectionLost?.()
    relayLifecycle.onTransportError?.()
    expect(companionMayMutate(runtime.getState())).toBe(false)
    relayLifecycle.onConnectionReady?.()
    firstResync.acceptValidatedDesktopResync({ type: 'desktop-resync', version: 1, authenticated: true })
    expect(companionMayMutate(runtime.getState())).toBe(false)
    const replacementResync = runtime.bindValidatedDesktopResync()
    if (replacementResync === undefined) throw new Error('expected replacement Desktop resync receiver')
    replacementResync.acceptValidatedDesktopResync({ type: 'desktop-resync', version: 1, authenticated: true })
    expect(companionMayMutate(runtime.getState())).toBe(true)
    await relayLifecycle.onPeerAttachments?.({ peers: [] })
    expect(companionMayMutate(runtime.getState())).toBe(false)
    expect(runtime.getState()).toMatchObject({ socketOpen: true, synchronized: false })
    runtime.markAuthenticatedPeer()
    const afterPeerRemoval = runtime.bindValidatedDesktopResync()
    if (afterPeerRemoval === undefined) throw new Error('expected resync receiver after peer removal')
    afterPeerRemoval.acceptValidatedDesktopResync({ type: 'desktop-resync', version: 1, authenticated: true })
    expect(companionMayMutate(runtime.getState())).toBe(true)
    await expect(relayLifecycle.onPeerAttachments?.({ peers: [{}, {}] })).rejects.toThrow('multiple Desktop')
    expect(companionMayMutate(runtime.getState())).toBe(false)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(companionMayMutate(runtime.getState())).toBe(false) })
    expect(runtime.getState()).toMatchObject({ foreground: false, socketOpen: false, synchronized: false })
  })
})

function configureEnvironment(): void {
  const fields: Record<string, string> = {
    VITE_PLATFORM_ORIGIN: 'https://platform.example.com',
    VITE_PLATFORM_CALLBACK_URL: 'https://platform.example.com/v1/account/oauth/github/callback',
    VITE_PLATFORM_GITHUB_CLIENT_ID: 'mobile-production',
    VITE_PLATFORM_CREDENTIAL_REFERENCE: 'credentials://production',
    VITE_PLATFORM_DATABASE_IDENTITY: 'database-production',
    VITE_PLATFORM_IDENTITY_NAMESPACE: 'namespace-production',
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
