import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti } from '@deepseek-ai/dsh-platform-account'
import {
  RemoteAccessError,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import { RemoteAccessHttpTransport } from '../src/index.ts'

const authentication = {
  accessToken: 'access-token',
  proof: { jti: parseAccountProofJti('proof-jti'), issuedAt: 123, signature: 'signature' },
}

afterEach(() => { vi.unstubAllGlobals() })

const challenge = {
  challengeId: 'challenge-one',
  desktopFingerprint: 'desktop-fingerprint',
  rendezvousId: 'rendezvous-one',
  expiresAt: 123,
  protocolMajor: 1,
  oneTimeLink: 'https://platform.example/pair#invitation',
  qrPayload: 'https://platform.example/pair#invitation',
}

const completion = {
  pendingPairingId: 'pending-one',
  authenticationWords: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
  desktopHandshake: 'AQI',
  device: { name: 'Alice phone', platform: 'ios' },
}

const pairing = {
  id: 'pairing-one',
  devicePrincipal: {
    id: 'principal-one', accountId: 'account-one', installationId: 'installation-one',
    authority: 'companion-surface',
  },
  device: { name: 'Alice phone', platform: 'android' },
  pairedAt: 123,
  lastAccessAt: 123,
  online: false,
}

function transport(value: unknown, status = 200): { client: RemoteAccessHttpTransport; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  }))
  return {
    client: new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
      fetch,
    }),
    fetch,
  }
}

describe('RemoteAccessHttpTransport', () => {
  it('uses the global Fetch implementation by default', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ enabled: false })))
    vi.stubGlobal('fetch', fetch)
    const client = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
    })
    await expect(client.getMobileAccessState(authentication)).resolves.toEqual({ enabled: false })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps the default Fetch implementation callable after method extraction', async () => {
    const impl = {
      async fetch(this: unknown) {
        if (this == null) throw new TypeError('Illegal invocation')
        return new Response(JSON.stringify({ enabled: false }))
      },
    }
    vi.stubGlobal('fetch', impl.fetch.bind(impl))
    const client = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
    })
    await expect(client.getMobileAccessState(authentication)).resolves.toEqual({ enabled: false })
  })

  it('serializes every Desktop and Mobile operation and parses their public results', async () => {
    const replies = [
      { enabled: false }, {
        enabled: true,
        relay: {
          routeId: 'route-one', endpoint: 'desktop', credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 1,
        },
      }, {
        enabled: true,
        relay: {
          routeId: 'route-one', endpoint: 'desktop', credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 2,
        },
      }, challenge, {}, [completion], [pairing], {}, pairing, {}, {}, completion,
      { status: 'pending' }, { status: 'rejected' }, {
        status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority: 'AQI',
      }, {},
    ]
    const fetch = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => new Response(JSON.stringify(replies.shift()), { status: 200 }))
    const client = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
      fetch,
    })
    const rendezvousId = parsePairingRendezvousId('rendezvous-one')
    const challengeId = parsePairingChallengeId('challenge-one')
    const pendingPairingId = parsePendingPairingId('pending-one')

    await expect(client.getMobileAccessState(authentication)).resolves.toEqual({ enabled: false })
    await expect(client.setMobileAccess({ authentication, enabled: true })).resolves.toMatchObject({
      enabled: true, relay: { routeId: 'route-one', endpoint: 'desktop', revision: 1 },
    })
    await expect(client.reissueDesktopRelayAuthority(authentication)).resolves.toMatchObject({
      enabled: true, relay: { routeId: 'route-one', endpoint: 'desktop', revision: 2 },
    })
    await expect(client.createChallenge({ authentication, rendezvousId })).resolves.toMatchObject(challenge)
    await expect(client.cancelChallenge({ authentication, challengeId })).resolves.toBeUndefined()
    await expect(client.listPendingPairings(authentication)).resolves.toMatchObject([{
      pendingPairingId: 'pending-one', desktopHandshake: Uint8Array.of(1, 2),
    }])
    await expect(client.listPersonalPairings(authentication)).resolves.toMatchObject([pairing])
    await expect(client.revokePersonalPairing({
      authentication, pairingId: parsePersonalPairingId('pairing-one'),
    })).resolves.toBeUndefined()
    await expect(client.confirmPairing({ authentication, pendingPairingId })).resolves.toMatchObject(pairing)
    await expect(client.revokePersonalPairing({
      authentication, pairingId: parsePersonalPairingId('pairing-one'),
    })).resolves.toBeUndefined()
    await expect(client.rejectPairing({ authentication, pendingPairingId })).resolves.toBeUndefined()
    await expect(client.completeChallenge({
      authentication,
      completionId: parsePairingCompletionId('completion-one'),
      oneTimeLink: challenge.oneTimeLink,
      device: { name: 'Alice phone', platform: 'ios' },
      mobileHandshake: Uint8Array.of(1, 2),
    })).resolves.toMatchObject({ desktopHandshake: Uint8Array.of(1, 2) })
    await expect(client.getMobilePairingStatus({ authentication, pendingPairingId })).resolves.toEqual({ status: 'pending' })
    await expect(client.getMobilePairingStatus({ authentication, pendingPairingId })).resolves.toEqual({ status: 'rejected' })
    await expect(client.getMobilePairingStatus({ authentication, pendingPairingId })).resolves.toEqual({
      status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority: Uint8Array.of(1, 2),
    })
    await expect(client.unregisterPushToken({
      authentication,
      routeId: parseRelayRouteId('route-one'),
      token: 'device-token' as never,
    })).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledTimes(16)
    const first = vi.mocked(fetch).mock.calls[0]
    expect(first?.[0]).toBe('https://platform.example/v1/remote-access/personal-pairing')
    expect(first?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'X-Gestalt-Proof-Jti': 'proof-jti',
        'X-Gestalt-Proof-Issued-At': '123',
        'X-Gestalt-Proof-Signature': 'signature',
      },
    })
    const completionBody = vi.mocked(fetch).mock.calls[11]?.[1]?.body
    if (typeof completionBody !== 'string') throw new TypeError('completion request body must be a string')
    expect(JSON.parse(completionBody)).toMatchObject({
      operation: 'complete-challenge', mobileHandshake: 'AQI',
    })
  })

  it('preserves known service errors and rejects malformed HTTP failures', async () => {
    const known = transport({ error: { code: 'PAIRING_CHALLENGE_USED', message: 'used' } }, 409).client
    await expect(known.getMobileAccessState(authentication)).rejects.toEqual(
      new RemoteAccessError('PAIRING_CHALLENGE_USED', 'used'),
    )
    const quota = transport({ error: { code: 'QUOTA', message: 'full', retryAfter: 60 } }, 429).client
    await expect(quota.getMobileAccessState(authentication)).rejects.toMatchObject({
      code: 'QUOTA', retryAfter: 60,
    })
    const capacity = transport(
      { error: { code: 'PLATFORM_CAPACITY', message: 'shed', retryAfter: 5 } },
      429,
    ).client
    await expect(capacity.getMobileAccessState(authentication)).rejects.toMatchObject({
      code: 'PLATFORM_CAPACITY', retryAfter: 5,
    })
    const invalidRetry = transport({ error: { code: 'QUOTA', message: 'full', retryAfter: 1.5 } }, 429).client
    await expect(invalidRetry.getMobileAccessState(authentication)).rejects.toMatchObject({
      code: 'QUOTA', retryAfter: undefined,
    })
    await expect(transport({
      enabled: true,
      relay: {
        routeId: 'route-one', endpoint: 'other', credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 1,
      },
    }).client.setMobileAccess({ authentication, enabled: true })).rejects.toThrow('must be mobile or desktop')
    await expect(transport([{ ...pairing, online: 1 }]).client.listPersonalPairings(authentication))
      .rejects.toThrow('must be a boolean')

    for (const body of [
      { error: { code: 'UNKNOWN', message: 'no' } },
      { error: { code: 'PAIRING_CHALLENGE_USED' } },
      { error: 'invalid' },
      null,
    ]) {
      await expect(transport(body, 409).client.getMobileAccessState(authentication))
        .rejects.toThrow('Remote Access request failed with HTTP 409')
    }

    const invalidSuccess = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
      fetch: vi.fn(async () => new Response('not-json', { status: 200 })),
    })
    await expect(invalidSuccess.getMobileAccessState(authentication)).rejects.toThrow('must be JSON')
    const invalidFailure = new RemoteAccessHttpTransport({
      environment: { environment: 'development', origin: 'https://platform.example' } as never,
      fetch: vi.fn(async () => new Response('not-json', { status: 500 })),
    })
    await expect(invalidFailure.getMobileAccessState(authentication)).rejects.toThrow('HTTP 500')
  })

  it.each([
    [null, 'Mobile Access response must be an object'],
    [{ enabled: 'yes' }, 'Mobile Access enabled must be boolean'],
  ])('rejects an invalid Mobile Access response %#', async (value, message) => {
    await expect(transport(value).client.getMobileAccessState(authentication)).rejects.toThrow(message)
  })

  it('rejects an enabled Mobile Access grant whose Relay endpoint is neither mobile nor desktop', async () => {
    await expect(transport({
      enabled: true,
      relay: {
        routeId: 'route-one', endpoint: 'relay', credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', revision: 1,
      },
    }).client.getMobileAccessState(authentication)).rejects.toThrow('must be mobile or desktop')
  })

  it.each([
    [null, 'Mobile Pairing status response must be an object'],
    [{ status: 'paired', pairingId: '' }, 'Personal Pairing id'],
    [{ status: 'unknown' }, 'Mobile Pairing status is invalid'],
  ])('rejects an invalid Mobile Pairing status %#', async (value, message) => {
    await expect(transport(value).client.getMobilePairingStatus({
      authentication, pendingPairingId: parsePendingPairingId('pending-one'),
    })).rejects.toThrow(message)
  })

  it('accepts a paired Mobile status without sealed Relay authority', async () => {
    await expect(transport({
      status: 'paired', pairingId: 'pairing-one',
    }).client.getMobilePairingStatus({
      authentication, pendingPairingId: parsePendingPairingId('pending-one'),
    })).resolves.toEqual({ status: 'paired', pairingId: 'pairing-one' })
  })

  it.each([
    [null, 'Pairing Challenge response must be an object'],
    [{ ...challenge, oneTimeLink: '' }, 'oneTimeLink'],
    [{ ...challenge, qrPayload: '' }, 'qrPayload'],
    [{ ...challenge, qrPayload: 'different' }, 'must match'],
    [{ ...challenge, expiresAt: 0 }, 'positive integer'],
    [{ ...challenge, protocolMajor: 2 }, 'unsupported'],
    [{ ...challenge, challengeId: '' }, 'Pairing Challenge id'],
    [{ ...challenge, desktopFingerprint: '' }, 'desktopFingerprint'],
    [{ ...challenge, rendezvousId: '' }, 'Pairing rendezvous id'],
  ])('rejects an invalid Pairing Challenge response %#', async (value, message) => {
    await expect(transport(value).client.createChallenge({
      authentication, rendezvousId: parsePairingRendezvousId('rendezvous-one'),
    })).rejects.toThrow(message)
  })

  it.each([
    [null, 'Pairing completion response must be an object'],
    [{ ...completion, authenticationWords: null }, 'six non-empty'],
    [{ ...completion, authenticationWords: ['a'] }, 'six non-empty'],
    [{ ...completion, authenticationWords: ['a', 'b', 'c', 'd', 'e', ''] }, 'six non-empty'],
    [{ ...completion, pendingPairingId: '' }, 'Pending Pairing id'],
    [{ ...completion, desktopHandshake: null }, 'must be non-empty'],
    [{ ...completion, desktopHandshake: '*' }, 'must be base64url'],
    [{ ...completion, desktopHandshake: 'A' }, 'must be base64url'],
    [{ ...completion, desktopHandshake: 'AB' }, 'canonical base64url'],
    [{ ...completion, device: null }, 'Pairing device must be an object'],
    [{ ...completion, device: { name: 'phone', platform: 'windows' } }, 'platform is invalid'],
    [{ ...completion, device: { name: '', platform: 'ios' } }, 'device name'],
  ])('rejects an invalid Pairing completion response %#', async (value, message) => {
    await expect(transport([value]).client.listPendingPairings(authentication)).rejects.toThrow(message)
  })

  it.each([
    [null, 'Personal Pairing response must be an object'],
    [{ ...pairing, devicePrincipal: null }, 'Device Principal must be an object'],
    [{ ...pairing, devicePrincipal: { ...pairing.devicePrincipal, authority: 'desktop' } }, 'authority is invalid'],
    [{ ...pairing, id: '' }, 'Personal Pairing id'],
    [{ ...pairing, devicePrincipal: { ...pairing.devicePrincipal, id: '' } }, 'Device Principal id'],
    [{ ...pairing, devicePrincipal: { ...pairing.devicePrincipal, accountId: '' } }, 'Platform Account id'],
    [{ ...pairing, devicePrincipal: { ...pairing.devicePrincipal, installationId: '' } }, 'installationId'],
    [{ ...pairing, pairedAt: 0 }, 'positive integer'],
    [{ ...pairing, online: 'yes' }, 'must be a boolean'],
  ])('rejects an invalid Personal Pairing response %#', async (value, message) => {
    await expect(transport([value]).client.listPersonalPairings(authentication)).rejects.toThrow(message)
  })

  it('rejects non-array list responses', async () => {
    await expect(transport({}).client.listPendingPairings(authentication)).rejects.toThrow('must be an array')
  })
})
