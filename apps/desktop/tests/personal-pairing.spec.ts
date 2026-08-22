import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  DesktopBridge,
  DesktopPairingChallenge,
  DesktopPendingPairing,
  DesktopPersonalPairing,
} from '@deepseek-ai/dsh-client-ui-desktop/protocol'
import { parseAccountProofJti } from '@deepseek-ai/dsh-platform-account'
import {
  parsePairingChallengeId,
  parsePendingPairingId,
  parsePersonalPairingId,
  type PairingChallengeId,
  type PendingPairingId,
  type PersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import type { RemoteAccessTransport } from '@deepseek-ai/dsh-remote-access-client'
import { FailClosedDesktopRelayLifecycle } from '@deepseek-ai/dsh-remote-access-client/desktop-relay-lifecycle'
import {
  bindDesktopPairing,
  createDesktopPairingSource,
} from '../../../packages/client/ui-desktop/src/client/pairing-source.ts'
import {
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { DesktopPairingKeyVault } from '../src/pairing-keys.ts'
import { initializeSnowChannel, SnowMobileHandshakeClient } from '@deepseek-ai/dsh-noise-channel'
import { DesktopSnowPairingVault } from '../src/snow-pairing-vault.ts'
import {
  DesktopPairingController,
  UnavailableDesktopPairingController,
  confirmPairingFromIpc,
  parseDesktopPendingPairingId,
  parsePairingEnabled,
  rejectPairingFromIpc,
  setPairingEnabledFromIpc,
} from '../src/personal-pairing.ts'

describe('UnavailableDesktopPairingController', () => {
  it('keeps every product verb fail-closed before independent Noise review', async () => {
    const controller = new UnavailableDesktopPairingController('independent review pending')
    const expected = {
      status: 'unavailable', enabled: false, pairings: [], error: 'independent review pending',
    }
    expect(controller.getSnapshot()).toEqual(expected)
    await expect(controller.setEnabled(true)).rejects.toThrow('independent review pending')
    await expect(controller.createChallenge()).rejects.toThrow('independent review pending')
    await expect(controller.cancelChallenge()).rejects.toThrow('independent review pending')
    await expect(controller.confirm(parsePendingPairingId('pending-1'))).rejects.toThrow('independent review pending')
    await expect(controller.reject(parsePendingPairingId('pending-1'))).rejects.toThrow('independent review pending')
    const listener = vi.fn()
    controller.subscribe(listener)()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getRelayState()).toEqual({ connected: false })
    await expect(controller.start()).resolves.toBeUndefined()
    await expect(controller.deactivate()).resolves.toBeUndefined()
    await expect(controller.dispose()).resolves.toBeUndefined()
  })

  it('keeps the product Relay composition observably offline for lifecycle hooks', async () => {
    const relay = new FailClosedDesktopRelayLifecycle('crypto gate pending')
    const controller = new UnavailableDesktopPairingController('crypto gate pending', relay)
    await expect(relay.configure()).rejects.toThrow('crypto gate pending')
    await expect(relay.start()).rejects.toThrow('crypto gate pending')
    expect(relay.getState()).toEqual({ connected: false })

    await controller.deactivate('sleep')
    expect(relay.getState()).toEqual({ connected: false, stopReason: 'sleep' })
    await controller.dispose()
    expect(relay.getState()).toEqual({ connected: false, stopReason: 'quit' })
  })
})

describe('DesktopPairingController', () => {
  it('preserves durable pairing authority across suspend and wipes it only on account-scope reset', async () => {
    const transport = transportFixture()
    transport.getMobileAccessState.mockReset()
    transport.getMobileAccessState.mockResolvedValue({ enabled: true })
    transport.listEndpointPending.mockResolvedValue([])
    const clear = vi.fn()
    const flush = vi.fn(async () => {})
    const grant = {
      endpoint: 'desktop' as const,
      routeId: parseRelayRouteId('route-retained'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      pairingSelector: 'pairing-retained' as never,
      revision: 1,
    }
    const vault = {
      desktopRelayGrants: () => [grant],
      clear,
      flush,
    } as unknown as DesktopSnowPairingVault
    const synchronize = vi.fn(async () => {})
    const relay = { synchronize, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const controller = new DesktopPairingController({
      account: accountFixture(), transport, relay, snowPairingVault: vault,
    })

    await controller.start()
    for (const reason of ['sleep', 'window-close', 'quit'] as const) {
      await controller.deactivate(reason)
      expect(clear).not.toHaveBeenCalled()
      await controller.start()
    }
    expect(synchronize).toHaveBeenCalledWith([grant])

    await controller.deactivate('mobile-access-disabled')
    expect(clear).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalled()
  })

  it('restores the same pairing-scoped Relay grant after a full controller and vault restart', async () => {
    const grant = {
      endpoint: 'desktop' as const,
      routeId: parseRelayRouteId('route-restart'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      pairingSelector: parseRelayPairingSelector('pairing-restart'),
      revision: 3,
    }
    const state = {
      active: [{
        pairingId: parsePersonalPairingId('pairing-restart'),
        reconnectState: new Uint8Array(96).fill(9), desktopGrant: grant,
      }],
      challenges: [], pending: [], confirmations: [],
    }
    const store = { load: vi.fn(async () => state), save: vi.fn(async () => {}) }
    const transport = transportFixture()
    transport.getMobileAccessState.mockReset()
    transport.getMobileAccessState.mockResolvedValue({ enabled: true })
    transport.listEndpointPending.mockResolvedValue([])
    const firstSynchronize = vi.fn(async () => {})
    const first = new DesktopPairingController({
      account: accountFixture(), transport,
      relay: { synchronize: firstSynchronize, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
      snowPairingVault: await DesktopSnowPairingVault.load(store),
    })
    await first.start()
    await first.deactivate('window-close')
    await first.dispose()

    const secondSynchronize = vi.fn(async () => {})
    const second = new DesktopPairingController({
      account: accountFixture(), transport,
      relay: { synchronize: secondSynchronize, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
      snowPairingVault: await DesktopSnowPairingVault.load(store),
    })
    await second.start()

    expect(firstSynchronize).toHaveBeenCalledWith([grant])
    expect(secondSynchronize).toHaveBeenCalledWith([grant])
    expect(store.save).not.toHaveBeenCalled()
    await second.dispose()
  })

  it('settles Platform-retained endpoint work after Desktop invitation state was wiped', async () => {
    const transport = transportFixture()
    transport.listEndpointPending.mockResolvedValue([{
      pendingPairingId: parsePendingPairingId('pending-stale'),
      challengeId: parsePairingChallengeId('challenge-stale'),
      stage: 'message1', message1: Uint8Array.of(1),
      device: { name: 'Stale phone', platform: 'ios' },
    }])
    const controller = new DesktopPairingController({
      account: accountFixture(), transport,
      relay: { configure: vi.fn(), start: vi.fn(), stop: vi.fn() },
      snowPairingVault: new DesktopSnowPairingVault(),
    })
    await controller.start()
    await controller.setEnabled(true)
    expect(transport.rejectEndpointPairing).toHaveBeenCalledWith(expect.objectContaining({
      pendingPairingId: 'pending-stale',
    }))
    expect(transport.submitEndpointMessage2).not.toHaveBeenCalled()
  })

  it('owns XKpsk3 invitation state, confirms a digest-only credential, and seals the Mobile grant', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const transport = transportFixture()
    const relay = { configure: vi.fn(), start: vi.fn(), stop: vi.fn() }
    let failNextSave = false
    const save = vi.fn(async () => {
      if (!failNextSave) return
      failNextSave = false
      throw new Error('vault persistence failed after sealed delivery')
    })
    const vault = new DesktopSnowPairingVault({ load: vi.fn(async () => []), save })
    const challengeId = parsePairingChallengeId('challenge-endpoint-owner')
    const pendingPairingId = parsePendingPairingId('pending-endpoint-owner')
    const deliveredAuthorities: Uint8Array[] = []
    transport.deliverEndpointRelayAuthority.mockImplementation(async (input) => {
      deliveredAuthorities.push(input.sealedRelayAuthority.slice())
      if (deliveredAuthorities.length === 1) throw new Error('sealed authority response was lost after commit')
    })
    transport.createEndpointChallenge.mockImplementationOnce(async (input) => {
      return {
        challengeId, expiresAt: input.expiresAt,
        routingLink: 'https://platform.example/pair?endpoint=1&expires=1787027200000&protocol=1',
      }
    })
    transport.listEndpointPending.mockResolvedValue([])
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport, relay, snowPairingVault: vault,
    })
    await controller.start()
    await controller.setEnabled(true)
    await controller.createChallenge()
    const invitationLink = controller.getSnapshot().challenge?.oneTimeLink
    if (invitationLink === undefined) throw new Error('endpoint invitation was not projected')
    const encodedPayload = new URL(invitationLink).searchParams.get('payload')
    if (encodedPayload === null) throw new Error('endpoint invitation has no local payload')
    const invitationPayload = new Uint8Array(Buffer.from(encodedPayload, 'base64url'))

    const mobile = new SnowMobileHandshakeClient()
    const message1 = await mobile.beginEndpointInvitation(invitationPayload)
    transport.listEndpointPending.mockResolvedValueOnce([{
      pendingPairingId, challengeId, stage: 'message1', message1,
      device: { name: 'Alice phone', platform: 'ios' },
    }])
    await controller.start()
    const message2 = transport.submitEndpointMessage2.mock.calls.at(-1)?.[0].message2
    if (message2 === undefined) throw new Error('Desktop Snow message 2 was not submitted')
    await mobile.acceptDesktopHandshake(message2)
    const message3 = mobile.exportFinishMessage()
    transport.listEndpointPending.mockResolvedValueOnce([{
      pendingPairingId, challengeId, stage: 'message3', message1, message2, message3,
      device: { name: 'Alice phone', platform: 'ios' },
    }])
    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending', pending: { id: pendingPairingId } })

    const confirmation = {
      pairing: {
        id: parsePersonalPairingId('pairing-endpoint-owner'),
        devicePrincipal: {
          id: 'principal-endpoint' as never, accountId: 'account-one' as never,
          installationId: 'mobile-one' as never, authority: 'companion-surface',
        },
        device: { name: 'Alice phone', platform: 'ios' }, pairedAt: 1, lastAccessAt: 1, online: false,
      },
      routeId: parseRelayRouteId('route-endpoint-owner'), relayRevision: 3,
    }
    const confirmationDigests: Uint8Array[] = []
    transport.confirmEndpointPairing.mockImplementation(async (input) => {
      confirmationDigests.push(input.mobileCredentialDigest.slice())
      if (confirmationDigests.length === 1) throw new Error('confirmation response was lost after commit')
      return confirmation
    })
    transport.listEndpointPending.mockResolvedValue([])
    await expect(controller.confirm(pendingPairingId)).rejects.toThrow('confirmation response was lost after commit')
    await expect(controller.confirm(pendingPairingId)).rejects.toThrow('sealed authority response was lost after commit')
    const savesBeforeCommit = save.mock.calls.length
    failNextSave = true
    await expect(controller.confirm(pendingPairingId)).rejects.toThrow('vault persistence failed after sealed delivery')
    await controller.confirm(pendingPairingId)
    const sealed = deliveredAuthorities.at(-1)
    if (sealed === undefined) throw new Error('Desktop did not deliver sealed Relay authority')
    await expect(mobile.openRelayAuthority(sealed)).resolves.toMatchObject({
      routeId: 'route-endpoint-owner', endpoint: 'mobile', revision: 3,
      pairingSelector: 'pairing-endpoint-owner',
    })
    expect(vault.reconnectState('pairing-endpoint-owner' as never)).toHaveLength(96)
    expect(confirmationDigests).toHaveLength(4)
    expect(confirmationDigests[1]).toEqual(confirmationDigests[0])
    expect(confirmationDigests[2]).toEqual(confirmationDigests[0])
    expect(confirmationDigests[3]).toEqual(confirmationDigests[0])
    expect(deliveredAuthorities).toHaveLength(3)
    expect(deliveredAuthorities[1]).toEqual(deliveredAuthorities[0])
    expect(deliveredAuthorities[2]).toEqual(deliveredAuthorities[0])
    expect(save).toHaveBeenCalledTimes(savesBeforeCommit + 2)
    await controller.dispose()
  })

  it('installs the Settings Relay grant before starting the endpoint lifecycle', async () => {
    const transport = transportFixture()
    const grant = {
      routeId: parseRelayRouteId('route-settings'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      revision: 1,
    }
    transport.setMobileAccess.mockResolvedValueOnce({ enabled: true, relay: grant })
    const order: string[] = []
    const relay = {
      configure: vi.fn(async () => { order.push('configure') }),
      start: vi.fn(async () => { order.push('start') }),
      stop: vi.fn(async () => {}),
    }
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport,
      relay,
    })
    await controller.start()

    await controller.setEnabled(true)

    expect(relay.configure).toHaveBeenCalledWith(grant)
    expect(order).toEqual(['configure', 'start'])
    await controller.dispose()
  })

  it('owns the live Relay only while Mobile Access is enabled and the Desktop is awake', async () => {
    const transport = transportFixture()
    const relay = { configure: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport,
      relay,
    })

    await controller.start()
    expect(relay.stop).toHaveBeenLastCalledWith('mobile-access-disabled')
    await controller.setEnabled(true)
    expect(relay.start).toHaveBeenCalledOnce()

    await controller.deactivate('sleep')
    expect(relay.stop).toHaveBeenLastCalledWith('sleep')
    await controller.start()
    expect(relay.start).toHaveBeenCalledTimes(2)

    await controller.setEnabled(false)
    expect(relay.stop).toHaveBeenLastCalledWith('mobile-access-disabled')
    await controller.dispose()
    expect(relay.stop).toHaveBeenLastCalledWith('quit')
  })

  it('drives the real Settings lifecycle through authenticated transport verbs', async () => {
    const authorization = {
      accessToken: 'desktop-access',
      proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
    }
    const authorizeCurrentInstallation = vi.fn(async () => authorization)
    const account = {
      authorizeCurrentInstallation,
      getSnapshot: signedInAccountSnapshot,
    }
    const transport = transportFixture()
    const scheduled: Array<() => void> = []
    const controller = new DesktopPairingController({
      account,
      transport,
      randomId: () => 'rendezvous-one',
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
    })

    await controller.start()
    await controller.setEnabled(true)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', enabled: true })
    await controller.createChallenge()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'challenge',
      challenge: { id: 'challenge-one', oneTimeLink: 'https://platform.example/pair?full=1' },
    })

    vi.mocked(transport.listPendingPairings).mockResolvedValueOnce([{
      pendingPairingId: parsePendingPairingId('pending-one'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(1),
      device: { name: 'Alice phone', platform: 'ios' },
    }])
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toMatchObject({ status: 'pending' }) })
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending', pending: { id: 'pending-one' } })
    await controller.confirm(parsePendingPairingId('pending-one'))
    expect(transport.confirmPairing).toHaveBeenCalledOnce()
    expect(authorizeCurrentInstallation).toHaveBeenCalled()
  })

  it('retains independent keyless pairing material only after Desktop confirmation', async () => {
    const transport = transportFixture()
    const material = Uint8Array.from({ length: 32 }, (_, index) => index + 9)
    const vault = new DesktopPairingKeyVault()
    transport.listPendingPairings.mockResolvedValue([{
      pendingPairingId: parsePendingPairingId('pending-key'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: material,
      device: { name: 'Alice phone', platform: 'ios' },
    }])
    transport.confirmPairing.mockResolvedValue({
      id: parsePersonalPairingId('pairing-key'),
      devicePrincipal: {
        id: 'principal-key' as never,
        accountId: 'account-one' as never,
        installationId: 'mobile-one' as never,
        authority: 'companion-surface',
      },
      device: { name: 'Alice phone', platform: 'ios' },
      pairedAt: 1,
      lastAccessAt: 1,
      online: false,
    })
    const controller = new DesktopPairingController({
      account: accountFixture(),
      transport,
      pairingKeys: vault,
    })
    await controller.start()
    await controller.setEnabled(true)
    await controller.confirm(parsePendingPairingId('pending-key'))
    expect(vault.pairingKeyMaterial(parsePersonalPairingId('pairing-key'))).toEqual(material)
    await controller.deactivate('mobile-access-disabled')
    expect(vault.pairingKeyMaterial(parsePersonalPairingId('pairing-key'))).toBeUndefined()
  })

  it('deactivation drains an in-flight poll and rejects work after sign-out or close', async () => {
    const transport = transportFixture()
    const relay = { configure: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const scheduled: Array<() => void> = []
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport,
      relay,
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
    })
    await controller.start()
    await controller.setEnabled(true)
    const refresh = deferred<{ enabled: boolean }>()
    transport.getMobileAccessState.mockReturnValueOnce(refresh.promise)
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(transport.getMobileAccessState).toHaveBeenCalledTimes(3) })

    let drained = false
    const deactivating = controller.deactivate().then(() => { drained = true })
    await Promise.resolve()
    expect(relay.stop).toHaveBeenCalledWith('quit')
    expect(drained).toBe(false)
    refresh.resolve({ enabled: true })
    await deactivating
    expect(scheduled).toEqual([])
    await expect(controller.createChallenge()).rejects.toThrow('inactive')

    await controller.start()
    await controller.dispose()
    await expect(controller.start()).rejects.toThrow('closed')
    await expect(controller.setEnabled(true)).rejects.toThrow('inactive')
  })

  it('does not let an old deferred stop close a resumed lifecycle owner', async () => {
    const transport = transportFixture()
    const stopRelease = deferred<undefined>()
    const stopEntered = deferred<undefined>()
    const relay = {
      configure: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async (reason?: string) => {
        if (reason === 'sleep') {
          stopEntered.resolve(undefined)
          await stopRelease.promise
        }
      }),
    }
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport,
      relay,
    })
    await controller.start()
    await controller.setEnabled(true)
    const startsBeforeSuspend = relay.start.mock.calls.length

    const suspending = controller.deactivate('sleep')
    await stopEntered.promise
    const resuming = controller.start()
    await Promise.resolve()
    expect(relay.start).toHaveBeenCalledTimes(startsBeforeSuspend)

    stopRelease.resolve(undefined)
    await suspending
    await resuming
    expect(relay.start).toHaveBeenCalledTimes(startsBeforeSuspend + 1)
    await controller.dispose()
  })

  it('stays locally offline when the remote disable mutation fails and recovers only on explicit enable', async () => {
    const transport = transportFixture()
    const relay = { configure: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const controller = new DesktopPairingController({
      account: {
        getSnapshot: signedInAccountSnapshot,
        authorizeCurrentInstallation: vi.fn(async () => ({
          accessToken: 'desktop-access',
          proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
        })),
      },
      transport,
      relay,
    })
    await controller.start()
    await controller.setEnabled(true)
    transport.setMobileAccess.mockRejectedValueOnce(new Error('disable failed'))

    await expect(controller.setEnabled(false)).rejects.toThrow('disable failed')
    expect(relay.stop).toHaveBeenLastCalledWith('mobile-access-disabled')
    expect(controller.getSnapshot()).toMatchObject({ status: 'failed', enabled: false, error: 'disable failed' })

    await controller.setEnabled(true)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', enabled: true })
    expect(relay.start).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })

  it('drops Account A projection before Account B starts even when its first refresh fails', async () => {
    const accountId = { value: 'account-a' }
    const account = {
      getSnapshot: vi.fn(() => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: {
          id: accountId.value as never,
          githubId: 1,
          githubLogin: accountId.value,
          avatarUrl: 'https://avatars.example/account',
        },
      })),
      authorizeCurrentInstallation: vi.fn(async () => ({
        accessToken: `${accountId.value}-access`,
        proof: { jti: parseAccountProofJti(`${accountId.value}-proof`), issuedAt: 1, signature: 'signature' },
      })),
    }
    const transport = transportFixture()
    const controller = new DesktopPairingController({ account, transport })

    await controller.start()
    await controller.setEnabled(true)
    expect(controller.getSnapshot().pairings).toHaveLength(1)
    await controller.deactivate()
    expect(controller.getSnapshot()).toEqual({ status: 'ready', enabled: false, pairings: [] })

    accountId.value = 'account-b'
    transport.getMobileAccessState.mockRejectedValueOnce(new Error('account B refresh failed'))
    await expect(controller.start()).rejects.toThrow('account B refresh failed')
    expect(controller.getSnapshot()).toEqual({
      status: 'failed', enabled: false, pairings: [], error: 'account B refresh failed',
    })
  })

  it('pushes an Account reset through the bound renderer source before Account B refreshes', async () => {
    const accountId = { value: 'account-a' }
    const account = {
      getSnapshot: vi.fn(() => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: {
          id: accountId.value as never,
          githubId: 1,
          githubLogin: accountId.value,
          avatarUrl: 'https://avatars.example/account',
        },
      })),
      authorizeCurrentInstallation: vi.fn(async () => ({
        accessToken: `${accountId.value}-access`,
        proof: {
          jti: parseAccountProofJti(`${accountId.value}-proof`),
          issuedAt: 1,
          signature: 'signature',
        },
      })),
    }
    const transport = transportFixture()
    const controller = new DesktopPairingController({ account, transport })
    const source = createDesktopPairingSource()
    bindDesktopPairing(source, {
      pairingGetSnapshot: async () => controller.getSnapshot(),
      onPairingSnapshot: listener => controller.subscribe(listener),
    })
    const rendererSubscriber = vi.fn()
    source.subscribe(rendererSubscriber)

    await controller.start()
    await controller.setEnabled(true)
    expect(source.getSnapshot()).toMatchObject({
      status: 'ready', enabled: true, pairings: [{ id: 'pairing-one' }],
    })

    const callsBeforeReset = rendererSubscriber.mock.calls.length
    const deactivating = controller.deactivate()
    expect(source.getSnapshot()).toEqual({ status: 'ready', enabled: false, pairings: [] })
    expect(rendererSubscriber).toHaveBeenCalledTimes(callsBeforeReset + 1)
    await deactivating
    expect(rendererSubscriber).toHaveBeenCalledTimes(callsBeforeReset + 1)

    accountId.value = 'account-b'
    const refresh = deferred<{ enabled: boolean }>()
    transport.getMobileAccessState.mockReturnValueOnce(refresh.promise)
    const starting = controller.start()
    await Promise.resolve()
    expect(source.getSnapshot()).toEqual({ status: 'ready', enabled: false, pairings: [] })
    expect(rendererSubscriber).toHaveBeenCalledTimes(callsBeforeReset + 1)

    refresh.reject(new Error('account B refresh failed'))
    await expect(starting).rejects.toThrow('account B refresh failed')
    expect(source.getSnapshot()).toEqual({
      status: 'failed', enabled: false, pairings: [], error: 'account B refresh failed',
    })
  })

  it('parses Electron IPC payloads before controller side effects', () => {
    expectTypeOf<DesktopPairingChallenge['id']>().toEqualTypeOf<PairingChallengeId>()
    expectTypeOf<DesktopPendingPairing['id']>().toEqualTypeOf<PendingPairingId>()
    expectTypeOf<DesktopPersonalPairing['id']>().toEqualTypeOf<PersonalPairingId>()
    expectTypeOf<DesktopBridge['pairingConfirm']>().parameter(0).toEqualTypeOf<PendingPairingId>()
    expectTypeOf<DesktopBridge['pairingReject']>().parameter(0).toEqualTypeOf<PendingPairingId>()
    expectTypeOf<DesktopBridge['pairingRevoke']>().parameter(0).toEqualTypeOf<PersonalPairingId>()
    expect(parsePairingEnabled(true)).toBe(true)
    expect(() => parsePairingEnabled('true')).toThrow('must be boolean')
    expect(parseDesktopPendingPairingId('pending-one')).toBe('pending-one')
    expect(() => parseDesktopPendingPairingId('')).toThrow('must be non-empty')

    const actions = { setEnabled: vi.fn(), confirm: vi.fn(), reject: vi.fn() }
    expect(() => setPairingEnabledFromIpc(actions, 'true')).toThrow('must be boolean')
    expect(() => confirmPairingFromIpc(actions, '')).toThrow('must be non-empty')
    expect(() => rejectPairingFromIpc(actions, [])).toThrow('must be non-empty')
    expect(actions.setEnabled).not.toHaveBeenCalled()
    expect(actions.confirm).not.toHaveBeenCalled()
    expect(actions.reject).not.toHaveBeenCalled()
  })

  it('validates polling and isolates subscribers and scheduled refresh failures', async () => {
    const transport = transportFixture()
    for (const pollIntervalMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new DesktopPairingController({
        account: accountFixture(), transport, pollIntervalMs,
      })).toThrow('positive integer')
    }
    transport.getMobileAccessState.mockReset().mockResolvedValue({ enabled: true })
    const scheduled: Array<() => void> = []
    const controller = new DesktopPairingController({
      account: accountFixture(),
      transport,
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
    })
    controller.subscribe(vi.fn())()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    controller.subscribe(() => { throw new Error('subscriber failed') })
    await controller.start()
    expect(consoleError).toHaveBeenCalledWith(
      '[desktop-personal-pairing] subscriber failures:', expect.any(AggregateError),
    )
    expect(controller.getRelayState()).toEqual({ connected: false })
    transport.getMobileAccessState.mockRejectedValueOnce(new Error('poll failed'))
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalledWith(
      '[desktop-personal-pairing] Remote Access refresh failed:', expect.any(Error),
    ) })
    await controller.deactivate()
    scheduled.shift()?.()
    await controller.dispose()
    consoleError.mockRestore()
  })

  it('fails closed across mutation, grant-owner, account, and lifecycle errors', async () => {
    const transport = transportFixture()
    const stop = vi.fn(async () => {})
    const relay = { start: vi.fn(async () => {}), stop }
    const controller = new DesktopPairingController({ account: accountFixture(), transport, relay })
    await controller.start()

    const grant = {
      routeId: parseRelayRouteId('route-settings'),
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      revision: 1,
    }
    transport.setMobileAccess.mockResolvedValueOnce({ enabled: true, relay: grant })
    await expect(controller.setEnabled(true)).rejects.toThrow('no lifecycle owner')

    stop.mockRejectedValueOnce(new Error('stop failed'))
    transport.setMobileAccess.mockRejectedValueOnce(new Error('mutation failed'))
    await expect(controller.setEnabled(false)).rejects.toThrow('Desktop Mobile Access update failed')
    expect(controller.getSnapshot()).toMatchObject({ status: 'failed', enabled: false })

    stop.mockRejectedValueOnce(new Error('stop failed'))
    transport.setMobileAccess.mockResolvedValueOnce({ enabled: false })
    await expect(controller.setEnabled(false)).rejects.toThrow('stop failed')
    await expect(controller.dispose()).resolves.toBeUndefined()

    const signedOut = new DesktopPairingController({
      account: {
        getSnapshot: () => ({ status: 'signed-out', privacyAccepted: true }),
        authorizeCurrentInstallation: vi.fn(),
      },
      transport: transportFixture(),
    })
    await expect(signedOut.start()).rejects.toThrow('signed-in Platform Account')
  })

  it('owns cancel, reject, default id generation, state observation, and disposal races', async () => {
    const transport = transportFixture()
    const quit = deferred<undefined>()
    const relay = {
      configure: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async (reason?: string) => {
        if (reason === 'quit') await quit.promise
      }),
      getState: () => ({ connected: true }),
    }
    const controller = new DesktopPairingController({ account: accountFixture(), transport, relay })
    await controller.start()
    expect(controller.getRelayState()).toEqual({ connected: true })
    expect(await controller.cancelChallenge()).toEqual(controller.getSnapshot())
    await controller.setEnabled(true)
    await controller.createChallenge()
    await controller.cancelChallenge()
    expect(transport.cancelChallenge).toHaveBeenCalledOnce()
    await controller.reject(parsePendingPairingId('pending-one'))
    expect(transport.rejectPairing).toHaveBeenCalledOnce()

    const disposing = controller.dispose()
    const deactivating = controller.deactivate('sleep')
    quit.resolve(undefined)
    await Promise.all([disposing, deactivating])
    await expect(controller.createChallenge()).rejects.toThrow('inactive')

    const unavailable = new UnavailableDesktopPairingController('gate', {
      start: vi.fn(), stop: vi.fn(async () => {}),
    })
    expect(unavailable.getRelayState()).toEqual({ connected: false })
  })

  it('projects non-Error transport failures and no-Relay disablement', async () => {
    const transport = transportFixture()
    const stop = vi.fn(async () => {})
    const controller = new DesktopPairingController({
      account: accountFixture(), transport, relay: { start: vi.fn(async () => {}), stop },
    })
    await controller.start()
    transport.setMobileAccess.mockRejectedValueOnce('enable failed')
    await expect(controller.setEnabled(true)).rejects.toBe('enable failed')
    transport.setMobileAccess.mockRejectedValueOnce('disable failed')
    await expect(controller.setEnabled(false)).rejects.toThrow('disable failed')
    expect(controller.getSnapshot()).toMatchObject({ status: 'failed', error: 'disable failed' })
    stop.mockRejectedValueOnce('stop failed')
    transport.setMobileAccess.mockResolvedValueOnce({ enabled: false })
    await expect(controller.setEnabled(false)).rejects.toThrow('stop failed')
    transport.setMobileAccess.mockResolvedValueOnce({ enabled: false })
    await expect(controller.setEnabled(false)).resolves.toMatchObject({ enabled: false })
    transport.createChallenge.mockRejectedValueOnce('challenge failed')
    await expect(controller.createChallenge()).rejects.toBe('challenge failed')
    expect(controller.getSnapshot()).toMatchObject({ status: 'failed', error: 'challenge failed' })
    await controller.dispose()
  })

  it('preserves a queued lifecycle owner when the preceding operation fails', async () => {
    const transport = transportFixture()
    const controller = new DesktopPairingController({ account: accountFixture(), transport })
    await controller.start()
    transport.createChallenge.mockRejectedValueOnce(new Error('challenge failed'))
    const challenge = controller.createChallenge()
    const observedChallenge = challenge.catch((error: unknown) => error)
    const enabling = controller.setEnabled(true)

    expect(await observedChallenge).toEqual(expect.objectContaining({ message: 'challenge failed' }))
    await expect(enabling).resolves.toMatchObject({ enabled: true })
    await expect(controller.setEnabled(false)).resolves.toMatchObject({ enabled: false })
    await controller.dispose()
  })

  it('does not let a stale deactivation reset a concurrently disposed owner', async () => {
    const sleeping = deferred<undefined>()
    const entered = deferred<undefined>()
    const relay = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async (reason?: string) => {
        if (reason === 'sleep') {
          entered.resolve(undefined)
          await sleeping.promise
        }
      }),
    }
    const controller = new DesktopPairingController({
      account: accountFixture(), transport: transportFixture(), relay,
    })
    await controller.start()
    const deactivating = controller.deactivate('sleep')
    await entered.promise
    const disposing = controller.dispose()
    sleeping.resolve(undefined)
    await Promise.all([deactivating, disposing])
    await expect(controller.start()).rejects.toThrow('closed')
  })

  it('aggregates Relay stop and in-flight refresh failures during deactivation', async () => {
    const refresh = deferred<{ enabled: boolean }>()
    const entered = deferred<undefined>()
    const transport = transportFixture()
    transport.getMobileAccessState.mockReset()
    transport.getMobileAccessState.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      return await refresh.promise
    })
    const controller = new DesktopPairingController({
      account: accountFixture(),
      transport,
      relay: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => { throw new Error('stop failed') }),
      },
    })
    const starting = controller.start()
    const observedStart = starting.catch((error: unknown) => error)
    await entered.promise
    const deactivating = controller.deactivate('sleep')
    const observedDeactivation = deactivating.catch((error: unknown) => error)
    refresh.reject(new Error('refresh failed'))

    expect(await observedStart).toEqual(expect.objectContaining({ message: 'refresh failed' }))
    const error = await observedDeactivation
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregated lifecycle failure')
    expect(error.errors).toHaveLength(2)
  })
})

function transportFixture() {
  return {
    getMobileAccessState: vi.fn().mockResolvedValueOnce({ enabled: false }).mockResolvedValue({ enabled: true }),
    setMobileAccess: vi.fn(async (input: { enabled: boolean }) => ({ enabled: input.enabled })),
    reissueDesktopRelayAuthority: vi.fn(async () => ({
      enabled: true,
      relay: {
        routeId: parseRelayRouteId('route-reissue'),
        endpoint: 'desktop' as const,
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        revision: 2,
      },
    })),
    createChallenge: vi.fn().mockResolvedValue({
      challengeId: parsePairingChallengeId('challenge-one'),
      desktopFingerprint: 'fingerprint',
      rendezvousId: 'rendezvous-one' as never,
      expiresAt: Date.now() + 120_000,
      protocolMajor: 1,
      oneTimeLink: 'https://platform.example/pair?full=1',
      qrPayload: 'https://platform.example/pair?full=1',
    }),
    createEndpointChallenge: vi.fn<RemoteAccessTransport['createEndpointChallenge']>(),
    cancelEndpointChallenge: vi.fn<RemoteAccessTransport['cancelEndpointChallenge']>(),
    listEndpointPending: vi.fn<RemoteAccessTransport['listEndpointPending']>(),
    submitEndpointMessage2: vi.fn<RemoteAccessTransport['submitEndpointMessage2']>(),
    confirmEndpointPairing: vi.fn<RemoteAccessTransport['confirmEndpointPairing']>(),
    rejectEndpointPairing: vi.fn<RemoteAccessTransport['rejectEndpointPairing']>(),
    deliverEndpointRelayAuthority: vi.fn<RemoteAccessTransport['deliverEndpointRelayAuthority']>(),
    cancelChallenge: vi.fn(),
    listPendingPairings: vi.fn().mockResolvedValue([]),
    listPersonalPairings: vi.fn().mockResolvedValue([{
      id: parsePersonalPairingId('pairing-one'),
      devicePrincipal: {
        id: 'principal-one' as never,
        accountId: 'account-one' as never,
        installationId: 'mobile-one' as never,
        authority: 'companion-surface',
      },
      device: { name: 'Alice phone', platform: 'ios' },
      pairedAt: 1,
      lastAccessAt: 1,
      online: false,
    }]),
    confirmPairing: vi.fn().mockResolvedValue({}),
    rejectPairing: vi.fn(),
    revokePersonalPairing: vi.fn(),
    completeChallenge: vi.fn(),
    submitEndpointMessage1: vi.fn(),
    getEndpointPairingStatus: vi.fn(),
    submitEndpointMessage3: vi.fn(),
    finishChallenge: vi.fn(),
    getMobilePairingStatus: vi.fn(),
  } satisfies RemoteAccessTransport
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function signedInAccountSnapshot() {
  return {
    status: 'signed-in' as const,
    privacyAccepted: true,
    account: {
      id: 'account-one' as never,
      githubId: 1,
      githubLogin: 'account-one',
      avatarUrl: 'https://avatars.example/account',
    },
  }
}

function accountFixture() {
  return {
    getSnapshot: signedInAccountSnapshot,
    authorizeCurrentInstallation: vi.fn(async () => ({
      accessToken: 'desktop-access',
      proof: { jti: parseAccountProofJti('proof'), issuedAt: 1, signature: 'signature' },
    })),
  }
}
