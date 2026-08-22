import { describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti } from '@deepseek-ai/dsh-platform-account'
import {
  PAIRING_REPLAY_RETENTION_MS,
  parsePairingCompletionId,
  parsePendingPairingId,
  parsePersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import type { RemoteAccessTransport } from '@deepseek-ai/dsh-remote-access-client'
import { PairingCompanionKeyVault } from '../src/companion-keys.ts'
import { companionMayMutate, CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import { MobilePairingController } from '../src/personal-pairing.ts'

describe('MobilePairingController', () => {
  it('opens pairing-delivered Mobile authority and starts Relay without a Desktop secret', async () => {
    const scheduled: Array<() => void> = []
    const transport = transportFixture()
    const sealedRelayAuthority = Uint8Array.of(7, 8, 9)
    transport.getMobilePairingStatus.mockResolvedValueOnce({
      status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority,
    })
    const mobileGrant = {
      routeId: parseRelayRouteId('mobile-route'),
      endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    }
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('mobile-authority'), mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
      openRelayAuthority: vi.fn(async () => mobileGrant),
    }
    const relay = { configure: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const controller = new MobilePairingController({
      installation: installationFixture(), transport, handshake, relay,
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toEqual({ status: 'paired' }) })

    expect(handshake.openRelayAuthority).toHaveBeenCalledWith(sealedRelayAuthority)
    expect(relay.configure).toHaveBeenCalledWith(mobileGrant)
    expect(relay.start).toHaveBeenCalledOnce()
    await controller.deactivate()
    expect(relay.stop).toHaveBeenCalled()
  })

  it('retains independent pairing key material only after Desktop confirmation', async () => {
    const scheduled: Array<() => void> = []
    const transport = transportFixture()
    const material = Uint8Array.from({ length: 32 }, (_, index) => index + 5)
    const vault = new PairingCompanionKeyVault()
    transport.getMobilePairingStatus.mockResolvedValueOnce({
      status: 'paired', pairingId: parsePersonalPairingId('pairing-key'),
    })
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('retain-key'), mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
      exportPairingKeyMaterial: vi.fn(() => material.slice()),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(), transport, handshake,
      scanner: { scan: vi.fn() },
      pairingKeys: vault,
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })
    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    expect(vault.pairingKeyMaterial(parsePersonalPairingId('pairing-key'))).toBeUndefined()
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toEqual({ status: 'paired' }) })
    expect(vault.pairingKeyMaterial(parsePersonalPairingId('pairing-key'))).toEqual(material)
    await controller.unpair()
    expect(vault.pairingKeyMaterial(parsePersonalPairingId('pairing-key'))).toBeUndefined()
  })

  it('unpairs by wiping local handshake material and stopping Relay', async () => {
    const scheduled: Array<() => void> = []
    const transport = transportFixture()
    transport.getMobilePairingStatus.mockResolvedValueOnce({
      status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority: Uint8Array.of(7),
    })
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('unpair'), mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
      openRelayAuthority: vi.fn(async () => ({
        routeId: parseRelayRouteId('route-unpair'),
        endpoint: 'mobile' as const,
        credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
        revision: 1,
      })),
      wipe: vi.fn(),
    }
    const relay = { configure: vi.fn(), start: vi.fn(), stop: vi.fn(), isConnected: () => false }
    const companion = new CompanionForegroundRuntime({ relay })
    const controller = new MobilePairingController({
      installation: installationFixture(), transport, handshake, relay: companion, companion,
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })
    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toEqual({ status: 'paired' }) })

    await controller.unpair()

    expect(handshake.wipe).toHaveBeenCalledOnce()
    expect(relay.stop).toHaveBeenCalled()
    expect(relay.configure).toHaveBeenCalledWith(undefined)
    expect(companion.getState()).toMatchObject({ socketOpen: false, synchronized: false })
    relay.start.mockClear()
    await companion.setForeground(true)
    expect(relay.start).not.toHaveBeenCalled()
    expect(companionMayMutate(companion.getState())).toBe(false)
    expect(controller.getSnapshot()).toEqual({ status: 'ready' })
  })

  it('attempts every unpair cleanup and reports all authority-release failures', async () => {
    const handshake = {
      begin: vi.fn(),
      acceptDesktopHandshake: vi.fn(),
      wipe: vi.fn(async () => { throw new Error('handshake wipe failed') }),
    }
    const pairingKeys = { retain: vi.fn(), wipe: vi.fn(() => { throw new Error('pairing key wipe failed') }) }
    const companion = {
      forgetConnection: vi.fn(),
      releasePairing: vi.fn(async () => { throw new Error('Companion release failed') }),
    }
    const relay = {
      configure: vi.fn(async () => { throw new Error('Relay revoke failed') }),
      start: vi.fn(),
      stop: vi.fn(async () => { throw new Error('Relay stop failed') }),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport: transportFixture(),
      handshake,
      pairingKeys,
      companion,
      relay,
      scanner: { scan: vi.fn() },
    })

    const failure = await controller.unpair().then(
      () => undefined,
      (error: unknown) => error as AggregateError,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure?.message).toBe('Mobile Personal Pairing unpair failed')
    expect(failure?.errors).toEqual([
      expect.objectContaining({ message: 'handshake wipe failed' }),
      expect.objectContaining({ message: 'pairing key wipe failed' }),
      expect.objectContaining({ message: 'Companion release failed' }),
      expect.objectContaining({ message: 'Relay revoke failed' }),
      expect.objectContaining({ message: 'Relay stop failed' }),
    ])
    expect(handshake.wipe).toHaveBeenCalledOnce()
    expect(pairingKeys.wipe).toHaveBeenCalledOnce()
    expect(companion.releasePairing).toHaveBeenCalledOnce()
    expect(relay.configure).toHaveBeenCalledWith(undefined)
    expect(relay.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({
      status: 'unpair-failed',
      error: 'Mobile Personal Pairing unpair failed',
    })
  })

  it('awaits account-change Companion release and Relay revocation before activation settles', async () => {
    const account = { id: 'account-a' }
    const release = deferred<undefined>()
    const configure = deferred<undefined>()
    const companion = {
      forgetConnection: vi.fn(),
      releasePairing: vi.fn(() => release.promise),
    }
    const relay = { configure: vi.fn(() => configure.promise), start: vi.fn(), stop: vi.fn() }
    const controller = new MobilePairingController({
      installation: installationFixture(() => account.id),
      transport: transportFixture(),
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn() },
      companion,
      relay,
      scanner: { scan: vi.fn() },
    })
    await controller.activate()
    account.id = 'account-b'

    let settled = false
    const activation = controller.activate().then(() => { settled = true })
    await vi.waitFor(() => {
      expect(companion.releasePairing).toHaveBeenCalledOnce()
      expect(relay.configure).toHaveBeenCalledWith(undefined)
    })
    expect(settled).toBe(false)
    release.resolve(undefined)
    configure.resolve(undefined)
    await activation
    expect(settled).toBe(true)
  })

  it.each(['handshake', 'relay'] as const)(
    'fails closed when sealed Mobile authority has no %s lifecycle owner',
    async (missing) => {
      const scheduled: Array<() => void> = []
      const transport = transportFixture()
      transport.getMobilePairingStatus.mockResolvedValueOnce({
        status: 'paired', pairingId: 'pairing-one', sealedRelayAuthority: Uint8Array.of(7),
      })
      const handshake = {
        begin: vi.fn(async () => ({
          completionId: parsePairingCompletionId(`missing-${missing}`), mobileHandshake: Uint8Array.of(9),
        })),
        acceptDesktopHandshake: vi.fn(),
        ...(missing === 'handshake' ? {} : { openRelayAuthority: vi.fn() }),
      }
      const controller = new MobilePairingController({
        installation: installationFixture(), transport, handshake,
        ...(missing === 'relay' ? {} : { relay: { configure: vi.fn(), start: vi.fn(), stop: vi.fn() } }),
        scanner: { scan: vi.fn() },
        schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
        now: () => Date.parse('2026-08-18T10:01:00.000Z'),
      })
      await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))

      scheduled.shift()?.()

      await vi.waitFor(() => {
        expect(controller.getSnapshot()).toEqual({
          status: 'retryable', error: 'Mobile Relay authority has no product lifecycle owner',
        })
      })
    },
  )

  it('keeps Mobile offline and reports Relay shutdown failure during deactivation', async () => {
    const controller = new MobilePairingController({
      installation: installationFixture(), transport: transportFixture(),
      handshake: {
        begin: vi.fn(), acceptDesktopHandshake: vi.fn(),
      },
      relay: {
        configure: vi.fn(), start: vi.fn(), stop: vi.fn(async () => { throw new Error('relay stop failed') }),
      },
      scanner: { scan: vi.fn() },
    })

    await expect(controller.deactivate()).rejects.toMatchObject({
      message: 'Mobile Personal Pairing deactivation failed',
    })
    expect(controller.getSnapshot()).toEqual({ status: 'ready' })
  })

  it('uses the identical full-link completion flow for pasted links and browser-camera QR payloads', async () => {
    const link = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const authorizeCurrentInstallation = vi.fn(async () => ({
      accessToken: 'mobile-access',
      proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
    }))
    const installation = {
      authorizeCurrentInstallation,
      getSnapshot: vi.fn(() => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: {
          id: 'account-mobile' as never,
          githubId: 1,
          githubLogin: 'mobile',
          avatarUrl: 'https://avatars.example/mobile',
        },
      })),
    }
    const transport = transportFixture()
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId(crypto.randomUUID()),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const scanner = { scan: vi.fn(async () => link) }
    let scheduled: (() => void) | undefined
    const controller = new MobilePairingController({
      installation,
      transport,
      handshake,
      scanner,
      schedule: (task) => {
        scheduled = task
        return setTimeout(() => {}, 60_000)
      },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    await controller.completeLink(link)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
    })
    await controller.scanQr({} as HTMLVideoElement)

    expect(handshake.begin).toHaveBeenCalledOnce()
    expect(handshake.begin).toHaveBeenCalledWith(link)
    expect(transport.completeChallenge).toHaveBeenCalledTimes(2)
    expect(handshake.acceptDesktopHandshake).toHaveBeenCalledTimes(2)
    expect(authorizeCurrentInstallation).toHaveBeenCalledTimes(2)
    scheduled?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toEqual({ status: 'paired' }) })
  })

  it.each([
    [new Error('Camera permission was denied'), 'Camera permission was denied'],
    ['not a Pairing Challenge', 'Pairing invitation link'],
  ] as const)('projects camera and malformed-QR failures explicitly', async (scannerResult, message) => {
    const scanner = {
      scan: typeof scannerResult === 'string'
        ? vi.fn(async () => scannerResult)
        : vi.fn(async () => await Promise.reject(scannerResult)),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport: transportFixture(),
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn() },
      scanner,
    })

    await expect(controller.scanQr({} as HTMLVideoElement)).rejects.toThrow(message)
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error(`expected ready snapshot, received ${snapshot.status}`)
    expect(snapshot.error).toContain(message)
  })

  it('retries a lost completion response with the same prepared handshake attempt', async () => {
    const link = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const transport = transportFixture()
    transport.completeChallenge
      .mockRejectedValueOnce(new Error('completion response was lost'))
      .mockResolvedValueOnce({
        pendingPairingId: parsePendingPairingId('pending-replayed'),
        authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
        desktopHandshake: Uint8Array.of(8),
        device: { name: 'Replay installation', platform: 'ios' },
      })
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('completion-retry'),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport,
      handshake,
      scanner: { scan: vi.fn() },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    await expect(controller.completeLink(link)).rejects.toThrow('completion response was lost')
    expect(controller.getSnapshot()).toEqual({
      status: 'retryable',
      error: 'completion response was lost',
    })
    await controller.retryPairing()

    expect(handshake.begin).toHaveBeenCalledOnce()
    expect(transport.completeChallenge).toHaveBeenCalledTimes(2)
    const [first, second] = transport.completeChallenge.mock.calls.map(([request]) => ({
      completionId: request.completionId,
      oneTimeLink: request.oneTimeLink,
      mobileHandshake: request.mobileHandshake,
    }))
    expect(second).toEqual(first)
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending' })
  })

  it('reuses a possibly committed attempt after invitation expiry until replay retention ends', async () => {
    const now = { value: Date.parse('2026-08-18T10:01:00.000Z') }
    const link = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const transport = transportFixture()
    transport.completeChallenge.mockRejectedValueOnce(new Error('completion response was lost'))
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('completion-after-expiry'),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(), transport, handshake, scanner: { scan: vi.fn() },
      now: () => now.value,
    })

    await expect(controller.completeLink(link)).rejects.toThrow('response was lost')
    const firstRequest = transport.completeChallenge.mock.calls[0]?.[0]
    now.value = Date.parse('2026-08-18T10:02:01.000Z')
    await controller.retryPairing()

    expect(transport.completeChallenge.mock.calls[1]?.[0]).toEqual(firstRequest)
    expect(handshake.begin).toHaveBeenCalledOnce()
    now.value += PAIRING_REPLAY_RETENTION_MS
    await expect(controller.completeLink(pairingLink(now.value + 120_000, 'replacement')))
      .rejects.toThrow('Retry the retained Personal Pairing attempt')
  })

  it('retains one attempt until its invitation expires, then prepares a replacement', async () => {
    const now = { value: Date.parse('2026-08-18T10:01:00.000Z') }
    const firstLink = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const replacementLink = pairingLink(Date.parse('2026-08-18T10:04:00.000Z'), 'challenge-two')
    const transport = transportFixture()
    const installation = installationFixture()
    installation.authorizeCurrentInstallation.mockRejectedValueOnce(new Error('authorization unavailable'))
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId(crypto.randomUUID()),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation,
      transport,
      handshake,
      scanner: { scan: vi.fn() },
      now: () => now.value,
    })

    await expect(controller.completeLink(firstLink)).rejects.toThrow('authorization unavailable')
    await expect(controller.completeLink(replacementLink))
      .rejects.toThrow('Retry the retained Personal Pairing attempt')
    expect(handshake.begin).toHaveBeenCalledOnce()

    now.value = Date.parse('2026-08-18T10:02:00.000Z')
    await controller.completeLink(replacementLink)
    expect(handshake.begin).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending' })
  })

  it('keeps a committed pending attempt after invitation expiry when status polling briefly fails', async () => {
    const now = { value: Date.parse('2026-08-18T10:01:00.000Z') }
    const link = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const scheduled: Array<() => void> = []
    const transport = transportFixture()
    transport.getMobilePairingStatus.mockRejectedValueOnce(new Error('poll unavailable'))
    const controller = new MobilePairingController({
      installation: installationFixture(), transport,
      handshake: {
        begin: vi.fn(async () => ({
          completionId: parsePairingCompletionId('completion-pending-expiry'),
          mobileHandshake: Uint8Array.of(9),
        })),
        acceptDesktopHandshake: vi.fn(),
      },
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => now.value,
    })

    await controller.completeLink(link)
    const firstRequest = transport.completeChallenge.mock.calls[0]?.[0]
    now.value = Date.parse('2026-08-18T10:02:01.000Z')
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toEqual({ status: 'retryable', error: 'poll unavailable' }) })
    await controller.retryPairing()

    expect(transport.completeChallenge.mock.calls[1]?.[0]).toEqual(firstRequest)
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending' })
  })

  it('clears account-scoped state across sign-out before the next Account refresh can fail', async () => {
    const account = { id: 'account-a' }
    const installation = installationFixture(() => account.id)
    const transport = transportFixture()
    transport.completeChallenge.mockRejectedValueOnce(new Error('account A response lost'))
      .mockRejectedValueOnce(new Error('account B refresh failed'))
    const controller = new MobilePairingController({
      installation, transport,
      handshake: {
        begin: vi.fn(async () => ({
          completionId: parsePairingCompletionId(crypto.randomUUID()),
          mobileHandshake: Uint8Array.of(9),
        })),
        acceptDesktopHandshake: vi.fn(),
      },
      scanner: { scan: vi.fn() },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    await expect(controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))))
      .rejects.toThrow('account A response lost')
    await controller.deactivate()
    expect(controller.getSnapshot()).toEqual({ status: 'ready' })
    account.id = 'account-b'
    await controller.activate()
    await expect(controller.retryPairing()).rejects.toThrow('No retryable')
    await expect(controller.completeLink(pairingLink(
      Date.parse('2026-08-18T10:02:00.000Z'), 'account-b-challenge',
    ))).rejects.toThrow('account B refresh failed')
    expect(controller.getSnapshot()).toEqual({ status: 'retryable', error: 'account B refresh failed' })
  })

  it('serializes browser-camera scanning so deactivation drains the scanner and post-close scan is rejected', async () => {
    const scan = deferred<string>()
    const scanner = { scan: vi.fn().mockReturnValue(scan.promise) }
    const transport = transportFixture()
    const controller = new MobilePairingController({
      installation: installationFixture(), transport,
      handshake: {
        begin: vi.fn(async () => ({
          completionId: parsePairingCompletionId('completion-scanner'), mobileHandshake: Uint8Array.of(9),
        })),
        acceptDesktopHandshake: vi.fn(),
      },
      scanner,
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    const scanning = controller.scanQr({} as HTMLVideoElement)
    await vi.waitFor(() => { expect(scanner.scan).toHaveBeenCalledOnce() })
    let drained = false
    const deactivating = controller.deactivate().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    scan.resolve(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    await expect(scanning).rejects.toThrow('inactive')
    await deactivating
    expect(transport.completeChallenge).not.toHaveBeenCalled()
    await expect(controller.scanQr({} as HTMLVideoElement)).rejects.toThrow('inactive')
    expect(scanner.scan).toHaveBeenCalledOnce()
  })

  it('deactivation drains in-flight work, stops polling, and rejects post-sign-out verbs', async () => {
    const link = pairingLink(Date.parse('2026-08-18T10:02:00.000Z'))
    const completion = deferred<Awaited<ReturnType<RemoteAccessTransport['completeChallenge']>>>()
    const transport = transportFixture()
    transport.completeChallenge.mockReturnValueOnce(completion.promise)
    const scheduled: Array<() => void> = []
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('completion-drain'),
        mobileHandshake: Uint8Array.of(9),
      })),
      acceptDesktopHandshake: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport,
      handshake,
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    const completing = controller.completeLink(link)
    await vi.waitFor(() => { expect(transport.completeChallenge).toHaveBeenCalledOnce() })
    let drained = false
    const deactivating = controller.deactivate().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    completion.resolve({
      pendingPairingId: parsePendingPairingId('pending-drain'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(8),
      device: { name: 'Draining installation', platform: 'android' },
    })
    await expect(completing).rejects.toThrow('inactive')
    await deactivating
    expect(handshake.acceptDesktopHandshake).not.toHaveBeenCalled()
    expect(scheduled).toEqual([])
    await expect(controller.retryPairing()).rejects.toThrow('inactive')
    await expect(controller.completeLink(link)).rejects.toThrow('inactive')
  })
})

function pairingLink(expiresAt: number, challengeId = 'challenge-one'): string {
  return `https://platform.example/pair?challenge=${challengeId}&secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&fingerprint=desktop-fingerprint&rendezvous=rendezvous-one&expires=${String(expiresAt)}&protocol=1`
}

function installationFixture(accountId: () => string = () => 'account-mobile') {
  return {
    getSnapshot: vi.fn(() => ({
      status: 'signed-in' as const,
      privacyAccepted: true,
      account: { id: accountId() as never, githubId: 1, githubLogin: 'mobile', avatarUrl: 'https://avatars.example/mobile' },
    })),
    authorizeCurrentInstallation: vi.fn(async () => ({
      accessToken: 'mobile-access',
      proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
    })),
  }
}

function transportFixture() {
  return {
    getMobileAccessState: vi.fn(),
    setMobileAccess: vi.fn(),
    reissueDesktopRelayAuthority: vi.fn(),
    createChallenge: vi.fn(),
    cancelChallenge: vi.fn(),
    listPendingPairings: vi.fn(),
    listPersonalPairings: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
    revokePersonalPairing: vi.fn(),
    completeChallenge: vi.fn<RemoteAccessTransport['completeChallenge']>().mockResolvedValue({
      pendingPairingId: parsePendingPairingId('pending-one'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(8),
      device: { name: 'Fixture installation', platform: 'ios' },
    }),
    getMobilePairingStatus: vi.fn().mockResolvedValue({ status: 'paired', pairingId: 'pairing-one' }),
  } satisfies RemoteAccessTransport
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
