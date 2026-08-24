// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { IndexedDbInstallationAccountStore } from '@deepseek-ai/dsh-platform-account-client'
import { RemoteRelayError } from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
  RemoteProtocolError,
} from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileCompanionProjectionDto } from '../src/companion-projection.ts'

const browserOpen = vi.hoisted(() => vi.fn<(options: { url: string }) => Promise<void>>())
const protectedValues = vi.hoisted(() => new Map<string, string>())
const relayLifecycle = vi.hoisted(() => ({
  configure: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isConnected: vi.fn(() => false),
  sendCiphertext: vi.fn(async () => {}),
  onCiphertext: undefined as ((
    ciphertext: Uint8Array,
    sourceAttachmentId: ReturnType<typeof parseRelayAttachmentId>,
  ) => Promise<void>) | undefined,
  onPeerAttachments: undefined as ((ready: { peers: readonly unknown[] }) => Promise<void>) | undefined,
  onConnectionReady: undefined as (() => void) | undefined,
  onConnectionLost: undefined as (() => void) | undefined,
  onTransportError: undefined as ((error: RemoteRelayError | RemoteProtocolError) => void) | undefined,
}))
const snowAttachmentOwners = vi.hoisted(() => ({
  selectors: [] as string[],
  begin: vi.fn(async (ready: { peers: ReadonlyArray<{ attachmentId: string }> }) => ({
    targetAttachmentId: ready.peers[0]?.attachmentId,
    payload: Uint8Array.of(1),
  })),
  finish: vi.fn((_ciphertext: Uint8Array, sourceAttachmentId: ReturnType<typeof parseRelayAttachmentId>) => {
    const channel = {
      dispose: vi.fn(),
      seal: vi.fn(() => Uint8Array.of(2)),
      open: vi.fn(),
    }
    return {
      targetAttachmentId: sourceAttachmentId,
      payload: Uint8Array.of(3),
      finish: vi.fn(() => channel),
      cancel: vi.fn(),
    }
  }),
  dispose: vi.fn(),
}))
const projectionCaches = vi.hoisted(() => ({
  projection: undefined as MobileCompanionProjectionDto | undefined,
  instances: [] as Array<{
    clearContent: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@capacitor/browser', () => ({ Browser: { open: browserOpen } }))
vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}))
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
        onCiphertext?: typeof relayLifecycle.onCiphertext
        onPeerAttachments?: (ready: { peers: readonly unknown[] }) => Promise<void>
        onConnectionReady?: () => void
        onConnectionLost?: () => void
        onTransportError?: typeof relayLifecycle.onTransportError
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
      sendCiphertext = relayLifecycle.sendCiphertext
    },
  }
})
vi.mock('@deepseek-ai/dsh-noise-channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-noise-channel')>()
  return {
    ...actual,
    SnowMobileAttachmentOwner: class {
      constructor(_reconnectState: Uint8Array, pairingSelector: string) {
        snowAttachmentOwners.selectors.push(pairingSelector)
      }
      begin = snowAttachmentOwners.begin
      finish = snowAttachmentOwners.finish
      dispose = snowAttachmentOwners.dispose
    },
  }
})
vi.mock('../src/companion-cache-runtime.ts', () => ({
  MobileCompanionProjectionCacheRuntime: class {
    readonly operationSettlement = undefined
    readonly restore = vi.fn(async () => projectionCaches.projection)
    readonly save = vi.fn(async () => {})
    readonly clearContent = vi.fn(async () => {})
    readonly destroy = vi.fn(async () => {})
    constructor() { projectionCaches.instances.push(this) }
  },
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    get: async ({ key }: { key: string }): Promise<{ value?: string }> => {
      const value = protectedValues.get(key)
      return value === undefined ? {} : { value }
    },
    set: async ({ key, value }: { key: string; value: string }) => { protectedValues.set(key, value) },
    remove: async ({ key }: { key: string }) => { protectedValues.delete(key) },
    addListener: async () => ({ remove: async () => {} }),
  }),
}))

afterEach(() => {
  cleanup()
  browserOpen.mockReset()
  relayLifecycle.configure.mockReset()
  relayLifecycle.start.mockReset()
  relayLifecycle.stop.mockReset()
  relayLifecycle.isConnected.mockReset()
  relayLifecycle.isConnected.mockReturnValue(false)
  relayLifecycle.sendCiphertext.mockReset()
  relayLifecycle.onCiphertext = undefined
  relayLifecycle.onPeerAttachments = undefined
  relayLifecycle.onConnectionReady = undefined
  relayLifecycle.onConnectionLost = undefined
  relayLifecycle.onTransportError = undefined
  snowAttachmentOwners.selectors.length = 0
  snowAttachmentOwners.begin.mockClear()
  snowAttachmentOwners.finish.mockClear()
  snowAttachmentOwners.dispose.mockClear()
  projectionCaches.projection = undefined
  projectionCaches.instances.length = 0
  localStorage.clear()
  protectedValues.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  vi.resetModules()
})

describe('Mobile Platform Account entry', () => {
  it('fails loud when the browsing context cannot create an Installation id', async () => {
    configureEnvironment()
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const { mobileProductStarted } = await import('../src/main.tsx')
    await expect(mobileProductStarted).rejects.toThrow(/system cryptography/)
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

    await expect(relayLifecycle.onCiphertext?.(
      Uint8Array.of(1), parseRelayAttachmentId('unexpected-desktop'),
    )).rejects.toThrow('pending Snow IK owner')
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
    relayLifecycle.onTransportError?.(new RemoteRelayError('REMOTE_OFFLINE', 'Paired Desktop is Remote Offline'))
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

  it('rejects a wrong retained pairing selector in the initial Relay ready projection before Snow IK', async () => {
    const product = await mountSelectedDesktopProduct('wrong-initial')

    await expect(relayLifecycle.onPeerAttachments?.(relayPeerProjection(
      'ready', product.databaseIdentity, 'work', 1,
    ))).rejects.toThrow('selected Paired Desktop')

    expect(snowAttachmentOwners.selectors).toEqual([])
    expect(snowAttachmentOwners.begin).not.toHaveBeenCalled()
    expect(product.runtime.getState()).toMatchObject({ socketOpen: false, synchronized: false })
    expect(product.companionMayMutate(product.runtime.getState())).toBe(false)
    expect(screen.getByText(product.cachedProjection.desktopName)).toBeTruthy()
    expect(product.cacheInstances.every(cache => !cache.clearContent.mock.calls.length
      && !cache.destroy.mock.calls.length)).toBe(true)
  })

  it('revalidates a wrong pairing selector in a same-generation peer update and drops mutation authority', async () => {
    const product = await mountSelectedDesktopProduct('wrong-update')
    relayLifecycle.onConnectionReady?.()
    await relayLifecycle.onPeerAttachments?.(relayPeerProjection(
      'ready', product.databaseIdentity, 'home', 1,
    ))
    await relayLifecycle.onCiphertext?.(Uint8Array.of(2), parseRelayAttachmentId('desktop-home'))
    const resync = product.runtime.bindValidatedDesktopResync()
    if (resync === undefined) throw new Error('expected authenticated Desktop resync receiver')
    resync.acceptValidatedDesktopResync({ type: 'desktop-resync', version: 1, authenticated: true })
    expect(product.companionMayMutate(product.runtime.getState())).toBe(true)

    await expect(relayLifecycle.onPeerAttachments?.(relayPeerProjection(
      'peer-update', product.databaseIdentity, 'work', 1,
    ))).rejects.toThrow('selected Paired Desktop')

    expect(snowAttachmentOwners.selectors).toEqual(['home'])
    expect(snowAttachmentOwners.begin).toHaveBeenCalledOnce()
    expect(product.companionMayMutate(product.runtime.getState())).toBe(false)
    expect(screen.getByText(product.cachedProjection.desktopName)).toBeTruthy()
    expect(product.cacheInstances.every(cache => !cache.clearContent.mock.calls.length
      && !cache.destroy.mock.calls.length)).toBe(true)
  })

  it('starts Snow IK for the selected pairing selector in the initial Relay ready projection', async () => {
    const product = await mountSelectedDesktopProduct('right-initial')

    await expect(relayLifecycle.onPeerAttachments?.(relayPeerProjection(
      'ready', product.databaseIdentity, 'home', 1,
    ))).resolves.toBeUndefined()

    expect(snowAttachmentOwners.selectors).toEqual(['home'])
    expect(snowAttachmentOwners.begin).toHaveBeenCalledOnce()
    expect(relayLifecycle.sendCiphertext).toHaveBeenCalledWith(
      parseRelayAttachmentId('desktop-home'), Uint8Array.of(1),
    )
  })

  it.each([
    ['COMPANION_UPDATE_REQUIRED', 'mobile', 'Update Mobile to connect to this Desktop.'],
    ['COMPANION_UPDATE_REQUIRED', 'desktop', 'Update Desktop to connect from this Mobile.'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'mobile', 'Update Mobile to connect to this Desktop.'],
    ['COMPANION_SECURITY_CAPABILITY_MISSING', 'desktop', 'Update Desktop to connect from this Mobile.'],
  ] as const)('projects a %s requirement for %s through the shipped entry', async (code, endpoint, expected) => {
    await mountSelectedDesktopProduct(`${code}-${endpoint}`)

    relayLifecycle.onTransportError?.(new RemoteProtocolError(
      code, `${endpoint} update required`, endpoint,
    ))

    expect((await screen.findByRole('alert')).textContent).toBe(expected)
  })

  it('projects Platform capacity through the shipped entry while retrying', async () => {
    await mountSelectedDesktopProduct('capacity')

    relayLifecycle.onTransportError?.(new RemoteRelayError(
      'PLATFORM_CAPACITY', 'Remote Relay returned PLATFORM_CAPACITY', 5_000,
    ))

    expect((await screen.findByRole('alert')).textContent).toBe('Platform capacity is full. Retrying in 5 seconds.')
  })
})

function configureEnvironment(overrides: Record<string, string> = {}): void {
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
    ...overrides,
  }
  for (const [key, value] of Object.entries(fields)) vi.stubEnv(key, value)
}

async function mountSelectedDesktopProduct(suffix: string): Promise<{
  databaseIdentity: string
  cachedProjection: MobileCompanionProjectionDto
  cacheInstances: typeof projectionCaches.instances
  runtime: NonNullable<ReturnType<typeof import('../src/companion-lifecycle.ts')['companionRuntime']>>
  companionMayMutate: typeof import('../src/companion-lifecycle.ts')['companionMayMutate']
}> {
  const databaseIdentity = `database-${suffix}`
  const identityNamespace = `namespace-${suffix}`
  const accountId = parsePlatformAccountId(`account-${suffix}`)
  const cachedProjection = emptyProjection(`Cached Desktop ${suffix}`)
  projectionCaches.projection = cachedProjection
  configureEnvironment({
    VITE_PLATFORM_DATABASE_IDENTITY: databaseIdentity,
    VITE_PLATFORM_IDENTITY_NAMESPACE: identityNamespace,
  })
  document.body.innerHTML = '<div id="root"></div>'
  protectedValues.set(`installation:${identityNamespace}`, `installation-${suffix}`)
  protectedValues.set(`pairings:${databaseIdentity}:${accountId}`, JSON.stringify({
    version: 2,
    active: [pairingRecord(databaseIdentity, 'home'), pairingRecord(databaseIdentity, 'work')],
    selectedPairingId: 'home',
  }))
  const account = {
    id: accountId,
    githubId: 583_231,
    githubLogin: `fixture-${suffix}`,
    avatarUrl: `https://avatars.example/${suffix}`,
  }
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
  )
  const store = new IndexedDbInstallationAccountStore(
    `deepseek-gestalt-platform-account:${databaseIdentity}`,
  )
  await store.saveSession({
    environment: 'production',
    session: {
      sessionId: `session-${suffix}` as never,
      account,
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      accessExpiresAt: Date.now() + 900_000,
      refreshExpiresAt: Date.now() + 2_592_000_000,
    },
    privateKey: pair.privateKey,
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/v1/account/session')) return json(account)
    return json({ status: 'pending' })
  }))

  const { mobileProductStarted } = await import('../src/main.tsx')
  await mobileProductStarted
  await screen.findByText(`@fixture-${suffix}`)
  await waitFor(() => {
    expect(relayLifecycle.configure).toHaveBeenCalledWith(expect.objectContaining({ pairingSelector: 'home' }))
  })
  await screen.findByText(cachedProjection.desktopName)
  const lifecycle = await import('../src/companion-lifecycle.ts')
  const runtime = lifecycle.companionRuntime()
  if (runtime === undefined) throw new Error('expected Companion runtime')
  return {
    databaseIdentity,
    cachedProjection,
    cacheInstances: [...projectionCaches.instances],
    runtime,
    companionMayMutate: lifecycle.companionMayMutate,
  }
}

function pairingRecord(databaseIdentity: string, pairingId: 'home' | 'work'): Record<string, unknown> {
  return {
    pairingId,
    attachmentKey: bytesBase64(32, pairingId === 'home' ? 1 : 2),
    reconnectState: bytesBase64(96, pairingId === 'home' ? 3 : 4),
    grant: {
      routeId: `route-${databaseIdentity}-${pairingId}`,
      endpoint: 'mobile',
      credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      revision: 1,
      pairingSelector: pairingId,
    },
  }
}

function bytesBase64(length: number, value: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(value)))
}

function relayPeerProjection(
  type: 'ready' | 'peer-update',
  databaseIdentity: string,
  pairingId: 'home' | 'work',
  generation: number,
): Record<string, unknown> & { peers: readonly unknown[] } {
  return {
    type,
    transportVersion: 1,
    routeId: parseRelayRouteId(`route-${databaseIdentity}-home`),
    attachmentId: parseRelayAttachmentId(`mobile-${databaseIdentity}`),
    peers: [{
      attachmentId: parseRelayAttachmentId(`desktop-${pairingId}`),
      pairingSelector: parseRelayPairingSelector(pairingId),
      generation,
    }],
  }
}

function emptyProjection(desktopName: string): MobileCompanionProjectionDto {
  return {
    type: 'desktop-resync', version: 1, authenticated: true, desktopName,
    sessions: {
      ids: [], byId: {}, current: null, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: null,
    },
    workspaces: [],
    conversations: [],
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
