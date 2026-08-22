import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import {
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  RemoteAccessError,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  type MobilePairingStatus,
  type EndpointPairingMobileView,
  type PairingAccountAuthentication,
} from '@deepseek-ai/dsh-remote-access'
import {
  RemoteAccessHttpTransport,
  type RemoteAccessTransport,
} from '@deepseek-ai/dsh-remote-access-client'
import { MobilePairingController } from '../../../../apps/mobile/src/personal-pairing.ts'
import { apply } from '../src/index.ts'

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const closeServers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

describe('Remote Access HTTP assembled flow', () => {
  it('runs the signed-in Desktop and Mobile controller transport through ctx.remoteAccess', async () => {
    const ctx = new Context()
    const handshake = {
      createChallenge: vi.fn(async () => ({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })),
      completeChallenge: vi.fn(async () => ({
        handshakeHash: new Uint8Array(32),
        desktopHandshake: Uint8Array.of(2),
        pendingPairingKey: Uint8Array.of(3),
      })),
      activatePairing: vi.fn(async () => ({
        keyReference: 'key-one' as never,
        activePairingKey: Uint8Array.of(6),
      })),
      destroyChallenge: vi.fn(),
      destroyPendingPairing: vi.fn(),
      destroyPairing: vi.fn(),
    }
    const account = {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => {
        const [accountId, kind, id] = accessToken.split(':') as [string, 'desktop' | 'mobile', string]
        return {
          account: {
            id: accountId as never,
            githubId: 1,
            githubLogin: accountId,
            avatarUrl: 'https://avatars.example/account',
          },
          installation: { id: parseInstallationId(id), kind },
        }
      }),
    }
    const remoteAccess = new PersonalPairingProvider(ctx, {
      account,
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: size => new Uint8Array(size),
      randomId: kind => `${kind}-${crypto.randomUUID()}`,
      pairingLinkOrigin: 'https://platform.example/pair',
    })
    const server = await start(remoteAccess)
    const transport = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: server.origin } as never,
    })
    const desktop = authentication('account-one:desktop:desktop-one')
    const mobile = authentication('account-one:mobile:mobile-one')

    const invalid = await fetch(`${server.origin}/v1/remote-access/personal-pairing`, {
      method: 'POST',
      headers: proofHeaders(desktop),
      body: JSON.stringify({ operation: 'set-mobile-access', enabled: 'true' }),
    })
    expect(invalid.status).toBe(400)
    expect(account.currentInstallation).not.toHaveBeenCalled()

    const malformedOrigin = await fetch(`${server.origin}/v1/remote-access/personal-pairing`, {
      method: 'POST',
      headers: { ...proofHeaders(desktop), Origin: 'not a URL' },
      body: JSON.stringify({ operation: 'get-mobile-access' }),
    })
    expect(malformedOrigin.status).toBe(403)
    expect(account.currentInstallation).not.toHaveBeenCalled()

    const leakedInvitation = await fetch(`${server.origin}/v1/remote-access/personal-pairing`, {
      method: 'POST',
      headers: proofHeaders(desktop),
      body: JSON.stringify({
        operation: 'create-endpoint-challenge', rendezvousId: 'rendezvous-endpoint',
        expiresAt: Date.now() + 60_000, invitationPayload: Buffer.alloc(32, 7).toString('base64url'),
      }),
    })
    expect(leakedInvitation.status).toBe(400)
    expect(account.currentInstallation).not.toHaveBeenCalled()

    await transport.setMobileAccess({ authentication: desktop, enabled: true })
    const challenge = await transport.createChallenge({
      authentication: desktop,
      rendezvousId: parsePairingRendezvousId('rendezvous-one'),
    })
    const pending = await transport.completeChallenge({
      authentication: mobile,
      completionId: parsePairingCompletionId('completion-one'),
      oneTimeLink: challenge.oneTimeLink,
      device: { name: 'Alice phone', platform: 'ios' },
      mobileHandshake: Uint8Array.of(9),
    })
    expect(await transport.getMobilePairingStatus({
      authentication: mobile,
      pendingPairingId: pending.pendingPairingId,
    })).toEqual({ status: 'pending' })
    expect(await transport.listPendingPairings(desktop)).toEqual([pending])
    await transport.confirmPairing({ authentication: desktop, pendingPairingId: pending.pendingPairingId })
    expect(await transport.getMobilePairingStatus({
      authentication: mobile,
      pendingPairingId: pending.pendingPairingId,
    })).toMatchObject({ status: 'paired' })
    expect(await transport.listPersonalPairings(desktop)).toMatchObject([{
      device: { name: 'Alice phone' },
      devicePrincipal: { installationId: 'mobile-one', authority: 'companion-surface' },
    }])
  })

  it('retries the identical Mobile attempt after a committed HTTP response is lost', async () => {
    const ctx = new Context()
    const handshake = {
      createChallenge: vi.fn(async () => ({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })),
      completeChallenge: vi.fn(async () => ({
        handshakeHash: new Uint8Array(32),
        desktopHandshake: Uint8Array.of(2),
        pendingPairingKey: Uint8Array.of(3),
      })),
      activatePairing: vi.fn(async () => ({
        keyReference: 'key-one' as never,
        activePairingKey: Uint8Array.of(6),
      })),
      destroyChallenge: vi.fn(),
      destroyPendingPairing: vi.fn(),
      destroyPairing: vi.fn(),
    }
    const account = {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => {
        const [accountId, kind, id] = accessToken.split(':') as [string, 'desktop' | 'mobile', string]
        return {
          account: {
            id: accountId as never,
            githubId: 1,
            githubLogin: accountId,
            avatarUrl: 'https://avatars.example/account',
          },
          installation: { id: parseInstallationId(id), kind },
        }
      }),
    }
    const remoteAccess = new PersonalPairingProvider(ctx, {
      account,
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: size => new Uint8Array(size),
      randomId: kind => `${kind}-${crypto.randomUUID()}`,
      pairingLinkOrigin: 'https://platform.example/pair',
    })
    const server = await start(remoteAccess)
    const http = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: server.origin } as never,
    })
    const desktop = authentication('account-one:desktop:desktop-one')
    const mobile = authentication('account-one:mobile:mobile-one')
    await http.setMobileAccess({ authentication: desktop, enabled: true })
    const challenge = await http.createChallenge({
      authentication: desktop,
      rendezvousId: parsePairingRendezvousId('mobile-retry'),
    })
    const requests: unknown[] = []
    let loseResponse = true
    const transport: RemoteAccessTransport = {
      getMobileAccessState: http.getMobileAccessState.bind(http),
      setMobileAccess: http.setMobileAccess.bind(http),
      reissueDesktopRelayAuthority: http.reissueDesktopRelayAuthority.bind(http),
      createChallenge: http.createChallenge.bind(http),
      createEndpointChallenge: http.createEndpointChallenge.bind(http),
      cancelEndpointChallenge: http.cancelEndpointChallenge.bind(http),
      listEndpointPending: http.listEndpointPending.bind(http),
      submitEndpointMessage2: http.submitEndpointMessage2.bind(http),
      confirmEndpointPairing: http.confirmEndpointPairing.bind(http),
      rejectEndpointPairing: http.rejectEndpointPairing.bind(http),
      deliverEndpointRelayAuthority: http.deliverEndpointRelayAuthority.bind(http),
      cancelChallenge: http.cancelChallenge.bind(http),
      listPendingPairings: http.listPendingPairings.bind(http),
      listPersonalPairings: http.listPersonalPairings.bind(http),
      confirmPairing: http.confirmPairing.bind(http),
      rejectPairing: http.rejectPairing.bind(http),
      revokePersonalPairing: http.revokePersonalPairing.bind(http),
      getMobilePairingStatus: http.getMobilePairingStatus.bind(http),
      finishChallenge: http.finishChallenge.bind(http),
      submitEndpointMessage1: http.submitEndpointMessage1.bind(http),
      getEndpointPairingStatus: http.getEndpointPairingStatus.bind(http),
      submitEndpointMessage3: http.submitEndpointMessage3.bind(http),
      completeChallenge: async (request) => {
        requests.push(request)
        const result = await http.completeChallenge(request)
        if (loseResponse) {
          loseResponse = false
          throw new Error('committed response was lost')
        }
        return result
      },
    }
    const mobileHandshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('mobile-controller-retry'),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation: {
        authorizeCurrentInstallation: vi.fn(async () => mobile),
        getSnapshot: vi.fn(() => ({
          status: 'signed-in' as const,
          privacyAccepted: true,
          account: {
            id: 'account-one' as never,
            githubId: 1,
            githubLogin: 'account-one',
            avatarUrl: 'https://avatars.example/account',
          },
        })),
      },
      transport,
      handshake: mobileHandshake,
      scanner: { scan: vi.fn() },
      device: { name: 'Alice phone', platform: 'ios' },
      schedule: () => ({ unref: vi.fn() }) as never,
    })

    await expect(controller.completeLink(challenge.oneTimeLink)).rejects.toThrow('committed response was lost')
    await controller.retryPairing()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(mobileHandshake.begin).toHaveBeenCalledOnce()
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
    const [pending] = await http.listPendingPairings(desktop)
    if (pending === undefined) throw new Error('expected committed pending pairing')
    await http.confirmPairing({ authentication: desktop, pendingPairingId: pending.pendingPairingId })
    expect(await http.listPersonalPairings(desktop)).toHaveLength(1)
    expect(handshake.activatePairing).toHaveBeenCalledOnce()
  })

  it('validates every process-boundary field before dispatch and maps service failures', async () => {
    const remoteAccess = {
      getMobileAccessState: vi.fn(async () => ({ enabled: true })),
      setMobileAccess: vi.fn(async () => ({ enabled: true })),
      createChallenge: vi.fn(async (_input: { clientIp: string }) => ({
        challengeId: 'challenge-one', desktopStaticPublicKey: Uint8Array.of(1),
      })),
      cancelChallenge: vi.fn(),
      listPendingPairings: vi.fn(async () => []),
      listPersonalPairings: vi.fn(async () => []),
      getMobilePairingStatus: vi.fn(async (): Promise<MobilePairingStatus> => ({ status: 'pending' })),
      confirmPairing: vi.fn(async () => ({ id: 'pairing-one' })),
      rejectPairing: vi.fn(),
      reissueDesktopRelayAuthority: vi.fn(async () => ({ enabled: true })),
      revokePersonalPairing: vi.fn(),
      completeChallenge: vi.fn(async () => ({
        pendingPairingId: 'pending-one', authenticationWords: [], desktopHandshake: Uint8Array.of(1),
        device: { name: 'phone', platform: 'ios' },
      })),
      admitAttachmentBlob: vi.fn(async () => ({ reservationId: 'blob-1' })),
      releaseAttachmentBlob: vi.fn(),
      createEndpointChallenge: vi.fn(async () => ({
        challengeId: 'endpoint-challenge', expiresAt: 123,
        routingLink: 'https://platform.example/pair?challenge=endpoint-challenge',
      })),
      cancelEndpointChallenge: vi.fn(),
      listEndpointPending: vi.fn(async () => [
        { stage: 'message1', pendingPairingId: 'pending-message1', challengeId: 'endpoint-challenge',
          message1: Uint8Array.of(1), device: { name: 'One', platform: 'ios' } },
        { stage: 'message3', pendingPairingId: 'pending-message3', challengeId: 'endpoint-challenge',
          message1: Uint8Array.of(1), message2: Uint8Array.of(2), message3: Uint8Array.of(3),
          device: { name: 'Two', platform: 'android' } },
        { stage: 'confirmed', pendingPairingId: 'pending-confirmed', challengeId: 'endpoint-challenge',
          device: { name: 'Three', platform: 'ios' } },
      ]),
      rejectEndpointPairing: vi.fn(),
      getEndpointPairingStatus: vi.fn(async (): Promise<EndpointPairingMobileView> => ({
        stage: 'message2', pendingPairingId: parsePendingPairingId('pending-message2'), message2: Uint8Array.of(2),
      })),
      finishChallenge: vi.fn(async () => ({
        pendingPairingId: 'pending-one', authenticationWords: [], desktopHandshake: Uint8Array.of(1),
        device: { name: 'phone', platform: 'ios' },
      })),
    }
    const server = await start(remoteAccess as never)
    const auth = authentication('account-one:desktop:desktop-one')
    const endpoint = `${server.origin}/v1/remote-access/personal-pairing`
    const request = (body: unknown, options: { method?: string; headers?: Record<string, string>; raw?: string } = {}) => {
      const method = options.method ?? 'POST'
      return fetch(endpoint, {
        method,
        headers: { ...proofHeaders(auth), ...options.headers },
        ...(method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
      })
    }

    expect((await request({ operation: 'get-mobile-access' })).status).toBe(200)
    expect((await request({ operation: 'reissue-desktop-relay' })).status).toBe(200)
    expect((await request({ operation: 'cancel-challenge', challengeId: 'challenge-one' })).status).toBe(200)
    expect((await request({
      operation: 'create-endpoint-challenge', rendezvousId: 'endpoint-rendezvous', expiresAt: 123,
    })).status).toBe(200)
    expect((await request({
      operation: 'create-endpoint-challenge', rendezvousId: 'endpoint-rendezvous', expiresAt: 0,
    })).status).toBe(400)
    expect((await request({
      operation: 'cancel-endpoint-challenge', challengeId: 'endpoint-challenge',
    })).status).toBe(200)
    const endpointPending = await request({ operation: 'list-endpoint-pending' })
    await expect(endpointPending.json()).resolves.toMatchObject([
      { stage: 'message1', message1: 'AQ' },
      { stage: 'message3', message1: 'AQ', message2: 'Ag', message3: 'Aw' },
      { stage: 'confirmed' },
    ])
    expect((await request({
      operation: 'reject-endpoint-pairing', pendingPairingId: 'pending-one',
    })).status).toBe(200)
    expect((await request({
      operation: 'confirm-endpoint-pairing', pendingPairingId: 'pending-one',
      desktopCredentialDigest: 'AQ', mobileCredentialDigest: 'Ag',
    })).status).toBe(500)
    const endpointMessage2 = await request({
      operation: 'get-endpoint-pairing-status', completionId: 'completion-one',
    })
    await expect(endpointMessage2.json()).resolves.toMatchObject({ stage: 'message2', message2: 'Ag' })
    remoteAccess.getEndpointPairingStatus.mockResolvedValueOnce({
      stage: 'confirmed', pendingPairingId: parsePendingPairingId('pending-one'),
      pairingId: parsePersonalPairingId('pairing-one'),
      sealedRelayAuthority: Uint8Array.of(3),
    })
    const endpointConfirmed = await request({
      operation: 'get-endpoint-pairing-status', completionId: 'completion-one',
    })
    await expect(endpointConfirmed.json()).resolves.toMatchObject({ stage: 'confirmed', sealedRelayAuthority: 'Aw' })
    remoteAccess.getEndpointPairingStatus.mockResolvedValueOnce({
      stage: 'awaiting-desktop', pendingPairingId: parsePendingPairingId('pending-one'),
    })
    const endpointWaiting = await request({
      operation: 'get-endpoint-pairing-status', completionId: 'completion-one',
    })
    await expect(endpointWaiting.json()).resolves.toMatchObject({ stage: 'awaiting-desktop' })
    expect((await request({
      operation: 'finish-challenge', pendingPairingId: 'pending-one', mobileFinish: 'AQ',
    })).status).toBe(200)
    expect((await request({ operation: 'admit-blob', bytes: 4 })).status).toBe(200)
    expect(remoteAccess.admitAttachmentBlob).toHaveBeenCalledWith(expect.objectContaining({ bytes: 4 }))
    expect((await request({ operation: 'admit-blob', bytes: 'x' })).status).toBe(400)
    expect((await request({ operation: 'admit-blob', bytes: -1 })).status).toBe(400)
    expect((await request({ operation: 'release-blob', reservationId: 'blob-1' })).status).toBe(200)
    expect((await request({ operation: 'release-blob', reservationId: '' })).status).toBe(400)
    expect((await request({ operation: 'create-challenge', rendezvousId: 'rendezvous-one' })).status).toBe(200)
    expect(remoteAccess.createChallenge.mock.calls.at(-1)?.[0].clientIp).toMatch(/127\.0\.0\.1|::1/u)
    expect((await request({ operation: 'create-challenge', rendezvousId: 'forwarded' }, {
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    })).status).toBe(200)
    expect(remoteAccess.createChallenge.mock.calls.at(-1)?.[0].clientIp).toMatch(/127\.0\.0\.1|::1/u)
    expect((await request({ operation: 'revoke-pairing', pairingId: 'pairing-one' })).status).toBe(200)
    expect((await request({ operation: 'reject-pairing', pendingPairingId: 'pending-one' })).status).toBe(200)
    remoteAccess.getMobilePairingStatus.mockResolvedValueOnce({
      status: 'paired', pairingId: parsePersonalPairingId('pairing-one'), sealedRelayAuthority: Uint8Array.of(1, 2),
    })
    await expect((await request({
      operation: 'get-mobile-pairing-status', pendingPairingId: 'pending-one',
    })).json()).resolves.toEqual({
      status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority: 'AQI',
    })
    expect((await request({ operation: 'unknown' })).status).toBe(400)
    expect((await request({}, { method: 'GET' })).status).toBe(405)

    const preflight = await request({}, { method: 'OPTIONS', headers: { Origin: 'https://mobile.example' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://mobile.example')
    expect((await request({ operation: 'get-mobile-access' }, {
      headers: { Origin: 'https://mobile.example/path' },
    })).status).toBe(200)
    expect((await request({ operation: 'get-mobile-access' }, {
      headers: { Origin: 'https://attacker.example' },
    })).status).toBe(403)

    for (const authorization of ['', 'Bearer ', 'Basic token']) {
      expect((await request({ operation: 'get-mobile-access' }, {
        headers: { authorization },
      })).status).toBe(401)
    }
    const invalidProofHeaders: ReadonlyArray<readonly [string, string]> = [
      ['x-gestalt-proof-jti', ''],
      ['x-gestalt-proof-issued-at', 'not-a-number'],
      ['x-gestalt-proof-issued-at', '0'],
      ['x-gestalt-proof-signature', ''],
    ]
    for (const [name, value] of invalidProofHeaders) {
      expect((await request({ operation: 'get-mobile-access' }, {
        headers: { [name]: value },
      })).status).toBe(400)
    }

    expect((await request(null, { raw: 'not-json' })).status).toBe(400)
    expect((await request([])).status).toBe(400)
    expect((await request({ operation: '' })).status).toBe(400)
    expect((await request({ operation: 'set-mobile-access', enabled: 'true' })).status).toBe(400)
    expect((await request({ operation: 'create-challenge', rendezvousId: '' })).status).toBe(500)
    expect((await request({ operation: 'cancel-challenge', challengeId: '' })).status).toBe(500)
    expect((await request({ operation: 'get-mobile-pairing-status', pendingPairingId: '' })).status).toBe(500)
    expect((await request({ operation: 'confirm-pairing', pendingPairingId: '' })).status).toBe(500)
    expect((await request({ operation: 'reject-pairing', pendingPairingId: '' })).status).toBe(500)

    const complete = (extra: Record<string, unknown>) => request({
      operation: 'complete-challenge',
      completionId: 'completion-one',
      oneTimeLink: 'https://platform.example/pair#invitation',
      device: { name: 'phone', platform: 'ios' },
      mobileHandshake: 'AQ',
      ...extra,
    })
    expect((await complete({ completionId: '' })).status).toBe(500)
    expect((await complete({ oneTimeLink: '' })).status).toBe(400)
    expect((await complete({ device: null })).status).toBe(400)
    expect((await complete({ device: { name: 'phone', platform: 'windows' } })).status).toBe(400)
    expect((await complete({ device: { name: '', platform: 'ios' } })).status).toBe(400)
    expect((await complete({ mobileHandshake: '' })).status).toBe(400)
    expect((await complete({ mobileHandshake: '*' })).status).toBe(400)
    expect((await complete({ mobileHandshake: 'A' })).status).toBe(400)
    expect((await complete({ mobileHandshake: 'AB' })).status).toBe(400)
    expect((await complete({})).status).toBe(200)
    expect(remoteAccess.completeChallenge).toHaveBeenCalledWith(expect.objectContaining({
      mobileHandshake: Uint8Array.of(1),
    }))

    expect((await request({ operation: 'get-mobile-access' }, {
      raw: JSON.stringify({ operation: 'get-mobile-access', padding: 'x'.repeat(65 * 1024) }),
    })).status).toBe(413)

    remoteAccess.getMobileAccessState.mockRejectedValueOnce(
      new RemoteAccessError('PAIRING_CHALLENGE_USED', 'used'),
    )
    expect((await request({ operation: 'get-mobile-access' })).status).toBe(409)
    remoteAccess.getMobileAccessState.mockRejectedValueOnce(
      new RemoteAccessError('QUOTA', 'full', 60),
    )
    const quota = await request({ operation: 'get-mobile-access' })
    expect(quota.status).toBe(429)
    expect(quota.headers.get('retry-after')).toBe('60')
    await expect(quota.json()).resolves.toMatchObject({ error: { code: 'QUOTA', retryAfter: 60 } })
    remoteAccess.getMobileAccessState.mockRejectedValueOnce(new Error('boom'))
    const internal = await request({ operation: 'get-mobile-access' })
    expect(internal.status).toBe(500)
    await expect(internal.json()).resolves.toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
  })

  it('fails loud when the configured browser origin is not a URL', () => {
    expect(() => { apply({} as Context, { origin: 'not a URL' }) }).toThrow()
  })

  it('accepts non-Buffer byte chunks from the process request stream', async () => {
    let route: RegisteredRoute | undefined
    const ctx = {
      remoteAccess: { getMobileAccessState: vi.fn(async () => ({ enabled: false })) },
      webServer: { register(value: RegisteredRoute) { route = value; return () => {} } },
      effect(register: () => () => void) { register() },
    } as unknown as Context
    apply(ctx, { origin: 'https://mobile.example' })
    const response = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() }
    const body = new TextEncoder().encode(JSON.stringify({ operation: 'get-mobile-access' }))
    const request = {
      method: 'POST',
      headers: proofHeaders(authentication('account-one:desktop:desktop-one')),
      async *[Symbol.asyncIterator]() { yield body },
    }
    if (route === undefined) throw new Error('Remote Access route was not registered')
    await route.handler(request as never, response as never)
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })

  it('rejects a Pairing Challenge when the TCP socket has no client IP', async () => {
    let route: RegisteredRoute | undefined
    const createChallenge = vi.fn()
    const ctx = {
      remoteAccess: { createChallenge },
      webServer: { register(value: RegisteredRoute) { route = value; return () => {} } },
      effect(register: () => () => void) { register() },
    } as unknown as Context
    apply(ctx, { origin: 'https://mobile.example' })
    const chunks: Buffer[] = []
    const response = {
      writeHead: vi.fn(),
      end: (value?: string) => { if (value !== undefined) chunks.push(Buffer.from(value)) },
      setHeader: vi.fn(),
    }
    const body = new TextEncoder().encode(JSON.stringify({
      operation: 'create-challenge', rendezvousId: 'rendezvous-one',
    }))
    const request = {
      method: 'POST',
      headers: proofHeaders(authentication('account-one:desktop:desktop-one')),
      socket: {},
      async *[Symbol.asyncIterator]() { yield body },
    }
    if (route === undefined) throw new Error('Remote Access route was not registered')
    await route.handler(request as never, response as never)
    expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({
      error: { code: 'CLIENT_IP_REQUIRED' },
    })
    expect(createChallenge).not.toHaveBeenCalled()
  })
})

function authentication(accessToken: string): PairingAccountAuthentication {
  return {
    accessToken,
    proof: { jti: parseAccountProofJti(crypto.randomUUID()), issuedAt: 1, signature: 'signature' },
  }
}

function proofHeaders(authentication: PairingAccountAuthentication): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${authentication.accessToken}`,
    'x-gestalt-proof-jti': authentication.proof.jti,
    'x-gestalt-proof-issued-at': String(authentication.proof.issuedAt),
    'x-gestalt-proof-signature': authentication.proof.signature,
  }
}

async function start(remoteAccess: PersonalPairingProvider): Promise<{ origin: string }> {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = {
    remoteAccess,
    webServer: {
      register(route: RegisteredRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(ctx, { origin: 'https://mobile.example' })
  const http = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (route === undefined) { res.writeHead(404).end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Remote Access test server did not bind')
  closeServers.push(async () => { await new Promise<void>((resolve, reject) => {
    http.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }) })
  return { origin: `http://127.0.0.1:${String(address.port)}` }
}
