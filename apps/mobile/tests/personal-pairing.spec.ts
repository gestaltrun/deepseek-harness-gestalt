import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { parseAccountProofJti, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  PAIRING_REPLAY_RETENTION_MS,
  parsePairingCompletionId,
  parsePendingPairingId,
  parsePersonalPairingId,
  type PersonalPairingId,
} from '@deepseek-ai/dsh-remote-access'
import { parseRelayCredential, parseRelayPairingSelector, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  initializeSnowChannel, SnowDesktopEndpointPairingOwner, SnowMobileHandshakeClient,
} from '@deepseek-ai/dsh-noise-channel'
import type { RemoteAccessTransport } from '@deepseek-ai/dsh-remote-access-client'
import {
  IndexedDbMobilePairingStateStore, PairingCompanionKeyVault,
} from '../src/companion-keys.ts'
import { companionMayMutate, CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import { MobilePairingController } from '../src/personal-pairing.ts'

describe('MobilePairingController', () => {
  it('switches the real Relay lifecycle to one explicit Paired Desktop and unpairs only that selection', async () => {
    const accountId = parsePlatformAccountId('account-mobile')
    const home = parsePersonalPairingId('pairing-home')
    const work = parsePersonalPairingId('pairing-work')
    const homeGrant = {
      routeId: parseRelayRouteId('route-home'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(home),
    }
    const workGrant = {
      routeId: parseRelayRouteId('route-work'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), revision: 1,
      pairingSelector: parseRelayPairingSelector(work),
    }
    const vault = new PairingCompanionKeyVault()
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(home, new Uint8Array(96).fill(1), new Uint8Array(32).fill(2), homeGrant)
    vault.recordDesktopName(home, 'Home Mac')
    vault.retainConfirmedPairing(work, new Uint8Array(96).fill(3), new Uint8Array(32).fill(4), workGrant)
    vault.recordDesktopName(work, 'Work Mac')
    vault.selectPairing(home)
    const transitions: string[] = []
    const companion = {
      configure: vi.fn((grant?: typeof homeGrant) => { transitions.push(`configure:${grant?.routeId ?? 'none'}`) }),
      start: vi.fn(async () => { transitions.push('start') }),
      stop: vi.fn(async () => { transitions.push('stop') }),
      forgetConnection: vi.fn(() => { transitions.push('forget') }),
      releasePairing: vi.fn(async () => { transitions.push('release') }),
    }
    const releaseProjectionAuthority = vi.fn(async (deleteStored: boolean) => {
      transitions.push(`projection:${String(deleteStored)}`)
    })
    const transport = transportFixture()
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport,
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn(), wipe: vi.fn() },
      scanner: { scan: vi.fn() },
      relay: companion,
      companion,
      attachmentKeys: vault,
      releaseProjectionAuthority,
    })

    await controller.activate()
    expect(controller.getSnapshot()).toEqual({
      status: 'paired',
      desktops: [
        { pairingId: home, desktopName: 'Home Mac' },
        { pairingId: work, desktopName: 'Work Mac' },
      ],
      selectedPairingId: home,
    })
    transitions.length = 0

    await controller.selectDesktop(work)

    expect(transitions).toEqual(['forget', 'projection:false', 'release', 'configure:route-work', 'start'])
    expect(vault.selectedPairingId()).toBe(work)
    expect(vault.relayAuthority()).toEqual(workGrant)
    expect(controller.getSnapshot()).toMatchObject({ status: 'paired', selectedPairingId: work })

    await controller.unpair()

    expect(transport.revokeMobilePersonalPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId: work }))
    expect(vault.attachmentKeyMaterial(work)).toBeUndefined()
    expect(vault.attachmentKeyMaterial(home)).toEqual(new Uint8Array(32).fill(2))
    expect(controller.getSnapshot()).toEqual({
      status: 'paired',
      desktops: [{ pairingId: home, desktopName: 'Home Mac' }],
      selectedPairingId: undefined,
    })
  })

  it.each(['Remote Offline', 'Platform capacity'])('publishes and persists an offline selection while %s retries', async () => {
    const accountId = parsePlatformAccountId('account-offline-selection')
    const home = parsePersonalPairingId('pairing-offline-home')
    const work = parsePersonalPairingId('pairing-offline-work')
    const homeGrant = {
      routeId: parseRelayRouteId('route-offline-home'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(home),
    }
    const workGrant = {
      routeId: parseRelayRouteId('route-offline-work'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), revision: 1,
      pairingSelector: parseRelayPairingSelector(work),
    }
    const save = vi.fn(async () => {})
    const vault = new PairingCompanionKeyVault({ load: vi.fn(async () => ({ active: [] })), save })
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(home, new Uint8Array(96).fill(1), new Uint8Array(32).fill(2), homeGrant)
    vault.retainConfirmedPairing(work, new Uint8Array(96).fill(3), new Uint8Array(32).fill(4), workGrant)
    vault.selectPairing(home)
    await vault.flush()
    save.mockClear()

    const retries: Array<ReturnType<typeof deferred<undefined>>> = []
    const relay = {
      configure: vi.fn(),
      start: vi.fn(async () => {
        const retry = deferred<undefined>()
        retries.push(retry)
        await retry.promise
      }),
      stop: vi.fn(async () => { retries.at(-1)?.resolve(undefined) }),
      isConnected: vi.fn(() => false),
    }
    const companion = new CompanionForegroundRuntime({ relay })
    const controller = new MobilePairingController({
      installation: installationFixture(() => accountId), transport: transportFixture(),
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn() }, scanner: { scan: vi.fn() },
      attachmentKeys: vault, relay: companion, companion,
      releaseProjectionAuthority: vi.fn(async () => {}),
    })
    const selectedSnapshots: PersonalPairingId[] = []
    controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      if (snapshot.status === 'paired' && snapshot.selectedPairingId !== undefined) {
        selectedSnapshots.push(snapshot.selectedPairingId)
      }
    })
    await controller.activate()
    expect(relay.configure).toHaveBeenCalledWith(homeGrant)
    await vi.waitFor(() => { expect(relay.start).toHaveBeenCalledOnce() })
    selectedSnapshots.length = 0

    let settled = false
    const selecting = controller.selectDesktop(work).then(() => { settled = true })
    await vi.waitFor(() => { expect(settled).toBe(true) })
    await selecting

    expect(vault.selectedPairingId()).toBe(work)
    expect(save).toHaveBeenCalledWith(accountId, expect.objectContaining({ selectedPairingId: work }))
    expect(selectedSnapshots.at(-1)).toBe(work)
    expect(controller.getSnapshot()).toMatchObject({ status: 'paired', selectedPairingId: work })
    expect(companionMayMutate(companion.getState())).toBe(false)
    await vi.waitFor(() => { expect(relay.start).toHaveBeenCalledTimes(2) })
    retries.at(-1)?.resolve()
  })

  it('ignores a replaced Relay activation generation after another Desktop is selected', async () => {
    const accountId = parsePlatformAccountId('account-generation-selection')
    const home = parsePersonalPairingId('pairing-generation-home')
    const work = parsePersonalPairingId('pairing-generation-work')
    const grant = (pairingId: PersonalPairingId, routeId: string, credential: string) => ({
      routeId: parseRelayRouteId(routeId), endpoint: 'mobile' as const,
      credential: parseRelayCredential(credential), revision: 1,
      pairingSelector: parseRelayPairingSelector(pairingId),
    })
    const homeGrant = grant(home, 'route-generation-home', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE')
    const workGrant = grant(work, 'route-generation-work', 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI')
    const vault = new PairingCompanionKeyVault()
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(home, new Uint8Array(96).fill(1), new Uint8Array(32).fill(2), homeGrant)
    vault.retainConfirmedPairing(work, new Uint8Array(96).fill(3), new Uint8Array(32).fill(4), workGrant)
    vault.selectPairing(home)
    const activations: Array<{ promise: Promise<void>; reject(error: Error): void }> = []
    const relay = {
      configure: vi.fn(),
      start: vi.fn(() => {
        let reject!: (error: Error) => void
        const promise = new Promise<void>((_resolve, onReject) => { reject = onReject })
        activations.push({ promise, reject })
        return promise
      }),
      stop: vi.fn(async () => {}),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(), transport: transportFixture(),
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn() }, scanner: { scan: vi.fn() },
      attachmentKeys: vault, relay,
      releaseProjectionAuthority: vi.fn(async () => {}),
    })

    await controller.selectDesktop(work)
    await vi.waitFor(() => { expect(activations).toHaveLength(1) })
    await controller.selectDesktop(home)
    await vi.waitFor(() => { expect(activations).toHaveLength(2) })
    activations[0]?.reject(new Error('replaced Relay activation stopped'))
    await Promise.resolve()

    expect(vault.selectedPairingId()).toBe(home)
    expect(controller.getSnapshot()).toEqual({
      status: 'paired',
      desktops: [{ pairingId: home }, { pairingId: work }],
      selectedPairingId: home,
    })
  })

  it('revokes a durable selection even when no Relay channel is active', async () => {
    const accountId = parsePlatformAccountId('account-mobile')
    const pairingId = parsePersonalPairingId('pairing-durable-offline')
    const grant = {
      routeId: parseRelayRouteId('route-durable-offline'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(pairingId),
    }
    const vault = new PairingCompanionKeyVault()
    await vault.selectAccount(accountId)
    vault.retainConfirmedPairing(
      pairingId, new Uint8Array(96).fill(1), new Uint8Array(32).fill(2), grant,
    )
    const transport = transportFixture()
    const controller = new MobilePairingController({
      installation: installationFixture(), transport,
      handshake: { begin: vi.fn(), acceptDesktopHandshake: vi.fn(), wipe: vi.fn() },
      attachmentKeys: vault, scanner: { scan: vi.fn() },
    })

    await controller.unpair()

    expect(transport.revokeMobilePersonalPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId }))
    expect(vault.attachmentKeyMaterial(pairingId)).toBeUndefined()
    expect(controller.getSnapshot()).toEqual({ status: 'ready' })
  })

  it('recovers a pending Snow transcript and post-open authority across full controller restarts', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const store = new IndexedDbMobilePairingStateStore(`mobile-restart-${crypto.randomUUID()}`)
    const desktop = new SnowDesktopEndpointPairingOwner()
    const expiresAt = Date.now() + 60_000
    const invitation = await desktop.createInvitation(expiresAt)
    const link = 'https://platform.example/pair?challenge=challenge-restart'
      + `&payload=${Buffer.from(invitation.invitationPayload).toString('base64url')}`
      + `&expires=${String(expiresAt)}&protocol=1`
    const pendingPairingId = parsePendingPairingId('pending-restart')
    const scheduledOne: Array<() => void> = []
    const transportOne = transportFixture()
    let message2: Uint8Array | undefined
    transportOne.submitEndpointMessage1.mockImplementation(async (
      input: Parameters<RemoteAccessTransport['submitEndpointMessage1']>[0],
    ) => {
      message2 = await desktop.acceptMessage1(input.message1)
      return { pendingPairingId }
    })
    transportOne.getEndpointPairingStatus.mockImplementation(async () => ({
      stage: 'message2' as const, pendingPairingId,
      message2: message2 ?? (() => { throw new Error('Desktop message 2 is unavailable') })(),
      device: { name: 'Alice phone', platform: 'ios' as const },
    }))
    transportOne.submitEndpointMessage3.mockImplementation(async (
      input: Parameters<RemoteAccessTransport['submitEndpointMessage3']>[0],
    ) => {
      await desktop.finishMessage3(input.message3)
    })
    const first = new MobilePairingController({
      installation: installationFixture(), transport: transportOne, handshake: new SnowMobileHandshakeClient(),
      attachmentKeys: new PairingCompanionKeyVault(store), scanner: { scan: vi.fn() },
      schedule: (task) => { scheduledOne.push(task); return { unref: vi.fn() } as never },
    })
    await first.completeLink(link)
    scheduledOne.shift()?.()
    await vi.waitFor(() => { expect(transportOne.submitEndpointMessage3).toHaveBeenCalledOnce() })
    await first.deactivate()

    const pairingId = parsePersonalPairingId('pairing-restart')
    const grant = {
      routeId: parseRelayRouteId('route-restart'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(pairingId),
    }
    const sealedRelayAuthority = await desktop.sealMobileRelayAuthority(grant, new Uint8Array(32).fill(41))
    const scheduledTwo: Array<() => void> = []
    const transportTwo = transportFixture()
    transportTwo.getEndpointPairingStatus.mockResolvedValue({
      stage: 'confirmed', pendingPairingId, pairingId, sealedRelayAuthority,
    })
    const relayTwo = {
      configure: vi.fn(), start: vi.fn(async () => { throw new Error('Relay start failed after durable commit') }),
      stop: vi.fn(),
    }
    const open = vi.spyOn(SnowMobileHandshakeClient.prototype, 'openRelayAuthorityDurably')
    const second = new MobilePairingController({
      installation: installationFixture(), transport: transportTwo, handshake: new SnowMobileHandshakeClient(),
      attachmentKeys: new PairingCompanionKeyVault(store), relay: relayTwo, scanner: { scan: vi.fn() },
      schedule: (task) => { scheduledTwo.push(task); return { unref: vi.fn() } as never },
    })
    await second.activate()
    scheduledTwo.shift()?.()
    await vi.waitFor(() => {
      expect(second.getSnapshot()).toMatchObject({
        status: 'paired', selectedPairingId: pairingId,
        error: 'Relay start failed after durable commit',
      })
    })
    expect(open).toHaveBeenCalledOnce()
    await second.deactivate()

    const relayThree = { configure: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const third = new MobilePairingController({
      installation: installationFixture(), transport: transportFixture(), handshake: new SnowMobileHandshakeClient(),
      attachmentKeys: new PairingCompanionKeyVault(store), relay: relayThree, scanner: { scan: vi.fn() },
      schedule: () => ({ unref: vi.fn() }) as never,
    })
    await third.activate()
    expect(relayThree.configure).toHaveBeenCalledWith(grant)
    expect(relayThree.start).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    open.mockRestore()
    await third.deactivate()
  })

  it('completes endpoint-owned XKpsk3 through the opaque mailbox and retains reconnect state', async () => {
    const scheduled: Array<() => void> = []
    const transport = transportFixture()
    const pendingPairingId = parsePendingPairingId('pending-endpoint')
    transport.submitEndpointMessage1.mockResolvedValue({ pendingPairingId })
    transport.getEndpointPairingStatus
      .mockResolvedValueOnce({
        stage: 'message2', pendingPairingId, message2: Uint8Array.of(2),
        device: { name: 'Alice phone', platform: 'ios' },
      })
      .mockResolvedValueOnce({ stage: 'awaiting-authority', pendingPairingId })
      .mockResolvedValueOnce({
        stage: 'confirmed', pendingPairingId, pairingId: parsePersonalPairingId('pairing-endpoint'),
        sealedRelayAuthority: Uint8Array.of(8, 9),
      })
      .mockResolvedValueOnce({
        stage: 'confirmed', pendingPairingId, pairingId: parsePersonalPairingId('pairing-endpoint'),
        sealedRelayAuthority: Uint8Array.of(8, 9),
      })
    const grant = {
      routeId: parseRelayRouteId('route-endpoint'), endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision: 1,
      pairingSelector: parseRelayPairingSelector(parsePersonalPairingId('pairing-endpoint')),
    }
    const reconnectState = new Uint8Array(96).fill(5)
    const attachmentKey = new Uint8Array(32).fill(7)
    const handshake = {
      begin: vi.fn(async () => { throw new Error('legacy begin must not run') }),
      beginEndpointInvitation: vi.fn(async () => Uint8Array.of(1)),
      acceptDesktopHandshake: vi.fn(),
      exportFinishMessage: vi.fn(() => Uint8Array.of(3)),
      exportAuthenticationHash: vi.fn(() => new Uint8Array(32).fill(4)),
      exportRecoveryState: vi.fn(() => new Uint8Array(32).fill(6)),
      openRelayAuthorityDurably: vi.fn(async (_sealed: Uint8Array, persist: (
        openedGrant: typeof grant, reconnectState: Uint8Array, attachmentKey: Uint8Array,
      ) => Promise<void>) => {
        await persist(grant, reconnectState, attachmentKey)
        return grant
      }),
      exportReconnectState: vi.fn(() => reconnectState.slice()),
      exportAttachmentKey: vi.fn(() => attachmentKey.slice()),
    }
    const vault = new PairingCompanionKeyVault()
    const relay = {
      configure: vi.fn(),
      start: vi.fn().mockRejectedValueOnce(new Error('Relay start failed')),
      stop: vi.fn(),
    }
    const controller = new MobilePairingController({
      installation: installationFixture(), transport, handshake, relay, attachmentKeys: vault,
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })
    const payload = btoa(String.fromCharCode(7, 8)).replaceAll('=', '')
    await controller.completeLink(
      `https://platform.example/pair?challenge=challenge-endpoint&payload=${payload}`
      + `&expires=${String(Date.parse('2026-08-18T10:02:00.000Z'))}&protocol=1`,
    )
    expect(transport.submitEndpointMessage1).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: 'challenge-endpoint', message1: Uint8Array.of(1),
    }))

    scheduled.shift()?.()
    await vi.waitFor(() => { expect(transport.submitEndpointMessage3).toHaveBeenCalled() })
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending' })
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(transport.getEndpointPairingStatus).toHaveBeenCalledTimes(2) })
    scheduled.shift()?.()
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        status: 'paired', selectedPairingId: 'pairing-endpoint', error: 'Relay start failed',
      })
    })
    expect(handshake.openRelayAuthorityDurably).toHaveBeenCalledWith(Uint8Array.of(8, 9), expect.any(Function))
    expect(handshake.openRelayAuthorityDurably).toHaveBeenCalledTimes(1)
    expect(vault.attachmentKeyMaterial(parsePersonalPairingId('pairing-endpoint'))).toEqual(attachmentKey)
    expect(vault.reconnectState(parsePersonalPairingId('pairing-endpoint'))).toEqual(reconnectState)
    expect(relay.configure).toHaveBeenCalledWith(grant)
    expect(relay.start).toHaveBeenCalledOnce()
  })

  it('finishes XKpsk3 with a fresh Installation proof before exposing authentication words', async () => {
    const transport = transportFixture()
    const finish = Uint8Array.of(3, 4)
    let observedFinish: Uint8Array | undefined
    let observedProof: string | undefined
    transport.finishChallenge.mockImplementationOnce(async (input) => {
      observedFinish = input.mobileFinish.slice()
      observedProof = input.authentication.proof.jti
      return {
        pendingPairingId: parsePendingPairingId('pending-one'),
        authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
        desktopHandshake: Uint8Array.of(8),
        device: { name: 'Alice phone', platform: 'ios' },
      }
    })
    const authorizeCurrentInstallation = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'mobile-access', proof: { jti: parseAccountProofJti('proof-one'), issuedAt: 1, signature: 'one' } })
      .mockResolvedValueOnce({ accessToken: 'mobile-access', proof: { jti: parseAccountProofJti('proof-two'), issuedAt: 2, signature: 'two' } })
    const installation = {
      authorizeCurrentInstallation,
      getSnapshot: vi.fn(() => ({
        status: 'signed-in' as const,
        privacyAccepted: true,
        account: { id: 'account-mobile' as never, githubId: 1, githubLogin: 'mobile', avatarUrl: '' },
      })),
    }
    const handshake = {
      begin: vi.fn(async () => ({
        completionId: parsePairingCompletionId('three-message'), mobileHandshake: Uint8Array.of(1),
      })),
      acceptDesktopHandshake: vi.fn(),
      exportFinishMessage: vi.fn(() => finish.slice()),
    }
    const controller = new MobilePairingController({
      installation,
      transport,
      handshake,
      scanner: { scan: vi.fn() },
      schedule: () => ({ unref: vi.fn() }) as never,
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })

    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))

    expect(observedProof).toBe('proof-two')
    expect(observedFinish).toEqual(finish)
    expect(authorizeCurrentInstallation).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ status: 'pending' })
  })

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
    await vi.waitFor(() => { expect(controller.getSnapshot()).toMatchObject({ status: 'paired' }) })

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
      attachmentKeys: vault,
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })
    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    expect(vault.attachmentKeyMaterial(parsePersonalPairingId('pairing-key'))).toBeUndefined()
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toMatchObject({ status: 'paired' }) })
    expect(vault.attachmentKeyMaterial(parsePersonalPairingId('pairing-key'))).toEqual(material)
    await controller.unpair()
    expect(vault.attachmentKeyMaterial(parsePersonalPairingId('pairing-key'))).toBeUndefined()
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
    const installation = installationFixture()
    const controller = new MobilePairingController({
      installation, transport, handshake, relay: companion, companion,
      scanner: { scan: vi.fn() },
      schedule: (task) => { scheduled.push(task); return { unref: vi.fn() } as never },
      now: () => Date.parse('2026-08-18T10:01:00.000Z'),
    })
    await controller.completeLink(pairingLink(Date.parse('2026-08-18T10:02:00.000Z')))
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(controller.getSnapshot()).toMatchObject({ status: 'paired' }) })

    await controller.unpair()

    expect(transport.revokeMobilePersonalPairing).toHaveBeenCalledWith({
      authentication: await installation.authorizeCurrentInstallation(),
      pairingId: 'pairing-one',
    })
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
    const pairingId = parsePersonalPairingId('pairing-cleanup-failures')
    const attachmentKeys = {
      retain: vi.fn(),
      retainedPairingId: vi.fn(() => pairingId),
      pairedDesktops: vi.fn(() => [{ pairingId }]),
      selectedPairingId: vi.fn(() => pairingId),
      selectAccount: vi.fn(),
      relayAuthority: vi.fn(),
      release: vi.fn(() => { throw new Error('pairing key release failed') }),
      flush: vi.fn(),
      wipe: vi.fn(),
    }
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
      attachmentKeys,
      companion,
      relay,
      scanner: { scan: vi.fn() },
    })
    await controller.activate()

    const failure = await controller.unpair().then(
      () => undefined,
      (error: unknown) => error as AggregateError,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure?.message).toBe('Mobile Personal Pairing unpair failed')
    expect(failure?.errors).toEqual([
      expect.objectContaining({ message: 'handshake wipe failed' }),
      expect.objectContaining({ message: 'pairing key release failed' }),
      expect.objectContaining({ message: 'Companion release failed' }),
      expect.objectContaining({ message: 'Relay revoke failed' }),
      expect.objectContaining({ message: 'Relay stop failed' }),
    ])
    expect(handshake.wipe).toHaveBeenCalledOnce()
    expect(attachmentKeys.release).toHaveBeenCalledWith(pairingId)
    expect(companion.releasePairing).toHaveBeenCalledOnce()
    expect(relay.configure).toHaveBeenCalledWith(undefined)
    expect(relay.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({
      status: 'unpair-failed',
      error: 'Mobile Personal Pairing unpair failed',
    })
  })

  it('retains durable pairing authority across restart until Platform revocation succeeds', async () => {
    const pairingId = parsePersonalPairingId('pairing-revoke-retry')
    const grant = {
      routeId: parseRelayRouteId('route-revoke-retry'),
      endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
      revision: 1,
    }
    const transport = transportFixture()
    transport.revokeMobilePersonalPairing
      .mockRejectedValueOnce(new Error('Platform revoke failed'))
      .mockResolvedValueOnce(undefined)
    let retainedPairingId: PersonalPairingId | undefined = pairingId
    let retainedGrant: typeof grant | undefined = grant
    const attachmentKeys = {
      retain: vi.fn(),
      retainedPairingId: vi.fn(() => retainedPairingId),
      relayAuthority: vi.fn(() => retainedGrant),
      selectAccount: vi.fn(),
      pairedDesktops: vi.fn(() => retainedPairingId === undefined ? [] : [{ pairingId: retainedPairingId }]),
      selectedPairingId: vi.fn(() => retainedPairingId),
      release: vi.fn(() => {
        retainedPairingId = undefined
        retainedGrant = undefined
      }),
      wipe: vi.fn(),
      flush: vi.fn(),
    }
    const relay = { configure: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const handshake = { begin: vi.fn(), acceptDesktopHandshake: vi.fn(), wipe: vi.fn() }
    const firstController = new MobilePairingController({
      installation: installationFixture(),
      transport,
      handshake,
      attachmentKeys,
      relay,
      scanner: { scan: vi.fn() },
    })
    await firstController.activate()

    await expect(firstController.unpair()).rejects.toThrow('Mobile Personal Pairing unpair failed')
    expect(firstController.getSnapshot()).toEqual({
      status: 'unpair-failed', error: 'Mobile Personal Pairing unpair failed',
    })
    expect(handshake.wipe).not.toHaveBeenCalled()
    expect(attachmentKeys.wipe).not.toHaveBeenCalled()
    expect(attachmentKeys.flush).not.toHaveBeenCalled()

    const restartedController = new MobilePairingController({
      installation: installationFixture(),
      transport,
      handshake,
      attachmentKeys,
      relay,
      scanner: { scan: vi.fn() },
    })
    await restartedController.activate()
    expect(restartedController.getSnapshot()).toMatchObject({ status: 'paired' })
    await expect(restartedController.unpair()).resolves.toBeUndefined()
    expect(transport.revokeMobilePersonalPairing).toHaveBeenCalledTimes(2)
    expect(transport.revokeMobilePersonalPairing).toHaveBeenLastCalledWith(expect.objectContaining({ pairingId }))
    expect(attachmentKeys.release).toHaveBeenCalledOnce()
    expect(restartedController.getSnapshot()).toEqual({ status: 'ready' })
  })

  it('keeps unpair retryable until pairing-owned projection deletion succeeds', async () => {
    const pairingId = parsePersonalPairingId('pairing-cache-retry')
    let retainedPairingId: PersonalPairingId | undefined = pairingId
    const releaseProjectionAuthority = vi.fn()
      .mockRejectedValueOnce(new Error('projection delete failed'))
      .mockResolvedValueOnce(undefined)
    const attachmentKeys = {
      retain: vi.fn(),
      retainedPairingId: vi.fn(() => retainedPairingId),
      pairedDesktops: vi.fn(() => retainedPairingId === undefined ? [] : [{ pairingId: retainedPairingId }]),
      selectedPairingId: vi.fn(() => retainedPairingId),
      selectAccount: vi.fn(),
      release: vi.fn(() => { retainedPairingId = undefined }),
      wipe: vi.fn(),
      flush: vi.fn(),
    }
    const handshake = { begin: vi.fn(), acceptDesktopHandshake: vi.fn(), wipe: vi.fn() }
    const controller = new MobilePairingController({
      installation: installationFixture(),
      transport: transportFixture(),
      handshake,
      attachmentKeys,
      releaseProjectionAuthority,
      scanner: { scan: vi.fn() },
    })
    await controller.activate()

    await expect(controller.unpair()).rejects.toThrow('Mobile Personal Pairing unpair failed')
    expect(controller.getSnapshot()).toEqual({
      status: 'unpair-failed', error: 'Mobile Personal Pairing unpair failed',
    })
    expect(handshake.wipe).not.toHaveBeenCalled()
    expect(attachmentKeys.release).not.toHaveBeenCalled()

    await expect(controller.unpair()).resolves.toBeUndefined()
    expect(releaseProjectionAuthority).toHaveBeenCalledTimes(2)
    expect(handshake.wipe).toHaveBeenCalledOnce()
    expect(attachmentKeys.release).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'ready' })
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
    await vi.waitFor(() => { expect(controller.getSnapshot()).toMatchObject({ status: 'paired' }) })
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
    createEndpointChallenge: vi.fn(),
    cancelEndpointChallenge: vi.fn(),
    listEndpointPending: vi.fn(),
    submitEndpointMessage2: vi.fn(),
    confirmEndpointPairing: vi.fn(),
    rejectEndpointPairing: vi.fn(),
    deliverEndpointRelayAuthority: vi.fn(),
    cancelChallenge: vi.fn(),
    listPendingPairings: vi.fn(),
    listPersonalPairings: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
    revokePersonalPairing: vi.fn(),
    revokeMobilePersonalPairing: vi.fn(),
    completeChallenge: vi.fn<RemoteAccessTransport['completeChallenge']>().mockResolvedValue({
      pendingPairingId: parsePendingPairingId('pending-one'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(8),
      device: { name: 'Fixture installation', platform: 'ios' },
    }),
    submitEndpointMessage1: vi.fn(),
    getEndpointPairingStatus: vi.fn(),
    submitEndpointMessage3: vi.fn(),
    finishChallenge: vi.fn<RemoteAccessTransport['finishChallenge']>().mockResolvedValue({
      pendingPairingId: parsePendingPairingId('pending-one'),
      authenticationWords: ['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'],
      desktopHandshake: Uint8Array.of(8),
      device: { name: 'Alice phone', platform: 'ios' },
    }),
    getMobilePairingStatus: vi.fn().mockResolvedValue({ status: 'paired', pairingId: 'pairing-one' }),
  } satisfies RemoteAccessTransport
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
