import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AccountProof, PlatformAccountView } from '@deepseek-ai/dsh-platform-account'
import { parseAccountProofJti, parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import { parseRelayCredential, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  MAX_ACTIVE_PAIRING_CHALLENGES_PER_INSTALLATION,
  MAX_PENDING_PAIRINGS_PER_INSTALLATION,
  MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION,
  OPEN_REGISTRATION_QUOTAS,
  PERSONAL_PAIRING_PROTOCOL_MAJOR,
  PAIRING_CHALLENGE_TTL_MS,
  PAIRING_CHALLENGE_QUOTA_WINDOW_MS,
  PAIRING_REPLAY_RETENTION_MS,
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  RemoteAccessService,
  RemoteAccessError,
  type PersonalPairingProviderOptions,
  deriveAuthenticationWords,
  parseDevicePrincipalId,
  parsePairingChallengeId,
  parsePairingInvitationLink,
  parsePairingCompletionId,
  parsePairingRendezvousId,
  parsePendingPairingId,
  parsePersonalPairingId,
  parseRelayConnectionToken,
  parseRelayCredentialFingerprint,
  type PairingHandshakeProvider,
  type EndpointStoredPersonalPairing,
  type StoredPersonalPairing,
} from '../src/index.ts'

const NOW = Date.parse('2026-08-18T10:00:00.000Z')

describe('PersonalPairingProvider', () => {
  it('keeps the service default three-message finish fail closed', async () => {
    await expect(RemoteAccessService.prototype.finishChallenge.call({} as RemoteAccessService, {
      mobile: authentication('mobile-installation'),
      pendingPairingId: parsePendingPairingId('pending-default-finish'),
      mobileFinish: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
  })

  it('validates endpoint invitation and confirmation stages before publication', async () => {
    let identity = 0
    const provider = configuredProvider({
      clock: { now: () => NOW }, randomId: kind => `${kind}-endpoint-guards-${String(identity += 1)}`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await expect(provider.createEndpointChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('disabled'), clientIp: '192.0.2.1',
      expiresAt: NOW + 1,
    })).rejects.toMatchObject({ code: 'MOBILE_ACCESS_DISABLED' })
    await expect(provider.setMobileAccess({ desktop, enabled: false })).resolves.toEqual({ enabled: false })
    await provider.setMobileAccess({ desktop, enabled: true })
    for (const expiresAt of [NOW, NOW + PAIRING_CHALLENGE_TTL_MS + 1, NOW + 1.5]) {
      await expect(provider.createEndpointChallenge({
        desktop, rendezvousId: parsePairingRendezvousId(`invalid-${String(expiresAt)}`),
        clientIp: '192.0.2.1', expiresAt,
      })).rejects.toMatchObject({ code: 'PAIRING_CHALLENGE_INVALID' })
    }
    const cancelled = await provider.createEndpointChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('cancel-endpoint'), clientIp: '192.0.2.1',
      expiresAt: NOW + 10_000,
    })
    await provider.cancelEndpointChallenge({ desktop, challengeId: cancelled.challengeId })

    const incomplete = await prepareEndpointPairing(provider, desktop, mobile, 'incomplete', 'message1')
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: incomplete.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    await provider.rejectEndpointPairing({ desktop, pendingPairingId: incomplete.pendingPairingId })
    await expect(provider.getEndpointPairingStatus({ mobile, completionId: incomplete.completionId }))
      .resolves.toMatchObject({ stage: 'rejected' })

    const complete = await prepareEndpointPairing(provider, desktop, mobile, 'complete-no-relay', 'message3')
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: complete.pendingPairingId,
      desktopCredentialDigest: Uint8Array.of(1), mobileCredentialDigest: Uint8Array.of(2),
    })).rejects.toThrow('must contain 32 bytes')
    await expect(provider.confirmEndpointPairing({
      desktop: authentication('desktop-other'), pendingPairingId: complete.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: complete.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toThrow('cannot register endpoint-owned pairing authority')
  })

  it('lets Mobile polling reconcile one retained endpoint publication without duplicate identity', async () => {
    const routeId = parseRelayRouteId('route-poll-publication')
    const relay = relayStub(routeId, 1)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const firstRegistration = deferred<number>()
    const secondRegistration = deferred<number>()
    relay.registerPairingCredentialDigests
      .mockImplementationOnce(async () => await firstRegistration.promise)
      .mockImplementationOnce(async () => await secondRegistration.promise)
      .mockResolvedValue(1)
    const provider = configuredProvider({
      relay, authority, clock: { now: () => NOW }, randomId: kind => `${kind}-poll-publication`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, 'poll-publication', 'message3')
    const first = provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(4),
      mobileCredentialDigest: new Uint8Array(32).fill(5),
    })
    await vi.waitFor(() => { expect(relay.registerPairingCredentialDigests).toHaveBeenCalledOnce() })
    const withoutRelay = configuredProvider({ authority, clock: { now: () => NOW } })
    await expect(withoutRelay.getEndpointPairingStatus({ mobile, completionId: pending.completionId }))
      .rejects.toThrow('cannot register endpoint-owned pairing authority')
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(4),
      mobileCredentialDigest: new Uint8Array(32).fill(6),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    const repeated = provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(4),
      mobileCredentialDigest: new Uint8Array(32).fill(5),
    })
    await vi.waitFor(() => { expect(relay.registerPairingCredentialDigests).toHaveBeenCalledTimes(2) })
    await provider.setMobileAccess({ desktop: authentication('desktop-other'), enabled: false })
    await authority.runPairingTransaction((state) => {
      const publication = state.endpointPublications.get(pending.pendingPairingId)
      if (publication === undefined) throw new Error('expected retained publication')
      state.pairings.set(publication.pairing.id, {
        ...publication.pairing, endpointRelayRevision: 1,
      })
      state.principalIds.add(publication.pairing.devicePrincipal.id)
      return Promise.resolve()
    })
    await expect(provider.getEndpointPairingStatus({ mobile, completionId: pending.completionId }))
      .resolves.toMatchObject({ stage: 'message2' })
    await authority.runPairingTransaction((state) => {
      state.endpointPublications.delete(pending.pendingPairingId)
      return Promise.resolve()
    })
    secondRegistration.resolve(1)
    await expect(repeated).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    firstRegistration.resolve(1)
    await expect(first).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    expect(relay.registerPairingCredentialDigests).toHaveBeenCalledTimes(3)
    const [activePairing] = await provider.listPersonalPairings(desktop)
    if (activePairing === undefined) throw new Error('expected recovered endpoint pairing')
    await provider.revokePersonalPairing({ desktop, pairingId: activePairing.id })
    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    await provider.setMobileAccess({ desktop, enabled: false })
    expect(relay.revokeCredentialDigest).toHaveBeenCalledTimes(6)
  })

  it('enforces endpoint invitation and pending capacity for each owning installation', async () => {
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    const activeAuthority = new MemoryPersonalPairingAuthorityStore()
    const active = configuredProvider({
      authority: activeAuthority, clock: { now: () => NOW },
      randomId: kind => `${kind}-active-capacity`,
    })
    await active.setMobileAccess({ desktop, enabled: true })
    await activeAuthority.runPairingTransaction((state) => {
      state.endpointMailbox = {
        challenges: Array.from({ length: MAX_ACTIVE_PAIRING_CHALLENGES_PER_INSTALLATION }, (_, index) => ({
          challengeId: parsePairingChallengeId(`active-${String(index)}`),
          accountId: 'account-one' as never, desktopInstallationId: parseInstallationId('desktop-installation'),
          expiresAt: NOW + 60_000,
        })),
        pending: [],
      }
      return Promise.resolve()
    })
    await expect(active.createEndpointChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('over-active'), clientIp: '192.0.2.1',
      expiresAt: NOW + 60_000,
    })).rejects.toMatchObject({ code: 'PAIRING_RESOURCE_LIMIT' })

    for (const owner of ['mobile', 'desktop'] as const) {
      const authority = new MemoryPersonalPairingAuthorityStore()
      let sequence = 0
      const provider = configuredProvider({
        authority, clock: { now: () => NOW },
        randomId: kind => `${kind}-${owner}-capacity-${String(sequence += 1)}`,
      })
      await provider.setMobileAccess({ desktop, enabled: true })
      const challenge = await provider.createEndpointChallenge({
        desktop, rendezvousId: parsePairingRendezvousId(`${owner}-capacity`), clientIp: '192.0.2.2',
        expiresAt: NOW + 60_000,
      })
      await authority.runPairingTransaction((state) => {
        state.endpointMailbox = {
          challenges: state.endpointMailbox.challenges,
          pending: Array.from({ length: MAX_PENDING_PAIRINGS_PER_INSTALLATION }, (_, index) => ({
            pendingPairingId: parsePendingPairingId(`${owner}-pending-${String(index)}`),
            completionId: parsePairingCompletionId(`${owner}-completion-${String(index)}`),
            challengeId: parsePairingChallengeId(`${owner}-old-${String(index)}`),
            accountId: 'account-one' as never,
            desktopInstallationId: parseInstallationId('desktop-installation'),
            mobileInstallationId: parseInstallationId(owner === 'mobile' ? 'mobile-installation' : `other-${String(index)}`),
            device: { name: 'Phone', platform: 'ios' }, expiresAt: NOW + 60_000,
            message1: Uint8Array.of(1), confirmed: false, rejected: false,
          })),
        }
        return Promise.resolve()
      })
      await expect(provider.submitEndpointMessage1({
        mobile, challengeId: challenge.challengeId,
        completionId: parsePairingCompletionId(`${owner}-over-capacity`),
        message1: Uint8Array.of(1),
      })).rejects.toMatchObject({ code: 'PAIRING_RESOURCE_LIMIT' })
    }
  })

  it('counts retained endpoint publications against both endpoint installation owners', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const relay = relayStub(parseRelayRouteId('route-publication-capacity'), 1)
    const registration = deferred<number>()
    relay.registerPairingCredentialDigests.mockImplementationOnce(async () => await registration.promise)
    let sequence = 0
    const provider = configuredProvider({
      authority, relay, clock: { now: () => NOW },
      randomId: kind => `${kind}-publication-capacity-${String(sequence += 1)}`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, 'publication-capacity', 'message3')
    const confirming = provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })
    await vi.waitFor(() => { expect(relay.registerPairingCredentialDigests).toHaveBeenCalledOnce() })
    await authority.runPairingTransaction((state) => {
      const publication = state.endpointPublications.get(pending.pendingPairingId)
      if (publication === undefined) throw new Error('expected retained publication')
      const mailboxRecord = state.endpointMailbox.pending.find(
        record => record.pendingPairingId === pending.pendingPairingId,
      )
      if (mailboxRecord === undefined) throw new Error('expected retained mailbox record')
      const retainedPending = [...state.endpointMailbox.pending]
      for (let index = 1; index < MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION; index += 1) {
        const pendingPairingId = parsePendingPairingId(`publication-capacity-${String(index)}`)
        const pairingId = parsePersonalPairingId(`publication-capacity-${String(index)}`)
        state.endpointPublications.set(pendingPairingId, {
          ...publication,
          pendingPairingId,
          pairing: {
            ...publication.pairing,
            id: pairingId,
            endpointPendingPairingId: pendingPairingId,
          },
        })
        retainedPending.push({
          ...mailboxRecord,
          pendingPairingId,
          completionId: parsePairingCompletionId(`publication-capacity-${String(index)}`),
          pairingId,
          confirmed: true,
        })
      }
      state.endpointMailbox = { ...state.endpointMailbox, pending: retainedPending }
      return Promise.resolve()
    })
    await expect(provider.createEndpointChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('publication-capacity-over-desktop'),
      clientIp: '192.0.2.99', expiresAt: NOW + 60_000,
    })).rejects.toMatchObject({ code: 'PAIRING_RESOURCE_LIMIT' })
    await expect(provider.submitEndpointMessage1({
      mobile, challengeId: parsePairingChallengeId('challenge-publication-capacity-2'),
      completionId: parsePairingCompletionId('publication-capacity-over-mobile'),
      message1: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: 'PAIRING_RESOURCE_LIMIT' })
    await authority.runPairingTransaction((state) => {
      for (const id of [...state.endpointPublications.keys()]) {
        if (id !== pending.pendingPairingId) state.endpointPublications.delete(id)
      }
      return Promise.resolve()
    })
    registration.resolve(1)
    await expect(confirming).resolves.toBeDefined()
  })

  it('counts durable compensation records and stages duplicate compensation idempotently', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ authority })
    const pendingPairingId = parsePendingPairingId('capacity-compensation')
    const publication = {
      accountId: 'account-one', desktopInstallationId: parseInstallationId('desktop-installation'),
      mobileInstallationId: parseInstallationId('mobile-installation'), pendingPairingId,
      routeId: parseRelayRouteId('route-capacity-compensation'),
      desktopCredentialDigest: new Uint8Array(32).fill(1), credentialDigest: new Uint8Array(32).fill(2),
      pairing: { id: parsePersonalPairingId('pairing-capacity-compensation') }, accessGeneration: 1,
    }
    await authority.runPairingTransaction((state) => {
      Reflect.set(provider, 'transactionState', state)
      try {
        state.endpointPublications.set(pendingPairingId, publication as never)
        const assertCapacity = Reflect.get(provider, 'assertEndpointRetainedCapacity') as (
          mailbox: { pending: readonly never[]; challenges: readonly never[] },
          accountId: string,
          installationId: ReturnType<typeof parseInstallationId>,
          kind: 'desktop' | 'mobile',
          additional: number,
        ) => void
        expect(() => { assertCapacity.call(
          provider, { pending: [], challenges: [] }, 'account-one',
          parseInstallationId('desktop-installation'), 'desktop', MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION,
        ) }).toThrow('retained endpoint pairing record limit')
        expect(() => { assertCapacity.call(
          provider, { pending: [], challenges: [] }, 'account-one',
          parseInstallationId('mobile-installation'), 'mobile', MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION,
        ) }).toThrow('retained endpoint pairing record limit')

        state.endpointPublications.clear()
        state.endpointPublicationRevocations.set(pendingPairingId, {
          ...publication, pairingId: publication.pairing.id,
          desktopRevoked: false, mobileRevoked: false, authorityRevoked: false,
        } as never)
        expect(() => { assertCapacity.call(
          provider, { pending: [], challenges: [] }, 'account-one',
          parseInstallationId('desktop-installation'), 'desktop', MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION,
        ) }).toThrow('retained endpoint pairing record limit')
        expect(() => { assertCapacity.call(
          provider, { pending: [], challenges: [] }, 'account-one',
          parseInstallationId('mobile-installation'), 'mobile', MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION,
        ) }).toThrow('retained endpoint pairing record limit')

        const stage = Reflect.get(provider, 'stageEndpointPublicationRevocation') as (
          value: typeof state,
          prepared: typeof publication,
        ) => void
        stage.call(provider, state, publication)
        expect(state.endpointPublicationRevocations.size).toBe(1)
      } finally {
        Reflect.set(provider, 'transactionState', undefined)
      }
      return Promise.resolve()
    })
  })

  it('round-trips and validates the optional Desktop static invitation key', async () => {
    const handshake = handshakeProvider()
    handshake.createChallenge.mockResolvedValueOnce({
      desktopFingerprint: 'desktop-static', state: Uint8Array.of(1),
      desktopStaticPublicKey: new Uint8Array(32).fill(7),
    })
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await createChallengeFor(provider, desktop, 'static-key')
    expect(parsePairingInvitationLink(challenge.oneTimeLink).desktopStaticPublicKey)
      .toEqual(new Uint8Array(32).fill(7))
    const invalid = new URL(challenge.oneTimeLink)
    invalid.searchParams.set('spk', 'AQ')
    expect(() => parsePairingInvitationLink(invalid.toString())).toThrow('exactly 256 bits')
    const mobile = authentication('mobile-installation')
    const input = {
      mobile, completionId: parsePairingCompletionId('static-key-completion'),
      oneTimeLink: challenge.oneTimeLink, device: { name: 'Phone', platform: 'ios' as const },
      mobileHandshake: Uint8Array.of(1),
    }
    const changed = new URL(challenge.oneTimeLink)
    changed.searchParams.set('spk', Buffer.alloc(32, 8).toString('base64url'))
    await expect(provider.completeChallenge({
      ...input, completionId: parsePairingCompletionId('changed-static-key'), oneTimeLink: changed.toString(),
    }))
      .rejects.toMatchObject({ code: 'PAIRING_CHALLENGE_INVALID' })
    await provider.completeChallenge(input)
    await expect(provider.completeChallenge(input)).resolves.toBeDefined()
  })

  it('rejects endpoint publication after route loss, random-id collision, or Account quota', async () => {
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    const create = async (suffix: string) => {
      const authority = new MemoryPersonalPairingAuthorityStore()
      const relay = relayStub(parseRelayRouteId(`route-${suffix}`), 1)
      let sequence = 0
      const provider = configuredProvider({
        authority, relay, clock: { now: () => NOW },
        randomId: kind => kind === 'pairing' ? `pairing-${suffix}`
          : kind === 'principal' ? `principal-${suffix}` : `${kind}-${suffix}-${String(sequence += 1)}`,
      })
      await provider.setMobileAccess({ desktop, enabled: true })
      const pending = await prepareEndpointPairing(provider, desktop, mobile, suffix, 'message3')
      return { authority, provider, pending }
    }
    const lost = await create('route-lost')
    vi.spyOn(lost.authority, 'getDesktop').mockResolvedValueOnce({ enabled: false })
    await expect(lost.provider.confirmEndpointPairing({
      desktop, pendingPairingId: lost.pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'MOBILE_ACCESS_DISABLED' })

    const collision = await create('collision')
    await collision.authority.runPairingTransaction((state) => {
      state.pairings.set(parsePersonalPairingId('pairing-collision'), {} as never)
      return Promise.resolve()
    })
    await expect(collision.provider.confirmEndpointPairing({
      desktop, pendingPairingId: collision.pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })

    const quota = await create('quota')
    await quota.authority.runPairingTransaction((state) => {
      for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.personalPairings; index += 1) {
        state.pairings.set(parsePersonalPairingId(`quota-${String(index)}`), {
          devicePrincipal: { accountId: 'account-one' },
        } as never)
      }
      return Promise.resolve()
    })
    await expect(quota.provider.confirmEndpointPairing({
      desktop, pendingPairingId: quota.pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'QUOTA' })

    const missingGenerationAuthority = new MemoryPersonalPairingAuthorityStore()
    const missingRoute = parseRelayRouteId('route-missing-generation')
    await missingGenerationAuthority.enableDesktop(
      'account-one' as never, parseInstallationId('desktop-installation'), missingRoute,
    )
    const missingGeneration = configuredProvider({
      authority: missingGenerationAuthority, relay: relayStub(missingRoute, 1),
      clock: { now: () => NOW }, randomId: kind => `${kind}-missing-generation`,
    })
    const missingPending = await prepareEndpointPairing(
      missingGeneration, desktop, mobile, 'missing-generation', 'message3',
    )
    await expect(missingGeneration.confirmEndpointPairing({
      desktop, pendingPairingId: missingPending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })).rejects.toMatchObject({ code: 'MOBILE_ACCESS_DISABLED' })
  })

  it('durably compensates a rejected or locally invalidated in-flight endpoint publication', async () => {
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    const rejectedAuthority = new MemoryPersonalPairingAuthorityStore()
    const rejectedRelay = relayStub(parseRelayRouteId('route-rejected-publication'), 1)
    const registration = deferred<number>()
    rejectedRelay.registerPairingCredentialDigests.mockImplementationOnce(async () => await registration.promise)
    let rejectedSequence = 0
    const rejected = configuredProvider({
      authority: rejectedAuthority, relay: rejectedRelay, clock: { now: () => NOW },
      randomId: kind => `${kind}-rejected-publication-${String(rejectedSequence += 1)}`,
    })
    await rejected.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(rejected, desktop, mobile, 'rejected-publication', 'message3')
    const confirming = rejected.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })
    await vi.waitFor(() => { expect(rejectedRelay.registerPairingCredentialDigests).toHaveBeenCalledOnce() })
    await rejected.rejectEndpointPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    registration.resolve(1)
    await expect(confirming).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    expect(rejectedRelay.revokeCredentialDigest).toHaveBeenCalledTimes(4)

    const invalidAuthority = new MemoryPersonalPairingAuthorityStore()
    const invalidRelay = relayStub(parseRelayRouteId('route-invalid-publication'), 1)
    let invalidSequence = 0
    const invalid = configuredProvider({
      authority: invalidAuthority, relay: invalidRelay, clock: { now: () => NOW },
      randomId: kind => `${kind}-invalid-publication-${String(invalidSequence += 1)}`,
    })
    await invalid.setMobileAccess({ desktop, enabled: true })
    const invalidPending = await prepareEndpointPairing(invalid, desktop, mobile, 'invalid-publication', 'message3')
    invalidRelay.registerPairingCredentialDigests.mockImplementationOnce(async () => {
      await invalidAuthority.runPairingTransaction((state) => {
        const record = state.endpointMailbox.pending.find(
          item => item.pendingPairingId === invalidPending.pendingPairingId,
        )
        if (record !== undefined) Reflect.deleteProperty(record, 'message3')
        return Promise.resolve()
      })
      return 1
    })
    await expect(invalid.confirmEndpointPairing({
      desktop, pendingPairingId: invalidPending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(3),
      mobileCredentialDigest: new Uint8Array(32).fill(4),
    })).rejects.toThrow('message 3 is not available')
    expect(await invalid.listPersonalPairings(desktop)).toEqual([])
    expect(invalidRelay.revokeCredentialDigest).toHaveBeenCalledTimes(2)

    const failedCleanupAuthority = new MemoryPersonalPairingAuthorityStore()
    const failedCleanupRelay = relayStub(parseRelayRouteId('route-failed-compensation'), 1)
    failedCleanupRelay.revokeCredentialDigest.mockRejectedValueOnce(new Error('revocation unavailable'))
    let failedSequence = 0
    const failedCleanup = configuredProvider({
      authority: failedCleanupAuthority, relay: failedCleanupRelay, clock: { now: () => NOW },
      randomId: kind => `${kind}-failed-compensation-${String(failedSequence += 1)}`,
    })
    await failedCleanup.setMobileAccess({ desktop, enabled: true })
    const failedPending = await prepareEndpointPairing(
      failedCleanup, desktop, mobile, 'failed-compensation', 'message3',
    )
    vi.spyOn(failedCleanupAuthority, 'confirmMobilePairing').mockRejectedValueOnce(new Error('publication failed'))
    await expect(failedCleanup.confirmEndpointPairing({
      desktop, pendingPairingId: failedPending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(5),
      mobileCredentialDigest: new Uint8Array(32).fill(6),
    })).rejects.toThrow('Endpoint Pairing publication rollback failed')

    const registrationAuthority = new MemoryPersonalPairingAuthorityStore()
    const registrationRelay = relayStub(parseRelayRouteId('route-registration-failure'), 1)
    registrationRelay.registerPairingCredentialDigests.mockRejectedValueOnce(new Error('registration unavailable'))
    let registrationSequence = 0
    const registrationFailed = configuredProvider({
      authority: registrationAuthority, relay: registrationRelay, clock: { now: () => NOW },
      randomId: kind => `${kind}-registration-failure-${String(registrationSequence += 1)}`,
    })
    await registrationFailed.setMobileAccess({ desktop, enabled: true })
    const registrationPending = await prepareEndpointPairing(
      registrationFailed, desktop, mobile, 'registration-failure', 'message3',
    )
    await expect(registrationFailed.confirmEndpointPairing({
      desktop, pendingPairingId: registrationPending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(7),
      mobileCredentialDigest: new Uint8Array(32).fill(8),
    })).rejects.toThrow('registration unavailable')
    expect(registrationRelay.revokeCredentialDigest).not.toHaveBeenCalled()
  })

  it('turns a publication whose mailbox work expired into durable compensating revocation', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const relay = relayStub(parseRelayRouteId('route-orphan-publication'), 1)
    const registration = deferred<number>()
    relay.registerPairingCredentialDigests.mockImplementationOnce(async () => await registration.promise)
    let sequence = 0
    const provider = configuredProvider({
      authority, relay, clock: { now: () => NOW },
      randomId: kind => `${kind}-orphan-publication-${String(sequence += 1)}`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, 'orphan-publication', 'message3')
    const confirming = provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(1),
      mobileCredentialDigest: new Uint8Array(32).fill(2),
    })
    await vi.waitFor(() => { expect(relay.registerPairingCredentialDigests).toHaveBeenCalledOnce() })
    await authority.runPairingTransaction((state) => {
      state.endpointMailbox = { challenges: [], pending: [] }
      return Promise.resolve()
    })
    await expect(provider.listPersonalPairings(desktop)).resolves.toEqual([])
    expect(relay.revokeCredentialDigest).toHaveBeenCalledTimes(2)
    registration.resolve(1)
    await expect(confirming).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
  })

  it('tolerates another instance settling or replacing durable compensation work', async () => {
    const settledAuthority = new MemoryPersonalPairingAuthorityStore()
    const pendingPairingId = parsePendingPairingId('settled-compensation-race')
    const revocation = {
      accountId: 'account-one' as never,
      desktopInstallationId: parseInstallationId('desktop-installation'),
      mobileInstallationId: parseInstallationId('mobile-installation'),
      pendingPairingId, pairingId: parsePersonalPairingId('pairing-settled-compensation-race'),
      routeId: parseRelayRouteId('route-settled-compensation-race'),
      desktopCredentialDigest: new Uint8Array(32).fill(1), credentialDigest: new Uint8Array(32).fill(2),
      desktopRevoked: true, mobileRevoked: true, authorityRevoked: true,
      removeStoredPairing: false, pairingRemoved: true,
    }
    await settledAuthority.runPairingTransaction((state) => {
      state.endpointPublicationRevocations.set(pendingPairingId, revocation)
      return Promise.resolve()
    })
    const originalTransaction = settledAuthority.runPairingTransaction.bind(settledAuthority)
    let removeBeforeNextTransaction = false
    vi.spyOn(settledAuthority, 'runPairingTransaction').mockImplementation(async (operation) => {
      return await originalTransaction(async (state) => {
        if (removeBeforeNextTransaction) {
          state.endpointPublicationRevocations.delete(pendingPairingId)
          removeBeforeNextTransaction = false
        }
        const result = await operation(state)
        if (typeof result === 'object' && result !== null
          && 'pendingPairingId' in result && result.pendingPairingId === pendingPairingId) {
          removeBeforeNextTransaction = true
        }
        return result
      })
    })
    const settled = configuredProvider({
      authority: settledAuthority,
      relay: relayStub(parseRelayRouteId('route-settled-compensation-race'), 1),
    })
    await expect(settled.listPersonalPairings(authentication('desktop-installation'))).resolves.toEqual([])

    const stepAuthority = new MemoryPersonalPairingAuthorityStore()
    const stepPending = parsePendingPairingId('step-compensation-race')
    await stepAuthority.runPairingTransaction((state) => {
      state.endpointPublicationRevocations.set(stepPending, {
        ...revocation, pendingPairingId: stepPending,
        pairingId: parsePersonalPairingId('pairing-step-compensation-race'),
        desktopRevoked: false, mobileRevoked: false, authorityRevoked: false,
        removeStoredPairing: false, pairingRemoved: true,
      })
      return Promise.resolve()
    })
    const stepRelay = relayStub(parseRelayRouteId('route-step-compensation-race'), 1)
    stepRelay.revokeCredentialDigest.mockImplementationOnce(async () => {
      await stepAuthority.runPairingTransaction((state) => {
        state.endpointPublicationRevocations.delete(stepPending)
        return Promise.resolve()
      })
    })
    const stepped = configuredProvider({ authority: stepAuthority, relay: stepRelay })
    await expect(stepped.listPersonalPairings(authentication('desktop-installation'))).resolves.toEqual([])
  })

  it('retains durable compensation when Relay revocation is unavailable', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const pendingPairingId = parsePendingPairingId('pending-missing-revocation')
    await authority.runPairingTransaction((state) => {
      state.endpointPublicationRevocations.set(pendingPairingId, {
        accountId: 'account-one' as never,
        desktopInstallationId: parseInstallationId('desktop-installation'),
        mobileInstallationId: parseInstallationId('mobile-installation'),
        pendingPairingId,
        pairingId: parsePersonalPairingId('pairing-missing-revocation'),
        routeId: parseRelayRouteId('route-missing-revocation'),
        desktopCredentialDigest: new Uint8Array(32).fill(1),
        credentialDigest: new Uint8Array(32).fill(2),
        desktopRevoked: false,
        mobileRevoked: false,
        authorityRevoked: false,
        removeStoredPairing: false,
        pairingRemoved: true,
      })
      return Promise.resolve()
    })
    const provider = configuredProvider({ authority })

    await expect(provider.listPersonalPairings(authentication('desktop-installation')))
      .rejects.toThrow('registration and revocation are unavailable')
    await authority.runPairingTransaction((state) => {
      expect(state.endpointPublicationRevocations.get(pendingPairingId))
        .toMatchObject({ desktopRevoked: false, mobileRevoked: false, authorityRevoked: false })
      return Promise.resolve()
    })
  })

  it('cancels an in-flight endpoint publication when its route generation is disabled', async () => {
    const routeId = parseRelayRouteId('relay-route-generation')
    const relay = relayStub(routeId, 1)
    relay.revokeCredentialDigest.mockRejectedValueOnce(new Error('compensating revoke interrupted'))
    const registration = deferred<number>()
    relay.registerPairingCredentialDigests.mockImplementationOnce(async () => await registration.promise)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({
      handshake: handshakeProvider(), relay, authority,
      clock: { now: () => NOW }, randomId: kind => kind === 'relay-route' ? routeId : `${kind}-generation`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createEndpointChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('rendezvous-generation'), expiresAt: NOW + 60_000,
      clientIp: '192.0.2.1',
    })
    const completionId = parsePairingCompletionId('completion-generation')
    const pending = await provider.submitEndpointMessage1({
      mobile, challengeId: challenge.challengeId, completionId,
      message1: Uint8Array.of(1),
    })
    await provider.submitEndpointMessage2({
      desktop, pendingPairingId: pending.pendingPairingId, message2: Uint8Array.of(2),
    })
    await provider.submitEndpointMessage3({ mobile, completionId, message3: Uint8Array.of(3) })
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(4),
      mobileCredentialDigest: new Uint8Array(32).fill(4),
    })).rejects.toThrow('must be distinct')
    expect(relay.registerPairingCredentialDigests).not.toHaveBeenCalled()
    const confirming = provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(4),
      mobileCredentialDigest: new Uint8Array(32).fill(5),
    })
    await vi.waitFor(() => { expect(relay.registerPairingCredentialDigests).toHaveBeenCalledOnce() })
    await expect(provider.setMobileAccess({ desktop, enabled: false }))
      .rejects.toThrow('compensating revoke interrupted')
    await authority.runPairingTransaction((state) => {
      expect(state.endpointPublicationRevocations.size).toBe(1)
      return Promise.resolve()
    })
    const recovered = configuredProvider({
      handshake: handshakeProvider(), relay, authority,
      clock: { now: () => NOW }, randomId: kind => `${kind}-recovered-generation`,
    })
    expect(await recovered.listPersonalPairings(desktop)).toEqual([])
    await authority.runPairingTransaction((state) => {
      expect(state.endpointPublicationRevocations.size).toBe(0)
      return Promise.resolve()
    })
    registration.resolve(1)
    await expect(confirming).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    expect(relay.revokeCredentialDigest).toHaveBeenCalledTimes(5)
    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    await provider.setMobileAccess({ desktop, enabled: true })
    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    await provider.dispose()
  })

  it('mediates the endpoint-owned XKpsk3 mailbox without calling the Platform crypto adapter', async () => {
    const handshake = handshakeProvider()
    const relay = relayStub(parseRelayRouteId('route-endpoint'), 1)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({
      handshake, relay, authority,
      clock: { now: () => NOW }, randomId: kind => `${kind}-endpoint`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createEndpointChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('endpoint-mailbox'),
      clientIp: '192.0.2.1',
      expiresAt: NOW + PAIRING_CHALLENGE_TTL_MS,
    })
    expect(new URL(challenge.routingLink).searchParams.has('payload')).toBe(false)
    const completionId = parsePairingCompletionId('completion-endpoint')
    const completion = await provider.submitEndpointMessage1({
      mobile,
      challengeId: challenge.challengeId,
      completionId,
      message1: Uint8Array.of(11),
    })
    await authority.runPairingTransaction((state) => {
      state.endpointMailbox = { ...state.endpointMailbox, challenges: [] }
      return Promise.resolve()
    })
    await expect(provider.submitEndpointMessage1({
      mobile, challengeId: challenge.challengeId, completionId,
      message1: Uint8Array.of(11),
    })).resolves.toEqual(completion)
    expect(await provider.listEndpointPending(desktop)).toEqual([{
      pendingPairingId: completion.pendingPairingId,
      challengeId: challenge.challengeId,
      stage: 'message1',
      message1: Uint8Array.of(11),
      device: { name: 'Work Android installation', platform: 'android' },
    }])
    await provider.submitEndpointMessage2({
      desktop, pendingPairingId: completion.pendingPairingId, message2: Uint8Array.of(22),
    })
    expect(await provider.getEndpointPairingStatus({ mobile, completionId })).toMatchObject({
      stage: 'message2', message2: Uint8Array.of(22),
    })
    await provider.submitEndpointMessage3({ mobile, completionId, message3: Uint8Array.of(33) })
    expect(await provider.listEndpointPending(desktop)).toEqual([{
      pendingPairingId: completion.pendingPairingId,
      challengeId: challenge.challengeId,
      stage: 'message3',
      message1: Uint8Array.of(11),
      message2: Uint8Array.of(22),
      message3: Uint8Array.of(33),
      device: { name: 'Work Android installation', platform: 'android' },
    }])
    const confirmMobilePairing = authority.confirmMobilePairing.bind(authority)
    vi.spyOn(authority, 'confirmMobilePairing').mockImplementationOnce(async (input) => {
      await confirmMobilePairing(input)
      throw new Error('publication response lost after commit')
    })
    await expect(provider.confirmEndpointPairing({
      desktop, pendingPairingId: completion.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(6),
      mobileCredentialDigest: new Uint8Array(32).fill(7),
    })).rejects.toThrow('publication response lost after commit')
    const recovered = configuredProvider({
      handshake, relay, authority,
      clock: { now: () => NOW }, randomId: kind => `${kind}-replacement`,
    })
    await expect(recovered.getEndpointPairingStatus({ mobile, completionId })).resolves.toMatchObject({
      stage: 'message2', pendingPairingId: completion.pendingPairingId,
    })
    const confirmation = await recovered.confirmEndpointPairing({
      desktop, pendingPairingId: completion.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(6),
      mobileCredentialDigest: new Uint8Array(32).fill(7),
    })
    expect(confirmation).toMatchObject({
      routeId: 'relay-route-endpoint', relayRevision: 1,
      pairing: { device: { name: 'Work Android installation', platform: 'android' } },
    })
    await expect(recovered.confirmEndpointPairing({
      desktop, pendingPairingId: completion.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(6),
      mobileCredentialDigest: new Uint8Array(32).fill(7),
    })).resolves.toEqual(confirmation)
    await expect(recovered.confirmEndpointPairing({
      desktop, pendingPairingId: completion.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(6),
      mobileCredentialDigest: new Uint8Array(32).fill(8),
    })).rejects.toThrow('stale')
    expect(relay.registerPairingCredentialDigests).toHaveBeenCalledWith(
      parseRelayRouteId('relay-route-endpoint'), 'pairing-endpoint',
      new Uint8Array(32).fill(6), new Uint8Array(32).fill(7),
    )
    expect(relay.registerPairingCredentialDigests).toHaveBeenCalledTimes(2)
    await recovered.deliverEndpointRelayAuthority({
      desktop,
      pendingPairingId: completion.pendingPairingId,
      sealedRelayAuthority: Uint8Array.of(44),
    })
    expect(await recovered.getEndpointPairingStatus({ mobile, completionId })).toMatchObject({
      stage: 'confirmed', sealedRelayAuthority: Uint8Array.of(44),
    })
    expect(handshake.createChallenge).not.toHaveBeenCalled()
    expect(handshake.completeChallenge).not.toHaveBeenCalled()
    await recovered.setMobileAccess({ desktop, enabled: false })
    expect(relay.revokeCredentialDigest).toHaveBeenCalledWith(
      parseRelayRouteId('relay-route-endpoint'), 'mobile', new Uint8Array(32).fill(7),
    )
    expect(relay.revokeCredentialDigest).toHaveBeenCalledWith(
      parseRelayRouteId('relay-route-endpoint'), 'desktop', new Uint8Array(32).fill(6),
    )
  })

  it.each([
    ['first credential revoke', 'first-credential', 1, false],
    ['second credential revoke', 'second-credential', 2, false],
    ['Mobile authority delete', 'mobile-authority', 0, true],
  ] as const)('retains endpoint revocation authority across restart after %s fails', async (
    label, suffix, failedCredentialCall, failAuthority,
  ) => {
    const routeId = parseRelayRouteId(`route-durable-${suffix.replaceAll(' ', '-')}`)
    const relay = relayStub(routeId, 1)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({
      relay, authority, clock: { now: () => NOW }, randomId: kind => `${kind}-durable-${suffix}`,
    })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, `durable-${suffix}`, 'message3')
    const desktopDigest = new Uint8Array(32).fill(11)
    const mobileDigest = new Uint8Array(32).fill(12)
    const confirmation = await provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: desktopDigest, mobileCredentialDigest: mobileDigest,
    })
    let credentialCalls = 0
    relay.revokeCredentialDigest.mockImplementation(async () => {
      credentialCalls += 1
      if (credentialCalls === failedCredentialCall) throw new Error(`${label} unavailable`)
    })
    const revokeAuthority = authority.revokeMobilePairing.bind(authority)
    const authoritySpy = vi.spyOn(authority, 'revokeMobilePairing')
      .mockImplementation(async (pairingId) => {
        if (failAuthority) {
          failAuthority = false
          throw new Error(`${label} unavailable`)
        }
        await revokeAuthority(pairingId)
      })

    await expect(provider.revokePersonalPairing({ desktop, pairingId: confirmation.pairing.id }))
      .rejects.toThrow(`${label} unavailable`)
    await authority.runPairingTransaction((state) => {
      const retained = state.endpointPublicationRevocations.get(pending.pendingPairingId)
      expect(retained).toMatchObject({
        pairingId: confirmation.pairing.id,
        desktopRevoked: failedCredentialCall !== 1,
        mobileRevoked: failedCredentialCall === 0,
        authorityRevoked: false,
        removeStoredPairing: true,
        pairingRemoved: false,
      })
      expect(retained?.desktopCredentialDigest).toEqual(desktopDigest)
      expect(retained?.credentialDigest).toEqual(mobileDigest)
      expect(state.pairings.has(confirmation.pairing.id)).toBe(true)
      return Promise.resolve()
    })

    relay.revokeCredentialDigest.mockResolvedValue(undefined)
    authoritySpy.mockImplementation(async (pairingId) => { await revokeAuthority(pairingId) })
    const recovered = configuredProvider({ relay, authority, clock: { now: () => NOW } })
    await expect(recovered.revokePersonalPairing({ desktop, pairingId: confirmation.pairing.id })).resolves.toBeUndefined()
    await authority.runPairingTransaction((state) => {
      expect(state.endpointPublicationRevocations.size).toBe(0)
      expect(state.pairings.has(confirmation.pairing.id)).toBe(false)
      return Promise.resolve()
    })
    expect(await authority.getMobilePairing(pending.pendingPairingId)).toBeUndefined()
  })

  it('fails loud before endpoint pairing revocation when the complete Relay capability is absent', async () => {
    const relay = relayStub(parseRelayRouteId('route-missing-active-revoke'), 1)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ relay, authority, clock: { now: () => NOW } })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, 'missing-active-revoke', 'message3')
    const confirmation = await provider.confirmEndpointPairing({
      desktop, pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(13),
      mobileCredentialDigest: new Uint8Array(32).fill(14),
    })
    const degraded = configuredProvider({ authority, clock: { now: () => NOW } })

    await expect(degraded.setMobileAccess({ desktop, enabled: false }))
      .rejects.toThrow('registration and revocation are unavailable')
    await expect(degraded.revokePersonalPairing({ desktop, pairingId: confirmation.pairing.id }))
      .rejects.toThrow('registration and revocation are unavailable')
    expect(await authority.getDesktop('account-one' as never, parseInstallationId('desktop-installation')))
      .toMatchObject({ enabled: true })
    await authority.runPairingTransaction((state) => {
      expect(state.pairings.has(confirmation.pairing.id)).toBe(true)
      expect(state.endpointPublicationRevocations.size).toBe(0)
      return Promise.resolve()
    })
  })

  it('lets the confirmed Mobile revoke endpoint authority and retry after removal', async () => {
    const routeId = parseRelayRouteId('route-mobile-revoke')
    const relay = relayStub(routeId, 1)
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ relay, authority, clock: { now: () => NOW } })
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const pending = await prepareEndpointPairing(provider, desktop, mobile, 'mobile-revoke', 'message3')
    const confirmation = await provider.confirmEndpointPairing({
      desktop,
      pendingPairingId: pending.pendingPairingId,
      desktopCredentialDigest: new Uint8Array(32).fill(21),
      mobileCredentialDigest: new Uint8Array(32).fill(22),
    })

    await expect(provider.revokeMobilePersonalPairing({
      mobile: authentication('other-mobile-installation'), pairingId: confirmation.pairing.id,
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    await provider.revokeMobilePersonalPairing({ mobile, pairingId: confirmation.pairing.id })
    await expect(provider.revokeMobilePersonalPairing({ mobile, pairingId: confirmation.pairing.id }))
      .resolves.toBeUndefined()
    expect(relay.revokeCredentialDigest).toHaveBeenNthCalledWith(
      1, expect.any(String), 'desktop', new Uint8Array(32).fill(21),
    )
    expect(relay.revokeCredentialDigest).toHaveBeenNthCalledWith(
      2, expect.any(String), 'mobile', new Uint8Array(32).fill(22),
    )
    expect(await authority.getMobilePairing(pending.pendingPairingId)).toBeUndefined()
    await authority.runPairingTransaction((state) => {
      expect(state.pairings.has(confirmation.pairing.id)).toBe(false)
      expect(state.endpointPublicationRevocations.size).toBe(0)
      return Promise.resolve()
    })
  })

  it('revokes legacy stored pairings that own no Platform cleanup resource', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ authority })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const revoked = storedPairing('no-cleanup-revoke')
    const desktopRevoked = storedPairing('no-cleanup-desktop')
    const disabled = storedPairing('no-cleanup-disable')
    await authority.runPairingTransaction(async (state) => {
      state.pairings.set(revoked.id, revoked)
      state.pairings.set(desktopRevoked.id, desktopRevoked)
      state.pairings.set(disabled.id, disabled)
      state.principalIds.add(revoked.devicePrincipal.id)
      state.principalIds.add(desktopRevoked.devicePrincipal.id)
      state.principalIds.add(disabled.devicePrincipal.id)
    })

    await provider.revokeMobilePersonalPairing({
      mobile: authentication('mobile-no-cleanup-revoke'), pairingId: revoked.id,
    })
    await provider.revokePersonalPairing({ desktop, pairingId: desktopRevoked.id })
    await provider.setMobileAccess({ desktop, enabled: false })
    expect(await provider.listPersonalPairings(desktop)).toEqual([])
  })

  it('stages an active endpoint revocation idempotently', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ authority })
    const pairing = endpointStoredPairing('duplicate-stage')
    await authority.runPairingTransaction(async (state) => {
      const stage = Reflect.get(provider, 'stageStoredEndpointRevocation') as (
        retained: typeof state,
        value: ReturnType<typeof endpointStoredPairing>,
      ) => void
      stage.call(provider, state, pairing)
      stage.call(provider, state, pairing)
      expect(state.endpointPublicationRevocations.size).toBe(1)
    })
  })

  it('settles stored-pairing cleanup when the pairing row is already absent', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const relay = relayStub(parseRelayRouteId('route-absent-cleanup'), 1)
    const provider = configuredProvider({ authority, relay })
    const pairing = endpointStoredPairing('absent-cleanup')
    await authority.runPairingTransaction(async (state) => {
      state.endpointPublicationRevocations.set(pairing.endpointPendingPairingId, {
        accountId: pairing.devicePrincipal.accountId,
        desktopInstallationId: pairing.desktopInstallationId,
        mobileInstallationId: pairing.devicePrincipal.installationId,
        pendingPairingId: pairing.endpointPendingPairingId,
        pairingId: pairing.id,
        routeId: pairing.endpointRouteId,
        desktopCredentialDigest: pairing.endpointDesktopCredentialDigest.slice(),
        credentialDigest: pairing.endpointCredentialDigest.slice(),
        desktopRevoked: true, mobileRevoked: true, authorityRevoked: true,
        removeStoredPairing: true, pairingRemoved: false,
      })
    })

    await expect(provider.listPersonalPairings(authentication('desktop-installation'))).resolves.toEqual([])
    await authority.runPairingTransaction(async (state) => {
      expect(state.endpointPublicationRevocations.get(pairing.endpointPendingPairingId))
        .toMatchObject({ pairingRemoved: true })
    })
    await provider.revokeMobilePersonalPairing({
      mobile: authentication('mobile-absent-cleanup'), pairingId: pairing.id,
    })
    await authority.runPairingTransaction(async (state) => {
      expect(state.endpointPublicationRevocations.size).toBe(0)
    })
  })

  it('destroys a retained Platform pairing resource before settling stored cleanup', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const handshake = handshakeProvider()
    const relay = relayStub(parseRelayRouteId('route-resource-cleanup'), 1)
    const provider = configuredProvider({ authority, relay, handshake })
    const pairing = { ...endpointStoredPairing('resource-cleanup'), cleanup: { resource: Uint8Array.of(9) } }
    await authority.runPairingTransaction(async (state) => {
      state.pairings.set(pairing.id, pairing)
      state.principalIds.add(pairing.devicePrincipal.id)
      state.endpointPublicationRevocations.set(pairing.endpointPendingPairingId, {
        accountId: pairing.devicePrincipal.accountId,
        desktopInstallationId: pairing.desktopInstallationId,
        mobileInstallationId: pairing.devicePrincipal.installationId,
        pendingPairingId: pairing.endpointPendingPairingId,
        pairingId: pairing.id,
        routeId: pairing.endpointRouteId,
        desktopCredentialDigest: pairing.endpointDesktopCredentialDigest.slice(),
        credentialDigest: pairing.endpointCredentialDigest.slice(),
        desktopRevoked: true, mobileRevoked: true, authorityRevoked: true,
        removeStoredPairing: true, pairingRemoved: false,
      })
    })

    await expect(provider.listPersonalPairings(authentication('desktop-installation'))).resolves.toEqual([])
    expect(handshake.destroyPairing).toHaveBeenCalledWith(Uint8Array.of(9))
  })

  it.each(['deleted', 'replaced'] as const)(
    'contains a concurrently %s stored-pairing cleanup tombstone',
    async (race) => {
      const authority = new MemoryPersonalPairingAuthorityStore()
      const relay = relayStub(parseRelayRouteId(`route-cleanup-${race}`), 1)
      const pairing = endpointStoredPairing(`cleanup-${race}`)
      await authority.runPairingTransaction(async (state) => {
        state.endpointPublicationRevocations.set(pairing.endpointPendingPairingId, {
          accountId: pairing.devicePrincipal.accountId,
          desktopInstallationId: pairing.desktopInstallationId,
          mobileInstallationId: pairing.devicePrincipal.installationId,
          pendingPairingId: pairing.endpointPendingPairingId,
          pairingId: pairing.id,
          routeId: pairing.endpointRouteId,
          desktopCredentialDigest: pairing.endpointDesktopCredentialDigest.slice(),
          credentialDigest: pairing.endpointCredentialDigest.slice(),
          desktopRevoked: true, mobileRevoked: true, authorityRevoked: true,
          removeStoredPairing: true, pairingRemoved: false,
        })
      })
      const transaction = authority.runPairingTransaction.bind(authority)
      let interfere = false
      vi.spyOn(authority, 'runPairingTransaction').mockImplementation(async operation => await transaction(async (state) => {
        if (interfere) {
          const retained = state.endpointPublicationRevocations.get(pairing.endpointPendingPairingId)
          if (race === 'deleted') state.endpointPublicationRevocations.delete(pairing.endpointPendingPairingId)
          else if (retained !== undefined) retained.pairingRemoved = true
          interfere = false
        }
        const result = await operation(state)
        if (typeof result === 'object' && result !== null && 'pendingPairingId' in result) interfere = true
        return result
      }))
      const provider = configuredProvider({ authority, relay })

      await expect(provider.listPersonalPairings(authentication('desktop-installation'))).resolves.toEqual([])
    },
  )

  it('skips settled tombstones owned by another Desktop while acknowledging disable cleanup', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = configuredProvider({ authority })
    const other = endpointStoredPairing('other-desktop-settled')
    await authority.runPairingTransaction(async (state) => {
      state.endpointPublicationRevocations.set(other.endpointPendingPairingId, {
        accountId: 'account-other' as never,
        desktopInstallationId: parseInstallationId('desktop-other'),
        mobileInstallationId: other.devicePrincipal.installationId,
        pendingPairingId: other.endpointPendingPairingId,
        pairingId: other.id,
        routeId: other.endpointRouteId,
        desktopCredentialDigest: other.endpointDesktopCredentialDigest.slice(),
        credentialDigest: other.endpointCredentialDigest.slice(),
        desktopRevoked: true, mobileRevoked: true, authorityRevoked: true,
        removeStoredPairing: true, pairingRemoved: true,
      })
    })

    await expect(provider.setMobileAccess({
      desktop: authentication('desktop-installation'), enabled: false,
    })).resolves.toEqual({ enabled: false })
    await authority.runPairingTransaction(async (state) => {
      expect(state.endpointPublicationRevocations.has(other.endpointPendingPairingId)).toBe(true)
    })
  })

  it('admits Desktop confirmation only after an idempotent Mobile handshake finish', async () => {
    const handshake = {
      ...handshakeProvider(),
      finishChallenge: vi.fn(async () => ({
        handshakeHash: new Uint8Array(32).fill(4),
        pendingPairingKey: Uint8Array.of(5),
      })),
    }
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await createChallengeFor(provider, desktop, 'three-message')
    const pending = await provider.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('three-message'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(1),
    })

    expect(await provider.listPendingPairings(desktop)).toEqual([])
    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId }))
      .rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })

    const finished = await provider.finishChallenge({
      mobile,
      pendingPairingId: pending.pendingPairingId,
      mobileFinish: Uint8Array.of(3),
    })
    await expect(provider.finishChallenge({
      mobile,
      pendingPairingId: pending.pendingPairingId,
      mobileFinish: Uint8Array.of(3),
    })).resolves.toEqual(finished)
    await expect(provider.finishChallenge({
      mobile,
      pendingPairingId: pending.pendingPairingId,
      mobileFinish: Uint8Array.of(9),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    expect(await provider.listPendingPairings(desktop)).toEqual([finished])
    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId }))
      .resolves.toMatchObject({ device: { name: 'Work Android installation' } })
    expect(handshake.finishChallenge).toHaveBeenCalledOnce()
  })

  it('fails closed across invalid or doubly-failed legacy finish cleanup', async () => {
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    const handshake = {
      ...handshakeProvider(),
      finishChallenge: vi.fn(async () => ({
        handshakeHash: new Uint8Array(32), pendingPairingKey: Uint8Array.of(8),
      })),
    }
    const provider = uniquePairingProvider(handshake)
    await provider.setMobileAccess({ desktop, enabled: true })
    await expect(provider.finishChallenge({
      mobile, pendingPairingId: parsePendingPairingId('missing-finish'), mobileFinish: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    const firstChallenge = await createChallengeFor(provider, desktop, 'finish-fault-one')
    const first = await provider.completeChallenge({
      mobile, completionId: parsePairingCompletionId('finish-fault-one'), oneTimeLink: firstChallenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(1),
    })
    Reflect.deleteProperty(handshake, 'finishChallenge')
    await expect(provider.finishChallenge({
      mobile, pendingPairingId: first.pendingPairingId, mobileFinish: Uint8Array.of(2),
    })).rejects.toThrow('does not require a finish message')

    handshake.finishChallenge = vi.fn(async () => ({
      handshakeHash: new Uint8Array(32), pendingPairingKey: Uint8Array.of(9),
    }))
    const secondChallenge = await createChallengeFor(provider, desktop, 'finish-fault-two')
    const second = await provider.completeChallenge({
      mobile, completionId: parsePairingCompletionId('finish-fault-two'), oneTimeLink: secondChallenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(1),
    })
    handshake.destroyPendingPairing.mockRejectedValueOnce(new Error('old cleanup failed'))
      .mockRejectedValueOnce(new Error('replacement cleanup failed'))
    await expect(provider.finishChallenge({
      mobile, pendingPairingId: second.pendingPairingId, mobileFinish: Uint8Array.of(2),
    })).rejects.toThrow('Pairing finish cleanup failed')
    handshake.destroyPendingPairing.mockReset()
      .mockRejectedValueOnce(new Error('old cleanup only failed'))
      .mockResolvedValue(undefined)
    await expect(provider.finishChallenge({
      mobile, pendingPairingId: second.pendingPairingId, mobileFinish: Uint8Array.of(2),
    })).rejects.toThrow('old cleanup only failed')
    handshake.destroyPendingPairing.mockReset().mockResolvedValue(undefined)
    await expect(provider.finishChallenge({
      mobile, pendingPairingId: second.pendingPairingId, mobileFinish: Uint8Array.of(2),
    })).resolves.toMatchObject({ pendingPairingId: second.pendingPairingId })
  })

  it('keeps a replacement route when stale disable cleanup completes', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const untouched = new MemoryPersonalPairingAuthorityStore()
    const accountId = 'account-one' as never
    const desktopId = parseInstallationId('desktop-one')
    const first = parseRelayRouteId('route-first')
    const second = parseRelayRouteId('route-second')
    expect(await authority.enableDesktop(accountId, desktopId, first)).toBe(first)
    expect(await authority.disableDesktop(accountId, desktopId)).toEqual([first])
    expect(await authority.enableDesktop(accountId, desktopId, second)).toBe(second)
    await authority.completeRouteRevocation(accountId, desktopId, first)
    expect(await authority.getDesktop(accountId, desktopId)).toEqual({ enabled: true, routeId: second })
    await untouched.completeRouteRevocation(accountId, desktopId, first)
    expect(await authority.disableDesktop(accountId, parseInstallationId('desktop-missing'))).toEqual([])
    await authority.completeRouteRevocation(accountId, parseInstallationId('desktop-missing'), first)
  })

  it('rejects a conflicting shared Mobile pairing result without replacing the first authority', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const pendingPairingId = parsePendingPairingId('pending-shared')
    const first = {
      accountId: 'account-one' as never,
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-one'),
      pendingPairingId,
      pairingId: parsePersonalPairingId('pairing-one'),
    }
    await authority.confirmMobilePairing(first)
    await authority.confirmMobilePairing(first)
    await expect(authority.getPersonalPairingActivity(first.pairingId, NOW)).resolves.toBeUndefined()
    await authority.recordRelayLease({
      credentialFingerprint: parseRelayCredentialFingerprint('unknown-fingerprint'),
      connectionToken: parseRelayConnectionToken('unknown-connection'),
      expiresAt: NOW + 1_000,
      accessedAt: NOW,
    })
    const sealed = { ...first, pendingPairingId: parsePendingPairingId('pending-sealed'), sealedRelayAuthority: Uint8Array.of(1, 2) }
    await authority.confirmMobilePairing(sealed)
    await authority.confirmMobilePairing({ ...sealed, sealedRelayAuthority: Uint8Array.of(1, 2) })
    await authority.disableDesktop(first.accountId, parseInstallationId('desktop-other'))

    await expect(authority.confirmMobilePairing({
      ...first,
      pairingId: parsePersonalPairingId('pairing-two'),
    })).rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })
    await expect(authority.confirmMobilePairing({
      ...sealed, sealedRelayAuthority: Uint8Array.of(1, 3),
    })).rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })
    expect(await authority.getMobilePairing(pendingPairingId)).toEqual(first)
    await authority.revokeMobilePairing(parsePersonalPairingId('pairing-missing'))
    expect(await authority.getMobilePairing(pendingPairingId)).toEqual(first)
    await expect(authority.runPairingTransaction(async () => {
      throw new Error('transaction rejected')
    })).rejects.toThrow('transaction rejected')
    await expect(authority.runPairingTransaction(async () => 'recovered')).resolves.toBe('recovered')
    expect(await authority.getMobilePairing(sealed.pendingPairingId)).toEqual(sealed)
    await authority.revokeMobilePairing(first.pairingId)
    expect(await authority.getMobilePairing(pendingPairingId)).toBeUndefined()
  })

  it('projects Memory authority presence from independent expiring connection leases', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const fingerprint = parseRelayCredentialFingerprint('memory-presence-fingerprint')
    const pairingId = parsePersonalPairingId('memory-presence-pairing')
    await authority.confirmMobilePairing({
      accountId: 'account-one' as never,
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-one'),
      pendingPairingId: parsePendingPairingId('memory-presence-pending'),
      pairingId,
      credentialFingerprint: fingerprint,
      lastAccessAt: 100,
    })
    const first = parseRelayConnectionToken('memory-presence-first')
    const second = parseRelayConnectionToken('memory-presence-second')
    await authority.releaseRelayLease({
      credentialFingerprint: parseRelayCredentialFingerprint('unknown-presence-fingerprint'),
      connectionToken: first,
      observedAt: 100,
    })
    await authority.recordRelayLease({
      credentialFingerprint: fingerprint, connectionToken: first, expiresAt: 200, accessedAt: 100,
    })
    await authority.recordRelayLease({
      credentialFingerprint: fingerprint, connectionToken: first, expiresAt: 180, accessedAt: 90,
    })
    await expect(authority.getPersonalPairingActivity(pairingId, 190)).resolves.toEqual({
      lastAccessAt: 100,
      online: true,
    })
    await authority.recordRelayLease({
      credentialFingerprint: fingerprint,
      connectionToken: second,
      expiresAt: 300,
      accessedAt: 160,
    })
    await authority.releaseRelayLease({ credentialFingerprint: fingerprint, connectionToken: first, observedAt: 170 })
    await expect(authority.getPersonalPairingActivity(pairingId, 170)).resolves.toEqual({
      lastAccessAt: 160,
      online: true,
    })
    await authority.releaseRelayLease({ credentialFingerprint: fingerprint, connectionToken: second, observedAt: 170 })
    await authority.recordRelayLease({
      credentialFingerprint: fingerprint, connectionToken: first, expiresAt: 400, accessedAt: 200,
    })
    await expect(authority.getPersonalPairingActivity(pairingId, 400)).resolves.toEqual({
      lastAccessAt: 200,
      online: false,
    })
    const firstAccessFingerprint = parseRelayCredentialFingerprint('memory-first-access-fingerprint')
    const firstAccessPairingId = parsePersonalPairingId('memory-first-access-pairing')
    await authority.confirmMobilePairing({
      accountId: 'account-one' as never,
      desktopInstallationId: parseInstallationId('desktop-one'),
      mobileInstallationId: parseInstallationId('mobile-two'),
      pendingPairingId: parsePendingPairingId('memory-first-access-pending'),
      pairingId: firstAccessPairingId,
      credentialFingerprint: firstAccessFingerprint,
    })
    await authority.recordRelayLease({
      credentialFingerprint: firstAccessFingerprint,
      connectionToken: parseRelayConnectionToken('memory-first-access'),
      expiresAt: 500,
      accessedAt: 450,
    })
    await expect(authority.getPersonalPairingActivity(firstAccessPairingId, 450)).resolves.toEqual({
      lastAccessAt: 450,
      online: true,
    })
  })

  it('shares Desktop access and pairing authority across Platform providers', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const routeId = parseRelayRouteId('shared-route')
    const desktopCredential = parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const mobileCredential = parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE')
    const relay = {
      rotateCredential: vi.fn(async () => ({ routeId, endpoint: 'desktop' as const, credential: desktopCredential, revision: 1 })),
      issueCredential: vi.fn(async () => ({ routeId, endpoint: 'mobile' as const, credential: mobileCredential, revision: 1 })),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => {}),
    }
    const sharedHandshake = {
      ...handshakeProvider(),
      sealMobileRelayAuthority: vi.fn(async ({ grant }: { grant: { routeId: string; credential: string; revision: number } }) =>
        new TextEncoder().encode(JSON.stringify(grant))),
    }
    let id = 0
    const create = () => new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake: sharedHandshake,
      relay,
      authority,
      randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
      randomId: kind => kind === 'relay-route' ? routeId : `${kind}-${String(++id)}`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const platformA = create()
    const platformB = create()
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')

    const enabled = await platformA.setMobileAccess({ desktop, enabled: true })
    expect(enabled).toEqual({ enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()
    expect(await platformB.getMobileAccessState(desktop)).toEqual({ enabled: true })
    const challenge = await platformA.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('shared-authority'),
      clientIp: '192.0.2.1',
    })
    const pending = await platformA.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('shared-authority'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const pairing = await platformA.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    const mobileStatus = await platformB.getMobilePairingStatus({ mobile, pendingPairingId: pending.pendingPairingId })
    expect(mobileStatus).toMatchObject({ status: 'paired', pairingId: pairing.id })
    const localStatus = await platformA.getMobilePairingStatus({ mobile, pendingPairingId: pending.pendingPairingId })
    expect(localStatus.status).toBe('paired')
    if (localStatus.status !== 'paired') throw new Error('expected paired local status')
    expect(localStatus.sealedRelayAuthority).toBeUndefined()
    expect(relay.issueCredential).not.toHaveBeenCalled()

    await platformB.setMobileAccess({ desktop, enabled: false })
    expect(await platformA.getMobileAccessState(desktop)).toEqual({ enabled: false })
    expect(relay.revokeRoute).toHaveBeenCalledWith(routeId)
    await expect(platformA.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('disabled-on-other-instance'),
      clientIp: '192.0.2.1',
    })).rejects.toMatchObject({ code: 'MOBILE_ACCESS_DISABLED' })
    await expect(platformB.getMobilePairingStatus({ mobile, pendingPairingId: pending.pendingPairingId }))
      .resolves.toEqual({ status: 'rejected' })
    expect(await platformA.getMobilePairingStatus({ mobile, pendingPairingId: pending.pendingPairingId }))
      .toEqual({ status: 'rejected' })

    await Promise.all([platformA.dispose(), platformB.dispose()])
    expect(relay.revokeRoute).toHaveBeenCalledTimes(1)
  })

  it('revokes one pairing without disabling Desktop Mobile Access', async () => {
    const handshake = {
      ...handshakeProvider(),
      sealMobileRelayAuthority: vi.fn(async () => Uint8Array.of(1)),
    }
    const relay = {
      rotateCredential: vi.fn(async () => ({
        routeId: parseRelayRouteId('route-revoke'),
        endpoint: 'desktop' as const,
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        revision: 1,
      })),
      issueCredential: vi.fn(async () => ({
        routeId: parseRelayRouteId('route-revoke'),
        endpoint: 'mobile' as const,
        credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
        revision: 1,
      })),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => {}),
    }
    const authority = new MemoryPersonalPairingAuthorityStore()
    const provider = new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake,
      relay,
      authority,
      randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
      randomId: kind => `${kind}-revoke`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('revoke-one'),
      clientIp: '192.0.2.1',
    })
    const pending = await provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-one'),
      completionId: parsePairingCompletionId('revoke-one'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const pairing = await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    expect(pairing).toMatchObject({ lastAccessAt: pairing.pairedAt, online: false })
    const authorities = Reflect.get(authority, 'pairings') as Map<unknown, unknown>
    authorities.set(pending.pendingPairingId, {
      accountId: 'account-one', desktopInstallationId: parseInstallationId('desktop-installation'),
      mobileInstallationId: parseInstallationId('mobile-installation'),
      pendingPairingId: pending.pendingPairingId, pairingId: pairing.id,
      sealedRelayAuthority: Uint8Array.of(1),
    })
    await expect(provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation', 'account-one'),
      pendingPairingId: pending.pendingPairingId,
    })).resolves.toEqual({
      status: 'paired', pairingId: pairing.id, sealedRelayAuthority: Uint8Array.of(1),
    })

    await provider.revokeMobilePersonalPairing({
      mobile: authentication('mobile-installation', 'account-one'), pairingId: pairing.id,
    })

    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    expect(handshake.destroyPairing).toHaveBeenCalledOnce()
    expect(relay.revokeCredential).not.toHaveBeenCalled()
    expect(relay.revokeRoute).not.toHaveBeenCalled()
    expect(await provider.getMobileAccessState(desktop)).toEqual({ enabled: true })
    await expect(provider.reissueDesktopRelayAuthority(desktop)).resolves.toMatchObject({
      enabled: true,
    })
    await expect(provider.revokePersonalPairing({
      desktop, pairingId: parsePersonalPairingId('pairing-missing'),
    })).rejects.toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
    await provider.dispose()
  })

  it('projects two paired phones from their authenticated Mobile Installations', async () => {
    const handshake = handshakeProvider()
    let keySequence = 0
    handshake.activatePairing.mockImplementation(async () => ({
      keyReference: `pairing-key-${String(++keySequence)}` as never,
      activePairingKey: Uint8Array.of(keySequence),
    }))
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })

    const firstChallenge = await createChallengeFor(provider, desktop, 'first-phone')
    const firstPending = await provider.completeChallenge({
      mobile: authentication('mobile-ios'),
      completionId: parsePairingCompletionId('first-phone'),
      oneTimeLink: firstChallenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const first = await provider.confirmPairing({
      desktop,
      pendingPairingId: firstPending.pendingPairingId,
    })

    const secondChallenge = await createChallengeFor(provider, desktop, 'second-phone')
    const secondPending = await provider.completeChallenge({
      mobile: authentication('mobile-android'),
      completionId: parsePairingCompletionId('second-phone'),
      oneTimeLink: secondChallenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const second = await provider.confirmPairing({
      desktop,
      pendingPairingId: secondPending.pendingPairingId,
    })

    const authority = Reflect.get(provider, 'authority') as MemoryPersonalPairingAuthorityStore
    vi.spyOn(authority, 'getPersonalPairingActivity').mockResolvedValueOnce({
      lastAccessAt: NOW + 1,
      online: true,
    })
    const pairings = await provider.listPersonalPairings(desktop)
    expect(pairings).toHaveLength(2)
    expect(pairings[0]).toMatchObject({
      id: first.id,
      devicePrincipal: { installationId: parseInstallationId('mobile-ios') },
      device: { name: 'Personal iOS installation', platform: 'ios' },
      pairedAt: NOW,
      lastAccessAt: NOW + 1,
      online: true,
    })
    expect(pairings[1]).toMatchObject({
      id: second.id,
      devicePrincipal: { installationId: parseInstallationId('mobile-android') },
      device: { name: 'Work Android installation', platform: 'android' },
      pairedAt: NOW,
      lastAccessAt: NOW,
      online: false,
    })

    await provider.revokePersonalPairing({ desktop, pairingId: first.id })
    expect(await provider.listPersonalPairings(desktop)).toEqual([
      expect.objectContaining({ id: second.id, device: { name: 'Work Android installation', platform: 'android' } }),
    ])
  })

  it('reissues Desktop Relay authority and keeps pairings on another Installation when disabling', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-one')
    const other = authentication('desktop-two')
    await provider.setMobileAccess({ desktop, enabled: true })
    await provider.setMobileAccess({ desktop: other, enabled: true })
    await expect(provider.reissueDesktopRelayAuthority(desktop)).resolves.toEqual({ enabled: true })
    const challenge = await createChallengeFor(provider, desktop, 'keep-other')
    const pending = await completeAs(provider, challenge.oneTimeLink, 'keep-other', 'mobile-one', 'account-one')
    await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    await provider.setMobileAccess({ desktop: other, enabled: false })
    expect(await provider.listPersonalPairings(desktop)).toHaveLength(1)
    await provider.setMobileAccess({ desktop, enabled: false })
    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    await expect(provider.reissueDesktopRelayAuthority(desktop)).rejects.toMatchObject({
      code: 'MOBILE_ACCESS_DISABLED',
    })
    const owned = configuredProvider({ authority: new MemoryPersonalPairingAuthorityStore() })
    ;(owned as unknown as { localChallengeIds: Set<string> }).localChallengeIds.add('ghost-challenge')
    await owned.dispose()
    const idle = pairingProvider(handshakeProvider())
    expect(() => (idle as unknown as { requireTransactions(): unknown }).requireTransactions())
      .toThrow('transaction state is not owned')
    const revokeOnly = uniquePairingProvider(handshakeProvider())
    const revokeDesktop = authentication('desktop-revoke-only')
    await revokeOnly.setMobileAccess({ desktop: revokeDesktop, enabled: true })
    const revokeChallenge = await createChallengeFor(revokeOnly, revokeDesktop, 'revoke-only')
    const revokePending = await completeAs(
      revokeOnly, revokeChallenge.oneTimeLink, 'revoke-only', 'mobile-revoke-only', 'account-one',
    )
    const revokePairing = await revokeOnly.confirmPairing({
      desktop: revokeDesktop, pendingPairingId: revokePending.pendingPairingId,
    })
    await revokeOnly.revokePersonalPairing({ desktop: revokeDesktop, pairingId: revokePairing.id })
    expect(await revokeOnly.listPersonalPairings(revokeDesktop)).toEqual([])
  })

  it('reads an unsealed shared pairing result on a replacement Platform provider', async () => {
    const { authority, pendingPairingId } = await seedSharedPairing('unsealed-replacement')
    const provider = configuredProvider({ authority })
    expect(await provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation'), pendingPairingId,
    })).toEqual({ status: 'paired', pairingId: 'pairing-unsealed-replacement' })
  })

  it('reads a sealed shared pairing result on a replacement Platform provider', async () => {
    const { authority, pendingPairingId } = await seedSharedPairing(
      'sealed-replacement',
      Uint8Array.of(1, 2),
    )
    const provider = configuredProvider({ authority })
    expect(await provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation'), pendingPairingId,
    })).toEqual({
      status: 'paired', pairingId: 'pairing-sealed-replacement', sealedRelayAuthority: Uint8Array.of(1, 2),
    })
  })

  it('keeps Mobile Access disabled until the Desktop Settings verb enables it', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation', 'account-one')

    expect(await provider.getMobileAccessState(desktop)).toEqual({ enabled: false })
    await expect(provider.createChallenge({ desktop, rendezvousId: 'disabled' as never,
      clientIp: '192.0.2.1',
    })).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'MOBILE_ACCESS_DISABLED' }),
    )
    expect(handshake.createChallenge).not.toHaveBeenCalled()

    expect(await provider.setMobileAccess({ desktop, enabled: true })).toEqual({ enabled: true })
    await expect(provider.createChallenge({ desktop, rendezvousId: 'enabled' as never,
      clientIp: '192.0.2.1',
    })).resolves.toBeDefined()
  })

  it('rejects Relay composition without a deployment-owned shared authority store', () => {
    expect(() => new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })).toThrow('explicitly owned authority store')
    expect(() => new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      relay: {
        revokeRoute: vi.fn(),
        registerPairingCredentialDigests: vi.fn(),
        revokeCredentialDigest: vi.fn(),
      },
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })).toThrow('shared authority store')
  })

  it.each(['registerPairingCredentialDigests', 'revokeCredentialDigest'] as const)(
    'rejects a Relay composition without %s',
    (missing) => {
      const relay = relayStub(parseRelayRouteId('relay-complete-capability'), 1)
      Reflect.deleteProperty(relay, missing)
      expect(() => new PersonalPairingProvider(new Context(), {
        account: accountService(account('account-one')),
        handshake: handshakeProvider(),
        relay,
        authority: new MemoryPersonalPairingAuthorityStore(),
        pairingLinkOrigin: 'https://platform.example.com/pair',
      })).toThrow('requires pairing registration and revocation')
    },
  )

  it('enables routing metadata without letting Platform issue Desktop private authority', async () => {
    const routeId = parseRelayRouteId('relay-route-id')
    const credential = parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const relay = {
      rotateCredential: vi.fn(async () => ({ routeId, endpoint: 'desktop' as const, credential, revision: 1 })),
      issueCredential: vi.fn(async () => ({ routeId, endpoint: 'mobile' as const, credential, revision: 1 })),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => {}),
      registerPairingCredentialDigests: vi.fn(async () => 1),
      revokeCredentialDigest: vi.fn(async () => {}),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      relay,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomId: kind => `${kind}-id`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')

    await expect(provider.setMobileAccess({ desktop, enabled: true })).resolves.toEqual({ enabled: true })
    await provider.setMobileAccess({ desktop, enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()

    await provider.setMobileAccess({ desktop, enabled: false })
    expect(relay.revokeRoute).toHaveBeenCalledOnce()
    expect(await provider.getMobileAccessState(desktop)).toEqual({ enabled: false })
    await provider.dispose()
  })

  it('does not consult Relay credential generation while enabling a new route', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const routeId = parseRelayRouteId('relay-route-failed-enable')
    const relay = {
      rotateCredential: vi.fn(async () => { throw new Error('route store unavailable') }),
      issueCredential: vi.fn(),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => {}),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      relay,
      authority,
      randomId: kind => kind === 'relay-route' ? routeId : `${kind}-id`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')

    await expect(provider.setMobileAccess({ desktop, enabled: true })).resolves.toEqual({ enabled: true })
    expect(await provider.getMobileAccessState(desktop)).toEqual({ enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()
    expect(relay.revokeRoute).not.toHaveBeenCalled()
  })

  it('keeps an existing shared route enabled without rotating endpoint-owned authority', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const routeId = parseRelayRouteId('relay-route-existing')
    const relay = {
      rotateCredential: vi.fn()
        .mockResolvedValueOnce({
          routeId, endpoint: 'desktop' as const, credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), revision: 1,
        })
        .mockRejectedValueOnce(new Error('rotation unavailable')),
      issueCredential: vi.fn(),
      revokeCredential: vi.fn(),
      revokeRoute: vi.fn(),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')), handshake: handshakeProvider(), relay, authority,
      randomId: kind => kind === 'relay-route' ? routeId : `${kind}-id`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    await expect(provider.setMobileAccess({ desktop, enabled: true })).resolves.toEqual({ enabled: true })

    expect(await provider.getMobileAccessState(desktop)).toEqual({ enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()
    expect(relay.revokeRoute).not.toHaveBeenCalled()
  })

  it('does not expose endpoint credential provider failures through route enable', async () => {
    const relay = {
      rotateCredential: vi.fn(async () => { throw new Error('rotation unavailable') }),
      issueCredential: vi.fn(),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => { throw new Error('revocation unavailable') }),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')), handshake: handshakeProvider(), relay,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomId: kind => `${kind}-rollback`, pairingLinkOrigin: 'https://platform.example.com/pair',
    })

    await expect(provider.setMobileAccess({
      desktop: authentication('desktop-installation', 'account-one'), enabled: true,
    })).resolves.toEqual({ enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()
    expect(relay.revokeRoute).not.toHaveBeenCalled()
  })

  it('completes shared authority cleanup when the keyless composition has no Relay provider', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const complete = vi.spyOn(authority, 'completeRouteRevocation')
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      authority,
      randomId: kind => `${kind}-id`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    await provider.setMobileAccess({ desktop, enabled: false })

    expect(complete).toHaveBeenCalledWith(
      'account-one', parseInstallationId('desktop-installation'), parseRelayRouteId('keyless-no-relay'),
    )
  })

  it('preserves durable Relay authority during provider disposal', async () => {
    const routeId = parseRelayRouteId('relay-route-dispose')
    const relay = {
      rotateCredential: vi.fn(async () => ({
        routeId,
        endpoint: 'desktop' as const,
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        revision: 1,
      })),
      issueCredential: vi.fn(async () => ({
        routeId,
        endpoint: 'mobile' as const,
        credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
        revision: 1,
      })),
      revokeCredential: vi.fn(async () => {}),
      revokeRoute: vi.fn(async () => {}),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake: handshakeProvider(),
      relay,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomId: kind => `${kind}-dispose`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    await provider.setMobileAccess({
      desktop: authentication('desktop-installation', 'account-one'), enabled: true,
    })

    await provider.dispose()

    expect(relay.revokeRoute).not.toHaveBeenCalled()
  })

  it('settles this instance live challenges when a shared-authority provider disposes', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const handshake = handshakeProvider()
    let ids = 0
    const options = {
      account: {
        currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
      },
      handshake,
      authority,
      clock: { now: () => NOW },
      randomBytes: (size: number) => Uint8Array.from({ length: size }, (_, index) => index),
      randomId: (kind: string) => `${kind}-${String(++ids)}`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    } as const
    const creator = new PersonalPairingProvider(new Context(), options)
    const desktop = authentication('desktop-installation', 'account-one')
    await creator.setMobileAccess({ desktop, enabled: true })
    await Promise.all(Array.from(
      { length: MAX_ACTIVE_PAIRING_CHALLENGES_PER_INSTALLATION },
      (_, index) => creator.createChallenge({
        desktop,
        rendezvousId: parsePairingRendezvousId(`shared-dispose-${String(index)}`),
        clientIp: '192.0.2.1',
      }),
    ))
    await creator.dispose()

    const successor = new PersonalPairingProvider(new Context(), {
      ...options,
      randomId: (kind: string) => `${kind}-successor-${String(++ids)}`,
    })
    const challenge = await successor.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('after-shared-dispose'),
      clientIp: '192.0.2.1',
    })
    expect(typeof challenge.challengeId).toBe('string')
    expect(challenge.challengeId.length).toBeGreaterThan(0)
    await successor.dispose()
  })

  it('uses authenticated installation identity and role instead of caller claims', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation', 'account-one')
    const mobile = authentication('mobile-installation', 'account-one')

    await expect(provider.setMobileAccess({
      desktop: authentication('mobile-installation', 'account-one'),
      enabled: true,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({
      code: 'PAIRING_INSTALLATION_KIND_INVALID',
    }))

    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('authenticated-installation'),
      clientIp: '192.0.2.1',
    })
    await expect(provider.completeChallenge({
      mobile: authentication('other-desktop', 'account-one'),
      completionId: parsePairingCompletionId('desktop-token-on-mobile-verb'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({
      code: 'PAIRING_INSTALLATION_KIND_INVALID',
    }))

    const pending = await provider.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('authenticated-mobile'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    await expect(provider.confirmPairing({
      desktop: authentication('other-desktop', 'account-one'),
      pendingPairingId: pending.pendingPairingId,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({
      code: 'PAIRING_PENDING_INVALID',
    }))
  })

  it('creates one two-minute high-entropy invitation for the Desktop Settings flow', async () => {
    const handshake = handshakeProvider()
    const provider = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      ownsAuthority: true,
      clock: { now: () => NOW },
      randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
      randomId: kind => `${kind}-id`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })

    const challenge = await provider.createChallenge({
      desktop: authentication('desktop-installation'),
      rendezvousId: 'rendezvous-id' as never,
      clientIp: '192.0.2.1',
    })

    expect(challenge.expiresAt).toBe(NOW + PAIRING_CHALLENGE_TTL_MS)
    expect(challenge.protocolMajor).toBe(PERSONAL_PAIRING_PROTOCOL_MAJOR)
    expect(challenge.desktopFingerprint).toBe('desktop-fingerprint')
    expect(challenge.qrPayload).toBe(challenge.oneTimeLink)
    const invitation = parsePairingInvitationLink(challenge.oneTimeLink)
    expect(invitation.invitationSecret).toHaveLength(32)
    expect(invitation).toMatchObject({
      challengeId: 'challenge-id',
      desktopFingerprint: 'desktop-fingerprint',
      rendezvousId: 'rendezvous-id',
      expiresAt: NOW + PAIRING_CHALLENGE_TTL_MS,
      protocolMajor: PERSONAL_PAIRING_PROTOCOL_MAJOR,
    })
    expect(handshake.createChallenge).toHaveBeenCalledOnce()
  })

  it('completes only for the same Platform Account and keeps authority pending', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    await provider.setMobileAccess({ desktop: authentication('desktop-installation', 'account-one'), enabled: true })
    const challenge = await provider.createChallenge({
      desktop: authentication('desktop-installation', 'account-one'),
      rendezvousId: 'rendezvous-id' as never,
      clientIp: '192.0.2.1',
    })

    const first = await provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-one'),
      completionId: parsePairingCompletionId('completion-one'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    const repeated = await provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-one'),
      completionId: parsePairingCompletionId('completion-one'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })

    expect(repeated).toEqual(first)
    expect(first.authenticationWords).toEqual(['amber', 'binary', 'cedar', 'delta', 'ember', 'frost'])
    expect(first.desktopHandshake).toEqual(Uint8Array.of(8))
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
    expect(await provider.listPersonalPairings(authentication('desktop-installation', 'account-one'))).toEqual([])
  })

  it('destroys a cross-account invitation before granting any Device Principal', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    await provider.setMobileAccess({ desktop: authentication('desktop-installation', 'account-one'), enabled: true })
    const challenge = await provider.createChallenge({
      desktop: authentication('desktop-installation', 'account-one'),
      rendezvousId: 'rendezvous-id' as never,
      clientIp: '192.0.2.1',
    })

    await expect(provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-two'),
      completionId: parsePairingCompletionId('completion-cross-account'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ACCOUNT_MISMATCH' }))
    await expect(provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-two'),
      completionId: parsePairingCompletionId('completion-cross-account-repeat'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ACCOUNT_MISMATCH' }))
    await expect(provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-one'),
      completionId: parsePairingCompletionId('completion-cross-account-retry'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))
    expect(handshake.completeChallenge).not.toHaveBeenCalled()
    expect(handshake.destroyChallenge).toHaveBeenCalledOnce()
    expect(await provider.listPersonalPairings(authentication('desktop-installation', 'account-one'))).toEqual([])
  })

  it('grants only Companion Surface authority after explicit Desktop confirmation', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: 'rendezvous-id' as never,
      clientIp: '192.0.2.1',
    })
    const completion = await provider.completeChallenge({
      mobile: authentication('mobile-installation', 'account-one'),
      completionId: parsePairingCompletionId('completion-confirm'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })

    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    expect(await provider.listPendingPairings(desktop)).toEqual([completion])
    await expect(provider.getMobilePairingStatus({
      mobile: authentication('other-mobile', 'account-one'),
      pendingPairingId: completion.pendingPairingId,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
    expect(await provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation', 'account-one'),
      pendingPairingId: completion.pendingPairingId,
    })).toEqual({ status: 'pending' })
    const first = await provider.confirmPairing({ desktop, pendingPairingId: completion.pendingPairingId })
    const repeated = await provider.confirmPairing({ desktop, pendingPairingId: completion.pendingPairingId })
    await expect(provider.confirmPairing({
      desktop: authentication('other-desktop-installation', 'account-one'),
      pendingPairingId: completion.pendingPairingId,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))

    expect(repeated).toEqual(first)
    expect(first.devicePrincipal.authority).toBe('companion-surface')
    expect(first.devicePrincipal.accountId).toBe('account-one')
    expect(first.device).toEqual({ name: 'Work Android installation', platform: 'android' })
    expect(await provider.listPersonalPairings(desktop)).toEqual([first])
    expect(await provider.listPendingPairings(desktop)).toEqual([])
    expect(await provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation', 'account-one'),
      pendingPairingId: completion.pendingPairingId,
    })).toEqual({ status: 'paired', pairingId: first.id })
    await expect(provider.getMobilePairingStatus({
      mobile: authentication('other-mobile', 'account-one'),
      pendingPairingId: completion.pendingPairingId,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
    expect(handshake.activatePairing).toHaveBeenCalledOnce()
    expect(handshake.destroyPendingPairing).toHaveBeenCalledOnce()
  })

  it('accepts completion one millisecond before expiry and rejects at the deadline', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake, now)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    const live = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('live-bound'), clientIp: '192.0.2.1',
    })
    now.value += PAIRING_CHALLENGE_TTL_MS - 1
    await expect(complete(provider, live.oneTimeLink, 'live-bound')).resolves.toMatchObject({
      device: { name: 'Work Android installation' },
    })

    const expired = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('deadline'), clientIp: '192.0.2.1',
    })
    now.value += PAIRING_CHALLENGE_TTL_MS
    await expect(complete(provider, expired.oneTimeLink, 'deadline')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_EXPIRED' }),
    )
  })

  it('destroys expiry, cancellation, rejection, and successful-use capabilities', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake, now)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    const expired = await provider.createChallenge({ desktop, rendezvousId: 'expired' as never,
      clientIp: '192.0.2.1',
    })
    now.value += PAIRING_CHALLENGE_TTL_MS
    await expect(complete(provider, expired.oneTimeLink, 'expired')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_EXPIRED' }),
    )

    const cancelled = await provider.createChallenge({ desktop, rendezvousId: 'cancelled' as never,
      clientIp: '192.0.2.1',
    })
    await provider.cancelChallenge({ desktop, challengeId: cancelled.challengeId })
    await provider.cancelChallenge({ desktop, challengeId: cancelled.challengeId })
    await expect(complete(provider, cancelled.oneTimeLink, 'cancelled')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }),
    )

    const rejected = await provider.createChallenge({ desktop, rendezvousId: 'rejected' as never,
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, rejected.oneTimeLink, 'rejected')
    await provider.rejectPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    await provider.rejectPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    expect(await provider.getMobilePairingStatus({
      mobile: authentication('mobile-installation', 'account-one'),
      pendingPairingId: pending.pendingPairingId,
    })).toEqual({ status: 'rejected' })
    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }),
    )

    const used = await provider.createChallenge({ desktop, rendezvousId: 'used' as never,
      clientIp: '192.0.2.1',
    })
    await complete(provider, used.oneTimeLink, 'used-first')
    await expect(complete(provider, used.oneTimeLink, 'used-second')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }),
    )

    expect(handshake.destroyChallenge).toHaveBeenCalledTimes(4)
    expect(handshake.destroyPendingPairing).toHaveBeenCalledOnce()
  })

  it('admits only one concurrent completion for one invitation', async () => {
    const handshake = handshakeProvider()
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: 'concurrent' as never,
      clientIp: '192.0.2.1',
    })

    const results = await Promise.allSettled([
      complete(provider, challenge.oneTimeLink, 'concurrent-one'),
      complete(provider, challenge.oneTimeLink, 'concurrent-two'),
    ])

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
    expect(handshake.destroyChallenge).toHaveBeenCalledOnce()
  })

  it('bounds concurrent active state per authenticated Installation', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })

    const challenges = await Promise.all(Array.from(
      { length: MAX_ACTIVE_PAIRING_CHALLENGES_PER_INSTALLATION },
      (_, index) => provider.createChallenge({
        desktop,
        rendezvousId: parsePairingRendezvousId(`bounded-${String(index)}`),
        clientIp: '192.0.2.1',
      }),
    ))
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('over-challenge-limit'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }))
    expect(handshake.createChallenge).toHaveBeenCalledTimes(MAX_ACTIVE_PAIRING_CHALLENGES_PER_INSTALLATION)

    await provider.cancelChallenge({ desktop, challengeId: challenges[0]!.challengeId })
    const replacement = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('replacement'),
      clientIp: '192.0.2.1',
    })
    for (const challenge of [...challenges.slice(1), replacement]) {
      await complete(provider, challenge.oneTimeLink, challenge.challengeId)
    }
    const next = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('pending-limit'),
      clientIp: '192.0.2.1',
    })
    await expect(complete(provider, next.oneTimeLink, 'over-pending-limit')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }),
    )
    expect(handshake.completeChallenge).toHaveBeenCalledTimes(MAX_PENDING_PAIRINGS_PER_INSTALLATION)
  })

  it('retains idempotent replay for a fixed window and evicts cleaned terminal projections', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake, now)
    const desktop = authentication('desktop-installation')
    const mobile = authentication('mobile-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('retention'),
      clientIp: '192.0.2.1',
    })
    const input = {
      mobile,
      completionId: parsePairingCompletionId('retained-completion'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    }

    const first = await provider.completeChallenge(input)
    now.value += PAIRING_REPLAY_RETENTION_MS - 1
    expect(await provider.completeChallenge(input)).toEqual(first)
    await provider.rejectPairing({ desktop, pendingPairingId: first.pendingPairingId })
    expect(await provider.getMobilePairingStatus({ mobile, pendingPairingId: first.pendingPairingId }))
      .toEqual({ status: 'rejected' })

    now.value += 1
    await expect(provider.completeChallenge(input)).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }),
    )
    expect(await provider.getMobilePairingStatus({ mobile, pendingPairingId: first.pendingPairingId }))
      .toEqual({ status: 'rejected' })
    now.value += PAIRING_REPLAY_RETENTION_MS
    await expect(provider.getMobilePairingStatus({ mobile, pendingPairingId: first.pendingPairingId })).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }),
    )
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
  })

  it('keeps cleanup-failed replay tombstones past retention until retry succeeds', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    handshake.destroyChallenge.mockRejectedValueOnce(new Error('cleanup unavailable'))
    const provider = uniquePairingProvider(handshake, now)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('cleanup-retention'),
      clientIp: '192.0.2.1',
    })
    const input = {
      mobile: authentication('mobile-installation'),
      completionId: parsePairingCompletionId('cleanup-retention'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    }

    await expect(provider.completeChallenge(input)).rejects.toThrow('cleanup unavailable')
    now.value += PAIRING_REPLAY_RETENTION_MS
    expect(typeof (await provider.completeChallenge(input)).pendingPairingId).toBe('string')
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
    expect(handshake.destroyChallenge).toHaveBeenCalledTimes(2)
  })

  it('bounds retained terminal records per Installation and never evicts cleanup failures early', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    handshake.destroyChallenge.mockRejectedValue(new Error('cleanup unavailable'))
    const provider = uniquePairingProvider(handshake, now)
    const desktop = authentication('desktop-installation')
    const otherDesktop = authentication('other-desktop')
    await provider.setMobileAccess({ desktop, enabled: true })
    await provider.setMobileAccess({ desktop: otherDesktop, enabled: true })
    const retained = []
    for (let index = 0; index < MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION; index += 1) {
      if (index > 0 && index % OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour === 0) {
        now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
      }
      const challenge = await provider.createChallenge({
        desktop, rendezvousId: parsePairingRendezvousId(`retained-${String(index)}`),
        clientIp: '192.0.2.1',
      })
      retained.push(challenge)
      await expect(provider.cancelChallenge({ desktop, challengeId: challenge.challengeId }))
        .rejects.toThrow('cleanup unavailable')
    }

    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('retained-over-limit'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }))
    await expect(provider.createChallenge({
      desktop: otherDesktop, rendezvousId: parsePairingRendezvousId('isolated-installation'),
      clientIp: '192.0.2.1',
    })).resolves.toBeDefined()

    now.value += PAIRING_REPLAY_RETENTION_MS
    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('cleanup-still-retained'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }))

    handshake.destroyChallenge.mockResolvedValue(undefined)
    for (const challenge of retained) {
      await provider.cancelChallenge({ desktop, challengeId: challenge.challengeId })
    }
    await provider.getMobileAccessState(desktop)
    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('capacity-released'),
      clientIp: '192.0.2.1',
    })).resolves.toBeDefined()
  })

  it('releases cleaned retained-record capacity only after replay expiry', async () => {
    const now = { value: NOW }
    const provider = uniquePairingProvider(handshakeProvider(), now)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    for (let index = 0; index < OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour; index += 1) {
      const challenge = await provider.createChallenge({
        desktop, rendezvousId: parsePairingRendezvousId(`cleaned-${String(index)}`),
        clientIp: '192.0.2.1',
      })
      await provider.cancelChallenge({ desktop, challengeId: challenge.challengeId })
    }
    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('cleaned-over-limit'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'QUOTA' }))
    now.value += PAIRING_REPLAY_RETENTION_MS
    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('cleaned-after-retention-still-hourly'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'QUOTA' }))
    now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS
    await expect(provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('cleaned-after-hourly'),
      clientIp: '192.0.2.1',
    })).resolves.toBeDefined()
  })

  it('retains orphaned pending-key capacity by owning Installation until cleanup succeeds', async () => {
    const now = { value: NOW }
    const handshake = handshakeProvider()
    handshake.destroyPendingPairing.mockRejectedValue(new Error('pending cleanup unavailable'))
    let invalidPendingId = true
    let sequence = 0
    const provider = new PersonalPairingProvider(new Context(), {
      account: {
        currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
      },
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      clock: { now: () => now.value },
      randomBytes: size => new Uint8Array(size),
      randomId: kind => invalidPendingId && kind === 'completion' ? '' : `${kind}-${String(sequence += 1)}`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation', 'account-one')
    const mobile = authentication('mobile-installation', 'account-one')
    const otherDesktop = authentication('other-desktop', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    await provider.setMobileAccess({ desktop: otherDesktop, enabled: true })

    let blockedChallenge: Awaited<ReturnType<typeof provider.createChallenge>> | undefined
    for (let index = 0; index < MAX_RETAINED_PAIRING_RECORDS_PER_INSTALLATION; index += 1) {
      if (index > 0 && index % OPEN_REGISTRATION_QUOTAS.pairingChallengesPerAccountPerHour === 0) {
        now.value += PAIRING_CHALLENGE_QUOTA_WINDOW_MS + 1
      }
      const challenge = await provider.createChallenge({
        desktop,
        rendezvousId: parsePairingRendezvousId(`orphan-capacity-${String(index)}`),
        clientIp: '192.0.2.1',
      })
      const allocationCount = handshake.completeChallenge.mock.calls.length
      const result = await provider.completeChallenge({
        mobile,
        completionId: parsePairingCompletionId(`orphan-capacity-${String(index)}`),
        oneTimeLink: challenge.oneTimeLink,
        mobileHandshake: Uint8Array.of(9),
      }).catch((error: unknown) => error)
      if (result instanceof RemoteAccessError && result.code === 'PAIRING_RESOURCE_LIMIT') {
        expect(handshake.completeChallenge).toHaveBeenCalledTimes(allocationCount)
        blockedChallenge = challenge
        break
      }
      if (result instanceof RemoteAccessError) {
        throw new Error(`unexpected ${result.code}: ${result.message}`)
      }
      expect(result).toBeInstanceOf(AggregateError)
      now.value += PAIRING_REPLAY_RETENTION_MS
    }
    expect(blockedChallenge).toBeDefined()
    const retainedAllocationCount = handshake.completeChallenge.mock.calls.length

    now.value += PAIRING_REPLAY_RETENTION_MS * 3
    const stillBlockedChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('orphan-capacity-still-blocked'),
      clientIp: '192.0.2.1',
    })
    await expect(provider.completeChallenge({
      mobile,
      completionId: parsePairingCompletionId('orphan-capacity-still-blocked'),
      oneTimeLink: stillBlockedChallenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }))
    expect(handshake.completeChallenge).toHaveBeenCalledTimes(retainedAllocationCount)

    invalidPendingId = false
    const isolatedChallenge = await provider.createChallenge({
      desktop: otherDesktop,
      rendezvousId: parsePairingRendezvousId('orphan-capacity-isolated'),
      clientIp: '192.0.2.1',
    })
    await expect(completeAs(
      provider,
      isolatedChallenge.oneTimeLink,
      'orphan-capacity-isolated',
      'other-mobile',
      'account-one',
    )).resolves.toBeDefined()
    handshake.destroyPendingPairing.mockResolvedValue(undefined)
    await provider.setMobileAccess({ desktop: otherDesktop, enabled: false })
    handshake.destroyPendingPairing.mockRejectedValue(new Error('pending cleanup unavailable'))
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('orphan-capacity-cross-owner-cleanup'),
      clientIp: '192.0.2.1',
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_RESOURCE_LIMIT' }))

    handshake.destroyPendingPairing.mockResolvedValue(undefined)
    await provider.setMobileAccess({ desktop, enabled: false })
    await provider.setMobileAccess({ desktop, enabled: true })
    await expect(provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('orphan-capacity-released'),
      clientIp: '192.0.2.1',
    })).resolves.toBeDefined()
  })

  it('retries cleanup tombstones without repeating handshake or activation', async () => {
    const handshake = handshakeProvider()
    handshake.destroyChallenge.mockRejectedValueOnce(new Error('challenge cleanup failed'))
    handshake.destroyPendingPairing.mockRejectedValueOnce(new Error('pending cleanup failed'))
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('cleanup-retry'),
      clientIp: '192.0.2.1',
    })
    const input = {
      mobile: authentication('mobile-installation'),
      completionId: parsePairingCompletionId('completion-cleanup-retry'),
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    }

    await expect(provider.completeChallenge(input)).rejects.toThrow('challenge cleanup failed')
    const pending = await provider.completeChallenge(input)
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
    expect(handshake.destroyChallenge).toHaveBeenCalledTimes(2)

    await expect(provider.confirmPairing({
      desktop,
      pendingPairingId: pending.pendingPairingId,
    })).rejects.toThrow('pending cleanup failed')
    await expect(provider.confirmPairing({
      desktop,
      pendingPairingId: pending.pendingPairingId,
    })).resolves.toBeDefined()
    expect(handshake.activatePairing).toHaveBeenCalledOnce()
    expect(handshake.destroyPendingPairing).toHaveBeenCalledTimes(2)
  })

  it('settles cancellation and rejection before retryable cleanup', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const cancelled = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('cancel-cleanup'),
      clientIp: '192.0.2.1',
    })
    handshake.destroyChallenge.mockRejectedValueOnce(new Error('cancel cleanup failed'))
    const cancellations = await Promise.allSettled([
      provider.cancelChallenge({ desktop, challengeId: cancelled.challengeId }),
      provider.cancelChallenge({ desktop, challengeId: cancelled.challengeId }),
    ])
    expect(cancellations.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])

    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('reject-cleanup'),
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, challenge.oneTimeLink, 'reject-cleanup')
    handshake.destroyPendingPairing.mockRejectedValueOnce(new Error('reject cleanup failed'))
    const rejections = await Promise.allSettled([
      provider.rejectPairing({ desktop, pendingPairingId: pending.pendingPairingId }),
      provider.rejectPairing({ desktop, pendingPairingId: pending.pendingPairingId }),
    ])
    expect(rejections.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('eagerly expires challenges while instance disposal preserves active pairing authority', async () => {
    const scheduled: Array<() => void> = []
    const now = { value: NOW }
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake, now, (task) => {
      scheduled.push(task)
      return { unref: vi.fn() } as never
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('eager-expiry'),
      clientIp: '192.0.2.1',
    })
    now.value += PAIRING_CHALLENGE_TTL_MS
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(handshake.destroyChallenge).toHaveBeenCalledOnce() })

    const pendingChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('dispose-pending'),
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, pendingChallenge.oneTimeLink, 'dispose-pending')
    const activeChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('dispose-active'),
      clientIp: '192.0.2.1',
    })
    const livePendingChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('dispose-live-pending'),
      clientIp: '192.0.2.1',
    })
    await complete(provider, livePendingChallenge.oneTimeLink, 'dispose-live-pending')
    expect(activeChallenge).toBeDefined()
    await provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId })
    handshake.destroyChallenge.mockRejectedValueOnce(new Error('dispose challenge failed'))
    await expect(provider.dispose()).rejects.toThrow('Personal Pairing resource cleanup failed')
    expect(handshake.destroyChallenge).toHaveBeenCalled()
    expect(handshake.destroyPairing).not.toHaveBeenCalled()
    await expect(provider.dispose()).resolves.toBeUndefined()
  })

  it('runs lifecycle disposal and retries an orphaned pending-key cleanup', async () => {
    const ctx = new Context()
    const handshake = handshakeProvider()
    const provider = new PersonalPairingProvider(ctx, {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      ownsAuthority: true,
      clock: { now: () => NOW },
      randomBytes: size => new Uint8Array(size),
      randomId: kind => kind === 'challenge' ? crypto.randomUUID() : `${kind}-collision`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const first = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('orphan-first'),
      clientIp: '192.0.2.1',
    })
    await complete(provider, first.oneTimeLink, 'orphan-first')
    const second = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('orphan-second'),
      clientIp: '192.0.2.1',
    })
    handshake.destroyPendingPairing.mockRejectedValueOnce(new Error('orphan cleanup failed'))
    await expect(complete(provider, second.oneTimeLink, 'orphan-second')).rejects.toThrow(AggregateError)

    await ctx.fiber.dispose()
    expect(handshake.destroyPendingPairing).toHaveBeenCalledTimes(3)
  })

  it('fails loud on a generated pending id collision without leaking its pending key', async () => {
    const handshake = handshakeProvider()
    const provider = new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      clock: { now: () => NOW },
      randomBytes: size => new Uint8Array(size),
      randomId: kind => kind === 'challenge' ? crypto.randomUUID() : `${kind}-collision`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const firstChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('first'),
      clientIp: '192.0.2.1',
    })
    const firstPending = await complete(provider, firstChallenge.oneTimeLink, 'first-collision')
    const secondChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('second'),
      clientIp: '192.0.2.1',
    })
    await expect(complete(provider, secondChallenge.oneTimeLink, 'second-collision'))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))
    expect(handshake.destroyPendingPairing).toHaveBeenCalledOnce()

    await provider.confirmPairing({ desktop, pendingPairingId: firstPending.pendingPairingId })
    expect(handshake.destroyPendingPairing).toHaveBeenCalledTimes(2)
  })

  it('rolls back only the new activation when its public key reference collides', async () => {
    const handshake = handshakeProvider()
    const firstActivation = Uint8Array.of(31)
    const collidingActivation = Uint8Array.of(32)
    handshake.activatePairing
      .mockResolvedValueOnce({ keyReference: 'key-shared' as never, activePairingKey: firstActivation })
      .mockResolvedValueOnce({ keyReference: 'key-shared' as never, activePairingKey: collidingActivation })
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })

    const firstChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('first-key-reference'),
      clientIp: '192.0.2.1',
    })
    const firstPending = await complete(provider, firstChallenge.oneTimeLink, 'first-key-reference')
    const firstPairing = await provider.confirmPairing({ desktop, pendingPairingId: firstPending.pendingPairingId })
    const secondChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('second-key-reference'),
      clientIp: '192.0.2.1',
    })
    const secondPending = await complete(provider, secondChallenge.oneTimeLink, 'second-key-reference')

    await expect(provider.confirmPairing({ desktop, pendingPairingId: secondPending.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))

    expect(handshake.destroyPairing).toHaveBeenCalledOnce()
    expect(handshake.destroyPairing).toHaveBeenCalledWith(collidingActivation)
    expect(await provider.listPersonalPairings(desktop)).toEqual([firstPairing])
    expect(firstPairing.devicePrincipal.authority).toBe('companion-surface')

    await provider.dispose()
    expect(handshake.destroyPairing).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'public key reference parse',
      configure: (handshake: ReturnType<typeof handshakeProvider>) => {
        handshake.activatePairing.mockResolvedValueOnce({
          keyReference: '' as never,
          activePairingKey: Uint8Array.of(41),
        })
      },
      expected: 'must be non-empty',
    },
    {
      label: 'random id source',
      configure: (_handshake: ReturnType<typeof handshakeProvider>) => {},
      expected: 'random id unavailable',
    },
  ])('destroys the new activation handle when $label fails', async ({ label, configure, expected }) => {
    const handshake = handshakeProvider()
    configure(handshake)
    let id = 0
    const provider = new PersonalPairingProvider(new Context(), {
      account: {
        currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
      },
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      clock: { now: () => NOW },
      randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
      randomId: (kind) => {
        if (label === 'random id source' && kind === 'pairing') throw new Error('random id unavailable')
        return `${kind}-${String(++id)}`
      },
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId(`activation-${label}`),
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, challenge.oneTimeLink, `activation-${label}`)

    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId }))
      .rejects.toThrow(expected)
    expect(handshake.destroyPairing).toHaveBeenCalledOnce()
    expect(await provider.listPendingPairings(desktop)).toHaveLength(1)
  })

  it('retains a new activation handle when parse rollback cleanup fails and retries it on disposal', async () => {
    const handshake = handshakeProvider()
    handshake.activatePairing.mockResolvedValueOnce({
      keyReference: '' as never,
      activePairingKey: Uint8Array.of(42),
    })
    handshake.destroyPairing.mockRejectedValueOnce(new Error('activation cleanup unavailable'))
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('activation-cleanup-retry'),
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, challenge.oneTimeLink, 'activation-cleanup-retry')

    await expect(provider.confirmPairing({ desktop, pendingPairingId: pending.pendingPairingId }))
      .rejects.toThrow('Personal Pairing activation rollback failed')
    expect(await provider.listPendingPairings(desktop)).toHaveLength(1)
    await expect(provider.dispose()).resolves.toBeUndefined()
    expect(handshake.destroyPairing).toHaveBeenCalledTimes(2)
    expect(handshake.destroyPairing).toHaveBeenNthCalledWith(1, Uint8Array.of(42))
    expect(handshake.destroyPairing).toHaveBeenNthCalledWith(2, Uint8Array.of(42))
  })

  it.each([
    { label: 'pairing', pairingIds: ['pairing-same', 'pairing-same'], principalIds: ['principal-one', 'principal-two'] },
    { label: 'principal', pairingIds: ['pairing-one', 'pairing-two'], principalIds: ['principal-same', 'principal-same'] },
  ])('retains retryable cleanup after a generated $label id collision', async ({ pairingIds, principalIds }) => {
    const handshake = handshakeProvider()
    handshake.activatePairing
      .mockResolvedValueOnce({ keyReference: 'key-one' as never, activePairingKey: Uint8Array.of(1) })
      .mockResolvedValueOnce({ keyReference: 'key-two' as never, activePairingKey: Uint8Array.of(2) })
    const provider = collisionPairingProvider(handshake, pairingIds, principalIds)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })

    const firstChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('first-generated-collision'),
      clientIp: '192.0.2.1',
    })
    const first = await complete(provider, firstChallenge.oneTimeLink, 'first-generated-collision')
    await provider.confirmPairing({ desktop, pendingPairingId: first.pendingPairingId })

    const secondChallenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('second-generated-collision'),
      clientIp: '192.0.2.1',
    })
    const second = await complete(provider, secondChallenge.oneTimeLink, 'second-generated-collision')
    handshake.destroyPairing.mockRejectedValueOnce(new Error('active collision cleanup failed'))
    await expect(provider.confirmPairing({ desktop, pendingPairingId: second.pendingPairingId }))
      .rejects.toThrow(AggregateError)
    await expect(provider.confirmPairing({ desktop, pendingPairingId: second.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))

    expect(handshake.activatePairing).toHaveBeenCalledTimes(2)
    expect(handshake.destroyPendingPairing).toHaveBeenCalledTimes(2)
    expect(handshake.destroyPairing).toHaveBeenCalledTimes(2)
  })

  it('reports a generated pairing identity collision after successful cleanup', async () => {
    const handshake = handshakeProvider()
    handshake.activatePairing
      .mockResolvedValueOnce({ keyReference: 'key-one' as never, activePairingKey: Uint8Array.of(1) })
      .mockResolvedValueOnce({ keyReference: 'key-two' as never, activePairingKey: Uint8Array.of(2) })
    const provider = collisionPairingProvider(
      handshake,
      ['pairing-same', 'pairing-same'],
      ['principal-one', 'principal-two'],
    )
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const firstChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('direct-first'),
      clientIp: '192.0.2.1',
    })
    const first = await complete(provider, firstChallenge.oneTimeLink, 'direct-first')
    await provider.confirmPairing({ desktop, pendingPairingId: first.pendingPairingId })
    const secondChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('direct-second'),
      clientIp: '192.0.2.1',
    })
    const second = await complete(provider, secondChallenge.oneTimeLink, 'direct-second')
    await expect(provider.confirmPairing({ desktop, pendingPairingId: second.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))
  })

  it('rejects a completion id collision before starting another handshake', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const first = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('first'),
      clientIp: '192.0.2.1',
    })
    const second = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('second'),
      clientIp: '192.0.2.1',
    })
    const completionId = parsePairingCompletionId('completion-collision')
    await provider.completeChallenge({
      mobile: authentication('mobile-installation'), completionId, oneTimeLink: first.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })
    await expect(provider.completeChallenge({
      mobile: authentication('mobile-installation'), completionId, oneTimeLink: second.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
  })

  it('binds completion replay to every invitation field and the Mobile handshake', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop,
      rendezvousId: parsePairingRendezvousId('digest-binding'),
      clientIp: '192.0.2.1',
    })
    const completionId = parsePairingCompletionId('completion-digest-binding')
    const original = {
      mobile: authentication('mobile-installation'),
      completionId,
      oneTimeLink: challenge.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    }
    const completed = await provider.completeChallenge(original)
    await expect(provider.completeChallenge(original)).resolves.toEqual(completed)

    const change = (name: string, value: string): string => {
      const url = new URL(challenge.oneTimeLink)
      url.searchParams.set(name, value)
      return url.toString()
    }
    const altered = [
      { ...original, mobileHandshake: Uint8Array.of(8) },
      { ...original, oneTimeLink: change('secret', Buffer.alloc(32, 7).toString('base64url')) },
      { ...original, oneTimeLink: change('rendezvous', 'different-rendezvous') },
      { ...original, oneTimeLink: change('fingerprint', 'different-fingerprint') },
      { ...original, oneTimeLink: change('expires', String(challenge.expiresAt + 1)) },
    ]
    for (const request of altered) {
      await expect(provider.completeChallenge(request)).rejects.toEqual(
        expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }),
      )
    }
    expect(handshake.completeChallenge).toHaveBeenCalledOnce()
  })

  it('retries an eager-expiry cleanup tombstone through the expired invitation', async () => {
    const scheduled: Array<() => void> = []
    const now = { value: NOW }
    const handshake = handshakeProvider()
    handshake.destroyChallenge.mockRejectedValueOnce(new Error('expiry cleanup failed'))
    const provider = uniquePairingProvider(handshake, now, (task) => {
      scheduled.push(task)
      return { unref: vi.fn() } as never
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('expiry-retry'),
      clientIp: '192.0.2.1',
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    now.value += PAIRING_CHALLENGE_TTL_MS
    scheduled.shift()?.()
    await vi.waitFor(() => { expect(handshake.destroyChallenge).toHaveBeenCalledOnce() })
    await expect(complete(provider, challenge.oneTimeLink, 'expiry-retry'))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_EXPIRED' }))
    expect(handshake.destroyChallenge).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  it('does not recreate an invitation after Mobile Access is concurrently disabled', async () => {
    const handshake = handshakeProvider()
    const created = deferred<Awaited<ReturnType<PairingHandshakeProvider['createChallenge']>>>()
    handshake.createChallenge.mockReturnValueOnce(created.promise)
    const provider = pairingProvider(handshake)
    const desktop = authentication('desktop-installation', 'account-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    const creating = provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('concurrent-disable'),
      clientIp: '192.0.2.1',
    })
    await vi.waitFor(() => { expect(handshake.createChallenge).toHaveBeenCalledOnce() })
    let disabled = false
    const disabling = provider.setMobileAccess({ desktop, enabled: false }).then((state) => {
      disabled = true
      return state
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(disabled).toBe(false)
    created.resolve({ desktopFingerprint: 'desktop-fingerprint', state: Uint8Array.of(1) })
    const challenge = await creating
    await disabling

    await expect(complete(provider, challenge.oneTimeLink, 'disabled-after-create')).rejects.toEqual(
      expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }),
    )
    expect(handshake.destroyChallenge).toHaveBeenCalledOnce()
  })

  it('fails closed on invalid provider output and uses secure production defaults', async () => {
    const handshake = handshakeProvider()
    expect(() => new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake,
      pairingLinkOrigin: 'http://platform.example.com/pair',
    })).toThrow('must use HTTPS')

    const defaults = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')
    await defaults.setMobileAccess({ desktop, enabled: true })
    const challenge = await defaults.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('defaults'),
      clientIp: '192.0.2.1',
    })
    expect(parsePairingInvitationLink(challenge.oneTimeLink).invitationSecret).toHaveLength(32)
    expect(challenge.challengeId).toMatch(/^challenge-/u)

    const badRandom = new PersonalPairingProvider(new Context(), {
      account: accountService(account('account-one')),
      handshake,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: () => Uint8Array.of(1),
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    await badRandom.setMobileAccess({ desktop, enabled: true })
    await expect(badRandom.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('bad-random'),
      clientIp: '192.0.2.1',
    }))
      .rejects.toThrow('must return 32 bytes')

    handshake.createChallenge.mockResolvedValueOnce({ desktopFingerprint: '', state: Uint8Array.of(2) })
    await expect(defaults.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('bad-fingerprint'),
      clientIp: '192.0.2.1',
    }))
      .rejects.toThrow('Desktop fingerprint must be non-empty')
    expect(handshake.destroyChallenge).toHaveBeenCalledWith(Uint8Array.of(2))

    const collisionHandshake = handshakeProvider()
    const collision = pairingProvider(collisionHandshake)
    await collision.setMobileAccess({ desktop, enabled: true })
    await collision.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('first-id'),
      clientIp: '192.0.2.1',
    })
    await expect(collision.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('reused-id'),
      clientIp: '192.0.2.1',
    }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))
    expect(collisionHandshake.destroyChallenge).toHaveBeenCalledOnce()
  })

  it('disables only the owning Desktop capabilities and rejects cross-owner retries', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktopOne = authentication('desktop-one', 'account-one')
    const desktopTwo = authentication('desktop-two', 'account-one')
    await provider.setMobileAccess({ desktop: desktopOne, enabled: true })
    await provider.setMobileAccess({ desktop: desktopTwo, enabled: true })

    const challengeOne = await provider.createChallenge({ desktop: desktopOne, rendezvousId: parsePairingRendezvousId('one'),
      clientIp: '192.0.2.1',
    })
    const pendingOne = await completeAs(provider, challengeOne.oneTimeLink, 'one', 'mobile-one', 'account-one')
    const challengeTwo = await provider.createChallenge({ desktop: desktopTwo, rendezvousId: parsePairingRendezvousId('two'),
      clientIp: '192.0.2.1',
    })
    const pendingTwo = await completeAs(provider, challengeTwo.oneTimeLink, 'two', 'mobile-two', 'account-one')
    const settledTwoChallenge = await provider.createChallenge({
      desktop: desktopTwo, rendezvousId: parsePairingRendezvousId('settled-two'),
      clientIp: '192.0.2.1',
    })
    const settledTwo = await completeAs(provider, settledTwoChallenge.oneTimeLink, 'settled-two', 'mobile-four', 'account-one')
    await provider.rejectPairing({ desktop: desktopTwo, pendingPairingId: settledTwo.pendingPairingId })
    const activeOne = await provider.createChallenge({ desktop: desktopOne, rendezvousId: parsePairingRendezvousId('active-one'),
      clientIp: '192.0.2.1',
    })
    const activeTwo = await provider.createChallenge({ desktop: desktopTwo, rendezvousId: parsePairingRendezvousId('active-two'),
      clientIp: '192.0.2.1',
    })

    await expect(provider.completeChallenge({
      mobile: authentication('other-mobile', 'account-one'),
      completionId: parsePairingCompletionId('completion-one'),
      oneTimeLink: challengeOne.oneTimeLink,
      mobileHandshake: Uint8Array.of(9),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_USED' }))

    expect(await provider.setMobileAccess({ desktop: desktopOne, enabled: false })).toEqual({ enabled: false })
    expect(await provider.listPendingPairings(desktopOne)).toEqual([])
    expect(await provider.listPendingPairings(desktopTwo)).toEqual([pendingTwo])
    await expect(completeAs(provider, activeOne.oneTimeLink, 'disabled', 'mobile-three', 'account-one'))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))
    await expect(provider.confirmPairing({ desktop: desktopOne, pendingPairingId: pendingOne.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))

    await expect(provider.cancelChallenge({ desktop: desktopOne, challengeId: activeTwo.challengeId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))
    await expect(provider.cancelChallenge({ desktop: authentication('desktop-two', 'account-two'), challengeId: activeTwo.challengeId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))
    await expect(provider.cancelChallenge({ desktop: desktopOne, challengeId: parsePairingChallengeId('missing') }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))

    await expect(provider.rejectPairing({ desktop: desktopOne, pendingPairingId: pendingTwo.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
    await expect(provider.rejectPairing({
      desktop: authentication('desktop-two', 'account-two'), pendingPairingId: pendingTwo.pendingPairingId,
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
    await expect(provider.rejectPairing({ desktop: desktopOne, pendingPairingId: parsePendingPairingId('missing') }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
    await provider.rejectPairing({ desktop: desktopTwo, pendingPairingId: pendingTwo.pendingPairingId })
    await provider.cancelChallenge({ desktop: desktopTwo, challengeId: activeTwo.challengeId })
  })

  it('rejects mismatched invitations and terminal actions owned by another state or Installation', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-one')
    const otherDesktop = authentication('desktop-two')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('mismatch'),
      clientIp: '192.0.2.1',
    })
    const changed = new URL(challenge.oneTimeLink)
    changed.searchParams.set('rendezvous', 'different')
    changed.searchParams.set('secret', 'A'.repeat(43))
    expect(parsePairingInvitationLink(changed.toString())).toMatchObject({
      challengeId: challenge.challengeId,
      rendezvousId: 'different',
    })
    const mismatch = await complete(provider, changed.toString(), 'mismatch').catch((error: unknown) => error)
    expect(mismatch).toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))

    const missing = new URL(challenge.oneTimeLink)
    missing.searchParams.set('challenge', 'missing')
    await expect(complete(provider, missing.toString(), 'missing'))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))

    const cancelled = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('cancel-owner'),
      clientIp: '192.0.2.1',
    })
    await provider.cancelChallenge({ desktop, challengeId: cancelled.challengeId })
    await expect(provider.cancelChallenge({ desktop: otherDesktop, challengeId: cancelled.challengeId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))

    const used = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('used-terminal'),
      clientIp: '192.0.2.1',
    })
    const confirmed = await complete(provider, used.oneTimeLink, 'used-terminal')
    await provider.confirmPairing({ desktop, pendingPairingId: confirmed.pendingPairingId })
    await expect(provider.cancelChallenge({ desktop, challengeId: used.challengeId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_CHALLENGE_INVALID' }))
    await expect(provider.rejectPairing({ desktop, pendingPairingId: confirmed.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))

    const rejected = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('reject-owner'),
      clientIp: '192.0.2.1',
    })
    const rejectedPending = await complete(provider, rejected.oneTimeLink, 'reject-owner')
    await provider.rejectPairing({ desktop, pendingPairingId: rejectedPending.pendingPairingId })
    await expect(provider.rejectPairing({ desktop: otherDesktop, pendingPairingId: rejectedPending.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))
  })

  it('ignores an expiry timer that fires before its deadline', async () => {
    const scheduled: Array<() => void> = []
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake, { value: NOW }, (task) => {
      scheduled.push(task)
      return { unref: vi.fn() } as never
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('early-timer'),
      clientIp: '192.0.2.1',
    })
    scheduled[0]?.()
    await Promise.resolve()
    expect(handshake.destroyChallenge).not.toHaveBeenCalled()
    await provider.cancelChallenge({ desktop, challengeId: challenge.challengeId })
  })

  it('rejects reused pairing keys and hides active pairings from other Desktops', async () => {
    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-one')
    await provider.setMobileAccess({ desktop, enabled: true })

    const firstChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('first'),
      clientIp: '192.0.2.1',
    })
    const firstPending = await completeAs(provider, firstChallenge.oneTimeLink, 'first', 'mobile-one', 'account-one')
    await provider.confirmPairing({ desktop, pendingPairingId: firstPending.pendingPairingId })
    expect(await provider.listPersonalPairings(authentication('desktop-two'))).toEqual([])

    const secondChallenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('second'),
      clientIp: '192.0.2.1',
    })
    const secondPending = await completeAs(provider, secondChallenge.oneTimeLink, 'second', 'mobile-two', 'account-one')
    await expect(provider.confirmPairing({ desktop, pendingPairingId: secondPending.pendingPairingId }))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_ID_COLLISION' }))
    expect(handshake.destroyPairing).toHaveBeenCalledOnce()
  })

  it('parses every branded id and rejects malformed invitation wire values', async () => {
    expect(parsePairingChallengeId('challenge')).toBe('challenge')
    expect(parsePairingCompletionId('completion')).toBe('completion')
    expect(parsePairingRendezvousId('rendezvous')).toBe('rendezvous')
    expect(parsePendingPairingId('pending')).toBe('pending')
    expect(parseDevicePrincipalId('principal')).toBe('principal')
    expect(parsePersonalPairingId('pairing')).toBe('pairing')
    expect(() => parsePairingChallengeId(undefined)).toThrow('must be non-empty')
    expect(() => parsePairingChallengeId(' ')).toThrow('must be non-empty')
    expect(() => deriveAuthenticationWords(Uint8Array.of(1))).toThrow('at least 32 bytes')

    const handshake = handshakeProvider()
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-one')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({ desktop, rendezvousId: parsePairingRendezvousId('wire'),
      clientIp: '192.0.2.1',
    })
    const valid = new URL(challenge.oneTimeLink)
    const invalidLinks = [
      'not a URL',
      'http' + challenge.oneTimeLink.slice('https'.length),
      mutateLink(valid, (url) => { url.searchParams.delete('challenge') }),
      mutateLink(valid, (url) => { url.searchParams.append('challenge', 'duplicate') }),
      mutateLink(valid, (url) => { url.searchParams.set('secret', 'AA') }),
      mutateLink(valid, (url) => { url.searchParams.set('secret', '*') }),
      mutateLink(valid, (url) => { url.searchParams.set('secret', 'A') }),
      mutateLink(valid, (url) => { url.searchParams.set('secret', 'AB') }),
      mutateLink(valid, (url) => { url.searchParams.set('expires', '0') }),
      mutateLink(valid, (url) => { url.searchParams.set('expires', 'not-a-number') }),
      mutateLink(valid, (url) => { url.searchParams.set('protocol', '2') }),
    ]
    for (const link of invalidLinks) expect(() => parsePairingInvitationLink(link)).toThrow()

    await expect(provider.revokePersonalPairing({
      desktop,
      pairingId: parsePersonalPairingId('missing-pairing'),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteAccessError>>({ code: 'PAIRING_PENDING_INVALID' }))

  })

  it('reissues Desktop Relay authority only for an enabled shared route', async () => {
    const routeId = parseRelayRouteId('route-reissue')
    const first = parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const rotated = parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE')
    const relay = {
      rotateCredential: vi.fn()
        .mockResolvedValueOnce({ routeId, endpoint: 'desktop' as const, credential: first, revision: 1 })
        .mockResolvedValueOnce({ routeId, endpoint: 'desktop' as const, credential: rotated, revision: 2 }),
      issueCredential: vi.fn(),
      revokeCredential: vi.fn(),
      revokeRoute: vi.fn(),
    }
    const provider = new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake: handshakeProvider(),
      relay,
      authority: new MemoryPersonalPairingAuthorityStore(),
      randomBytes: size => new Uint8Array(size),
      randomId: kind => kind === 'relay-route' ? routeId : `${kind}-reissue`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')

    await expect(provider.reissueDesktopRelayAuthority(desktop)).rejects.toMatchObject({
      code: 'MOBILE_ACCESS_DISABLED',
    })
    await provider.setMobileAccess({ desktop, enabled: true })
    await expect(provider.reissueDesktopRelayAuthority(desktop)).resolves.toEqual({ enabled: true })
    expect(relay.rotateCredential).not.toHaveBeenCalled()

    const keyless = new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake: handshakeProvider(),
      authority: new MemoryPersonalPairingAuthorityStore(),
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    await keyless.setMobileAccess({ desktop, enabled: true })
    await expect(keyless.reissueDesktopRelayAuthority(desktop)).resolves.toEqual({ enabled: true })
  })

  it('revokes and disables keyless pairings without Relay grants', async () => {
    const handshake = handshakeProvider()
    handshake.activatePairing
      .mockResolvedValueOnce({ keyReference: 'key-keep' as never, activePairingKey: Uint8Array.of(11) })
      .mockResolvedValueOnce({ keyReference: 'key-revoke' as never, activePairingKey: Uint8Array.of(12) })
    const provider = uniquePairingProvider(handshake)
    const desktop = authentication('desktop-installation')
    const otherDesktop = authentication('other-desktop')
    await provider.setMobileAccess({ desktop, enabled: true })
    await provider.setMobileAccess({ desktop: otherDesktop, enabled: true })

    const keepChallenge = await provider.createChallenge({
      desktop: otherDesktop, rendezvousId: parsePairingRendezvousId('keyless-keep'),
      clientIp: '192.0.2.1',
    })
    const keepPending = await completeAs(provider, keepChallenge.oneTimeLink, 'keyless-keep', 'other-mobile', 'account-one')
    const keep = await provider.confirmPairing({ desktop: otherDesktop, pendingPairingId: keepPending.pendingPairingId })

    const revokeChallenge = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('keyless-revoke'),
      clientIp: '192.0.2.1',
    })
    const revokePending = await complete(provider, revokeChallenge.oneTimeLink, 'keyless-revoke')
    const revoked = await provider.confirmPairing({ desktop, pendingPairingId: revokePending.pendingPairingId })
    await provider.revokePersonalPairing({ desktop, pairingId: revoked.id })
    expect(await provider.listPersonalPairings(desktop)).toEqual([])

    const disableChallenge = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('keyless-disable'),
      clientIp: '192.0.2.1',
    })
    const disablePending = await completeAs(
      provider, disableChallenge.oneTimeLink, 'keyless-disable', 'mobile-disable', 'account-one',
    )
    handshake.activatePairing.mockResolvedValueOnce({
      keyReference: 'key-disable' as never, activePairingKey: Uint8Array.of(13),
    })
    await provider.confirmPairing({ desktop, pendingPairingId: disablePending.pendingPairingId })
    await provider.setMobileAccess({ desktop, enabled: false })

    expect(await provider.listPersonalPairings(desktop)).toEqual([])
    expect(await provider.listPersonalPairings(otherDesktop)).toEqual([keep])
  })

  it('rejects a conflicting keyless Mobile authority commit without a Relay grant', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const pendingPairingId = parsePendingPairingId('completion-keyless-commit')
    await authority.confirmMobilePairing({
      accountId: 'account-one' as never,
      desktopInstallationId: parseInstallationId('desktop-installation'),
      mobileInstallationId: parseInstallationId('mobile-installation'),
      pendingPairingId,
      pairingId: parsePersonalPairingId('pairing-precommitted'),
    })
    const provider = new PersonalPairingProvider(new Context(), {
      account: { currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)) },
      handshake: handshakeProvider(),
      authority,
      randomBytes: size => new Uint8Array(size),
      randomId: kind => kind === 'completion' ? pendingPairingId : `${kind}-keyless-commit`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    })
    const desktop = authentication('desktop-installation')
    await provider.setMobileAccess({ desktop, enabled: true })
    const challenge = await provider.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('keyless-commit'),
      clientIp: '192.0.2.1',
    })
    const pending = await complete(provider, challenge.oneTimeLink, 'keyless-commit')
    expect(pending.pendingPairingId).toBe(pendingPairingId)

    await expect(provider.confirmPairing({ desktop, pendingPairingId }))
      .rejects.toMatchObject({ code: 'PAIRING_ID_COLLISION' })
  })

  it('forgets a shared-authority challenge that another instance already settled', async () => {
    const authority = new MemoryPersonalPairingAuthorityStore()
    const handshake = handshakeProvider()
    let ids = 0
    const options = {
      account: {
        currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
      },
      handshake,
      authority,
      clock: { now: () => NOW },
      randomBytes: (size: number) => new Uint8Array(size),
      randomId: (kind: string) => `${kind}-forget-${String(++ids)}`,
      pairingLinkOrigin: 'https://platform.example.com/pair',
    } as const
    const creator = new PersonalPairingProvider(new Context(), options)
    const other = new PersonalPairingProvider(new Context(), {
      ...options,
      randomId: (kind: string) => `${kind}-other-${String(++ids)}`,
    })
    const desktop = authentication('desktop-installation')
    await creator.setMobileAccess({ desktop, enabled: true })
    await creator.createChallenge({
      desktop, rendezvousId: parsePairingRendezvousId('forget-local'), clientIp: '192.0.2.1',
    })
    await other.setMobileAccess({ desktop, enabled: false })
    await creator.dispose()
    expect(handshake.destroyChallenge).toHaveBeenCalledOnce()
  })
})

function account(id: string): PlatformAccountView {
  return { id: id as never, githubId: 1, githubLogin: id, avatarUrl: 'https://avatars.example/account' }
}

function accountService(view: PlatformAccountView) {
  return {
    currentInstallation: vi.fn().mockResolvedValue({
      account: view,
      installation: { id: parseInstallationId('desktop-installation'), kind: 'desktop', presentation: { name: 'Test Desktop', platform: 'linux' as const } },
    }),
  }
}

function authentication(
  installationId: string,
  accountId = 'account-one',
) {
  const proof: AccountProof = {
    jti: parseAccountProofJti(`${installationId}-proof`),
    issuedAt: NOW,
    signature: 'signature',
  }
  return {
    accessToken: `${accountId}:${installationId}-token`,
    proof,
  }
}

function handshakeProvider() {
  return {
    createChallenge: vi.fn().mockResolvedValue({
      desktopFingerprint: 'desktop-fingerprint',
      state: Uint8Array.of(1),
    }),
    completeChallenge: vi.fn().mockResolvedValue({
      handshakeHash: Uint8Array.from({ length: 32 }, (_, index) => index),
      desktopHandshake: Uint8Array.of(8),
      pendingPairingKey: Uint8Array.of(7),
    }),
    activatePairing: vi.fn().mockResolvedValue({
      keyReference: 'pairing-key-one',
      activePairingKey: Uint8Array.of(6),
    }),
    destroyChallenge: vi.fn(),
    destroyPendingPairing: vi.fn(),
    destroyPairing: vi.fn(),
  }
}

function pairingProvider(handshake: PairingHandshakeProvider, now = { value: NOW }) {
  return configuredProvider({
    handshake,
    clock: { now: () => now.value },
    randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
    randomId: kind => `${kind}-id`,
  })
}

function configuredProvider(
  config: Omit<Partial<PersonalPairingProviderOptions>, 'account' | 'pairingLinkOrigin'> = {},
) {
  return new PersonalPairingProvider(new Context(), {
    account: {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
    },
    handshake: handshakeProvider(),
    authority: new MemoryPersonalPairingAuthorityStore(),
    ownsAuthority: true,
    pairingLinkOrigin: 'https://platform.example.com/pair',
    ...config,
  })
}

function storedPairing(suffix: string): StoredPersonalPairing {
  return {
    id: parsePersonalPairingId(`pairing-${suffix}`),
    desktopInstallationId: parseInstallationId('desktop-installation'),
    devicePrincipal: {
      id: parseDevicePrincipalId(`principal-${suffix}`), accountId: 'account-one' as never,
      installationId: parseInstallationId(`mobile-${suffix}`), authority: 'companion-surface',
    },
    device: { name: `${suffix} phone`, platform: 'ios' },
    pairedAt: NOW, lastAccessAt: NOW, online: false,
  }
}

function endpointStoredPairing(suffix: string): EndpointStoredPersonalPairing {
  return {
    ...storedPairing(suffix),
    endpointPendingPairingId: parsePendingPairingId(`pending-${suffix}`),
    endpointRouteId: parseRelayRouteId(`route-${suffix}`),
    endpointDesktopCredentialDigest: new Uint8Array(32).fill(31),
    endpointCredentialDigest: new Uint8Array(32).fill(32),
  }
}

async function prepareEndpointPairing(
  provider: PersonalPairingProvider,
  desktop: ReturnType<typeof authentication>,
  mobile: ReturnType<typeof authentication>,
  suffix: string,
  stage: 'message1' | 'message3',
): Promise<{ pendingPairingId: ReturnType<typeof parsePendingPairingId>; completionId: ReturnType<typeof parsePairingCompletionId> }> {
  const challenge = await provider.createEndpointChallenge({
    desktop, rendezvousId: parsePairingRendezvousId(`rendezvous-${suffix}`),
    clientIp: `192.0.2.${String(suffix.length + 1)}`, expiresAt: NOW + 60_000,
  })
  const completionId = parsePairingCompletionId(`completion-${suffix}`)
  const pending = await provider.submitEndpointMessage1({
    mobile, challengeId: challenge.challengeId, completionId,
    message1: Uint8Array.of(1),
  })
  if (stage === 'message3') {
    await provider.submitEndpointMessage2({
      desktop, pendingPairingId: pending.pendingPairingId, message2: Uint8Array.of(2),
    })
    await provider.submitEndpointMessage3({ mobile, completionId, message3: Uint8Array.of(3) })
  }
  return { ...pending, completionId }
}

function createChallengeFor(
  provider: PersonalPairingProvider,
  desktop: ReturnType<typeof authentication>,
  rendezvousId: string,
  clientIp = '192.0.2.1',
) {
  return provider.createChallenge({
    desktop,
    rendezvousId: parsePairingRendezvousId(rendezvousId),
    clientIp,
  })
}

function relayStub(
  routeId: ReturnType<typeof parseRelayRouteId>,
  revision: number,
  revokeCredential: () => Promise<void> = async () => {},
) {
  return {
    rotateCredential: vi.fn(async () => ({
      routeId, endpoint: 'desktop' as const,
      credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), revision,
    })),
    issueCredential: vi.fn(async () => ({
      routeId, endpoint: 'mobile' as const,
      credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'), revision,
    })),
    revokeCredential: vi.fn(revokeCredential),
    registerCredentialDigest: vi.fn(async () => revision),
    registerPairingCredentialDigests: vi.fn(async () => revision),
    revokeCredentialDigest: vi.fn(async () => {}),
    revokeRoute: vi.fn(async () => {}),
  }
}

async function seedSharedPairing(suffix: string, sealedRelayAuthority?: Uint8Array) {
  const authority = new MemoryPersonalPairingAuthorityStore()
  const pendingPairingId = parsePendingPairingId(`pending-${suffix}`)
  await authority.confirmMobilePairing({
    accountId: 'account-one' as never,
    desktopInstallationId: parseInstallationId('desktop-installation'),
    mobileInstallationId: parseInstallationId('mobile-installation'),
    pendingPairingId,
    pairingId: parsePersonalPairingId(`pairing-${suffix}`),
    ...(sealedRelayAuthority === undefined ? {} : { sealedRelayAuthority }),
  })
  return { authority, pendingPairingId }
}

function complete(provider: PersonalPairingProvider, oneTimeLink: string, id: string) {
  return provider.completeChallenge({
    mobile: authentication('mobile-installation', 'account-one'),
    completionId: parsePairingCompletionId(`completion-${id}`),
    oneTimeLink,
    mobileHandshake: Uint8Array.of(9),
  })
}

function uniquePairingProvider(
  handshake: PairingHandshakeProvider,
  now = { value: NOW },
  schedule?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
) {
  let id = 0
  return new PersonalPairingProvider(new Context(), {
    account: {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
    },
    handshake,
    authority: new MemoryPersonalPairingAuthorityStore(),
    ownsAuthority: true,
    clock: { now: () => now.value },
    ...(schedule === undefined ? {} : { schedule }),
    randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index),
    randomId: kind => `${kind}-${String(++id)}`,
    pairingLinkOrigin: 'https://platform.example.com/pair',
  })
}

function collisionPairingProvider(
  handshake: PairingHandshakeProvider,
  pairingIds: string[],
  principalIds: string[],
) {
  let challenge = 0
  let pending = 0
  return new PersonalPairingProvider(new Context(), {
    account: {
      currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
    },
    handshake,
    authority: new MemoryPersonalPairingAuthorityStore(),
    ownsAuthority: true,
    clock: { now: () => NOW },
    randomBytes: size => new Uint8Array(size),
    randomId: (kind) => {
      if (kind === 'challenge') return `challenge-${String(++challenge)}`
      if (kind === 'completion') return `pending-${String(++pending)}`
      const values = kind === 'pairing' ? pairingIds : principalIds
      const value = values.shift()
      if (value === undefined) throw new Error(`Missing ${kind} test id`)
      return value
    },
    pairingLinkOrigin: 'https://platform.example.com/pair',
  })
}

function authenticated(accessToken: string) {
  const [accountId, installationToken] = accessToken.split(':') as [string, string]
  const installationId = installationToken.replace(/-token$/u, '')
  const mobilePresentation = installationId === 'mobile-ios'
    ? { name: 'Personal iOS installation', platform: 'ios' as const }
    : { name: 'Work Android installation', platform: 'android' as const }
  return {
    account: account(accountId),
    installation: installationId.includes('mobile') ? {
      id: parseInstallationId(installationId),
      kind: 'mobile' as const,
      presentation: mobilePresentation,
    } : {
      id: parseInstallationId(installationId),
      kind: 'desktop' as const,
      presentation: { name: 'Test Desktop', platform: 'linux' as const },
    },
  }
}

function completeAs(
  provider: PersonalPairingProvider,
  oneTimeLink: string,
  id: string,
  mobileInstallationId: string,
  accountId: string,
) {
  return provider.completeChallenge({
    mobile: authentication(mobileInstallationId, accountId),
    completionId: parsePairingCompletionId(`completion-${id}`),
    oneTimeLink,
    mobileHandshake: Uint8Array.of(9),
  })
}

function mutateLink(source: URL, mutate: (url: URL) => void): string {
  const copy = new URL(source)
  mutate(copy)
  return copy.toString()
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
