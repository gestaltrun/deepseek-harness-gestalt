import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { parseAccountProofJti, parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { AccountProof } from '@deepseek-ai/dsh-platform-account'
import {
  deriveRelayCredentialPublicKey,
  parseRelayAttachmentId,
  parseRelayAttachChallengeId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
  signRelayAttachmentChallenge,
  type RelayAttachMessage,
  type RelayCredential,
  type RelayCiphertextMessage,
  type RelayPeerUpdateMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  MemoryPersonalPairingAuthorityStore,
  MemoryProjectPeerGrantStore,
  PersonalPairingProvider,
  parseProjectPeerGrantId as parseGrantId,
  parseProjectPeerProjectId,
  parseRelayInstanceId,
  type PersonalPairingProviderOptions,
  type ProjectPeerGrantStore,
  type ProjectPeerMembershipAuthority,
  type ProjectPeerGrantSealer,
} from '../src/index.ts'
import { RemoteRelayProvider } from '../src/relay-provider.ts'
import {
  RELAY_TEST_CONFIG,
  SharedCoordinator,
  SharedRouteStore,
  ciphertext,
  rotateCredential,
  uniqueRandomBytes,
} from './relay-test-companions.ts'

const NOW = Date.parse('2026-08-18T10:00:00.000Z')
const PROJECT = parseProjectPeerProjectId('project-one')
const PEER = parsePlatformAccountId('account-two')
const ROUTE = parseRelayRouteId('route-peer-grant')
const PEER_INSTALLATION = parseInstallationId('peer-installation')

describe('PersonalPairingProvider project peer grants', () => {
  it('fails the grant surface closed when the composition is absent', async () => {
    const provider = bareProvider()
    await expect(provider.grantProjectPeer(grantInput('desktop-installation')))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_UNAVAILABLE' })
    await expect(provider.listProjectPeerGrants({ desktop: authentication('desktop-installation') }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_UNAVAILABLE' })
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_UNAVAILABLE' })
    await expect(provider.revokeProjectPeerGrant(grantInput('desktop-installation')))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_UNAVAILABLE' })
    const grants = {
      membership: membership(), sealer: sealing(), store: new MemoryProjectPeerGrantStore(),
    }
    expect(() => new PersonalPairingProvider(new Context(), {
      ...providerOptions(grants),
    })).toThrow('Project peer grants require a Remote Relay composition')
    expect(() => new PersonalPairingProvider(new Context(), {
      ...providerOptions(grants),
      relay: {
        revokeRoute: vi.fn(async () => {}),
        registerPairingCredentialDigests: vi.fn(async () => 1),
        revokeCredentialDigest: vi.fn(async () => {}),
      },
    })).toThrow('Project peer grants require a Remote Relay composition')
    expect(() => new PersonalPairingProvider(new Context(), {
      ...providerOptions(grants),
      relay: {
        revokeRoute: vi.fn(async () => {}),
        registerCredentialDigest: vi.fn(async () => 1),
      },
    })).toThrow('Project peer grants require a Remote Relay composition')
  })

  it('issues, seals, and delivers both directions between the grantor route and the granted peer', async () => {
    const assembly = await assembledPlatform()
    const { provider, relay, store, coordinator, grantorRoute } = assembly
    const grantorFrames: RelayCiphertextMessage[] = []
    const peerFrames: RelayCiphertextMessage[] = []
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    const grantor = await relay.attach({
      message: await attachProof(grantorRoute.credential, ROUTE, 'grantor-live', 'desktop'),
      deliver: collect(grantorFrames),
    })
    const granted = await provider.grantProjectPeer(grantInput('desktop-installation'))
    expect(granted).toMatchObject({
      projectId: PROJECT, routeId: ROUTE, peerAccountId: PEER,
      peerInstallationId: PEER_INSTALLATION, revision: grantorRoute.revision,
    })

    const sealed = await provider.getProjectPeerGrant({
      peer: peerAuthentication(), projectId: PROJECT,
    })
    expect(sealed.credentialFingerprint.length).toBeGreaterThan(0)
    const envelope = openEnvelope(sealed.sealedCredential)
    expect(envelope.peerInstallationId).toBe('peer-installation')
    expect(envelope.grant).toMatchObject({
      routeId: ROUTE, endpoint: 'mobile', revision: grantorRoute.revision,
      pairingSelector: sealed.grantId,
    })
    const record = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(record?.credentialDigest.every(byte => byte === 0)).toBe(false)
    expect(openEnvelope(record?.sealedCredential ?? new Uint8Array()).grant.credential)
      .toBe(envelope.grant.credential)

    const peer = await relay.attach({
      message: await attachProof(envelope.grant.credential, ROUTE, 'peer-live', envelope.grant.endpoint),
      deliver: collect(peerFrames),
    })
    expect(await coordinator.list(ROUTE)).toContainEqual(expect.objectContaining({
      attachmentId: parseRelayAttachmentId('peer-live'),
      endpoint: 'mobile',
      pairingSelector: sealed.grantId,
    }))

    const outbound = Uint8Array.of(1, 4, 9)
    await peer.receive(ciphertext(ROUTE, 'peer-live', 'grantor-live', outbound))
    expect(grantorFrames).toEqual([expect.objectContaining({ ciphertext: outbound })])
    const inbound = Uint8Array.of(2, 7)
    await grantor.receive(ciphertext(ROUTE, 'grantor-live', 'peer-live', inbound))
    expect(peerFrames).toEqual([expect.objectContaining({ ciphertext: inbound })])

    await Promise.all([grantor.close(), peer.close(), relay.dispose()])
  })

  it('rejects grants and retrieval for accounts without an active membership', async () => {
    const membershipAuthority = membership()
    const { provider } = await assembledPlatform({ membership: membershipAuthority })
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })

    await expect(provider.grantProjectPeer({
      ...grantInput('desktop-installation'), peerAccountId: parsePlatformAccountId('account-three'),
    })).rejects.toMatchObject({ code: 'PROJECT_PEER_MEMBERSHIP_REQUIRED' })
    expect(membershipAuthority.roster).toHaveBeenCalledWith(accountOne(), PROJECT)

    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.getProjectPeerGrant({
      peer: authentication('outsider-installation', 'account-three'), projectId: PROJECT,
    })).rejects.toMatchObject({ code: 'PROJECT_PEER_MEMBERSHIP_REQUIRED' })
    await expect(provider.grantProjectPeer({
      ...grantInput('desktop-installation'), desktop: authentication('desktop-three', 'account-three'),
    })).rejects.toMatchObject({ code: 'PROJECT_PEER_MEMBERSHIP_REQUIRED' })
  })

  it('refuses to grant before the Desktop route exists', async () => {
    const { provider } = await assembledPlatform()
    await expect(provider.grantProjectPeer(grantInput('desktop-installation')))
      .rejects.toMatchObject({ code: 'MOBILE_ACCESS_DISABLED' })
  })

  it('rejects an already allocated grant id instead of reusing it', async () => {
    const store = new MemoryProjectPeerGrantStore()
    const provider = new PersonalPairingProvider(new Context(), providerOptions({
      membership: membership(),
      sealer: sealing(),
      store,
      relay: relayStub(),
      randomId: kind => kind === 'project-peer-grant' ? 'grant-collision' : `${kind}-collision`,
    }))
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.grantProjectPeer(grantInput('desktop-installation')))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_ID_COLLISION' })
    expect(await store.listProjectPeerGrantRecords({})).toHaveLength(1)
  })

  it('tombstones and revokes outstanding grants when the peer loses membership', async () => {
    const membershipAuthority = membership()
    const { provider, relay, store } = await assembledPlatform({ membership: membershipAuthority })
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    const granted = await provider.grantProjectPeer(grantInput('desktop-installation'))
    const envelope = openEnvelope(
      (await provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
        .sealedCredential,
    )
    expect(granted.grantId.length).toBeGreaterThan(0)

    membershipAuthority.remove(PEER)
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_MEMBERSHIP_REQUIRED' })
    const tombstone = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(tombstone?.revokedAt).toBeDefined()
    await expect(provider.listProjectPeerGrants({
      desktop: authentication('desktop-installation'), projectId: PROJECT,
    })).resolves.toEqual([])
    await expect(relay.attach({
      message: await attachProof(envelope.grant.credential, ROUTE, 'peer-revoked', envelope.grant.endpoint),
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await relay.dispose()
  })

  it('tombstones grants whose grantor lost membership', async () => {
    const membershipAuthority = membership()
    const { provider, store } = await assembledPlatform({ membership: membershipAuthority })
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))

    membershipAuthority.remove(accountOne())
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_GRANT_INVALID' })
    const tombstone = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(tombstone?.revokedAt).toBeDefined()
  })

  it('rotates a grant so the superseded credential cannot attach again', async () => {
    const { provider, relay } = await assembledPlatform()
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    const first = openEnvelope(
      (await provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
        .sealedCredential,
    )
    const firstAttachment = await relay.attach({
      message: await attachProof(first.grant.credential, ROUTE, 'peer-first', 'mobile'),
      deliver: async () => {},
    })
    await firstAttachment.close()

    await provider.grantProjectPeer(grantInput('desktop-installation'))
    const second = openEnvelope(
      (await provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
        .sealedCredential,
    )
    expect(second.grant.credential).not.toBe(first.grant.credential)
    expect(second.grant.pairingSelector).not.toBe(first.grant.pairingSelector)
    await expect(relay.attach({
      message: await attachProof(first.grant.credential, ROUTE, 'peer-rotated-out', 'mobile'),
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    const replacement = await relay.attach({
      message: await attachProof(second.grant.credential, ROUTE, 'peer-replacement', 'mobile'),
      deliver: async () => {},
    })
    await expect(replacement.close()).resolves.toBeUndefined()
    await relay.dispose()
  })

  it('revokes explicitly, answers repeated revocation idempotently, and answers only to the carrying Desktop', async () => {
    const { provider, store } = await assembledPlatform()
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.revokeProjectPeerGrant({
      ...grantInput('desktop-installation'), desktop: authentication('other-desktop-installation'),
    })).rejects.toMatchObject({ code: 'PROJECT_PEER_GRANT_INVALID' })
    await provider.revokeProjectPeerGrant(grantInput('desktop-installation'))
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_GRANT_INVALID' })
    await expect(provider.revokeProjectPeerGrant(grantInput('desktop-installation'))).resolves.toBeUndefined()

    await provider.grantProjectPeer(grantInput('desktop-installation'))
    const record = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(record?.revokedAt).toBeUndefined()
    expect(record?.supersededCredentialDigest).toBeUndefined()
  })

  it('compensates a failed sealing by revoking the registered digest', async () => {
    const sealer = sealing()
    sealer.seal.mockRejectedValueOnce(new Error('sealing unavailable'))
    const relay = relayStub()
    const store = new MemoryProjectPeerGrantStore()
    const provider = new PersonalPairingProvider(new Context(), providerOptions({
      membership: membership(), sealer, store, relay,
      randomId: kind => `${kind}-compensation`,
    }))
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await expect(provider.grantProjectPeer(grantInput('desktop-installation'))).rejects.toThrow('sealing unavailable')
    expect(relay.revokeCredentialDigest).toHaveBeenCalledOnce()
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_GRANT_INVALID' })

    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .resolves.toBeDefined()
  })

  it('tombstones grants whose carrying route is gone and lists across projects', async () => {
    const { provider, store } = await assembledPlatform()
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    expect(await provider.listProjectPeerGrants({ desktop: authentication('desktop-installation') }))
      .toHaveLength(1)

    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: false })
    await expect(provider.getProjectPeerGrant({ peer: peerAuthentication(), projectId: PROJECT }))
      .rejects.toMatchObject({ code: 'PROJECT_PEER_GRANT_INVALID' })
    const tombstone = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(tombstone?.revokedAt).toBeDefined()
  })

  it('revokes both digests when an interrupted rotation is tombstoned explicitly', async () => {
    const relay = relayStub()
    let revokeCalls = 0
    relay.revokeCredentialDigest.mockImplementation(async () => {
      revokeCalls += 1
      if (revokeCalls === 1) throw new Error('revocation unavailable')
    })
    const store = new MemoryProjectPeerGrantStore()
    let grantedIds = 0
    const provider = new PersonalPairingProvider(new Context(), providerOptions({
      membership: membership(), sealer: sealing(), store, relay,
      randomId: kind => kind === 'project-peer-grant'
        ? `grant-interrupted-${String(++grantedIds)}`
        : `${kind}-interrupted`,
    }))
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.grantProjectPeer(grantInput('desktop-installation'))).rejects.toThrow('revocation unavailable')

    await provider.revokeProjectPeerGrant(grantInput('desktop-installation'))
    const tombstone = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(tombstone?.revokedAt).toBeDefined()
    expect(tombstone?.supersededCredentialDigest).toBeUndefined()
    expect(revokeCalls).toBe(3)
  })

  it('orders memory-store records by issuance and rejects empty identifiers', async () => {
    const store = new MemoryProjectPeerGrantStore()
    const base = {
      routeId: ROUTE,
      grantorAccountId: accountOne(),
      grantorInstallationId: parseInstallationId('desktop-installation'),
      peerAccountId: PEER,
      peerInstallationId: PEER_INSTALLATION,
      pairingSelector: parseRelayPairingSelector('selector-order'),
      credentialDigest: new Uint8Array(32).fill(1),
      sealedCredential: new Uint8Array(4),
      revision: 1,
    }
    await store.putProjectPeerGrant({
      ...base, projectId: PROJECT, peerInstallationId: parseInstallationId('peer-two'),
      grantId: parseGrantId('grant-second'), grantedAt: NOW + 2,
    })
    await store.putProjectPeerGrant({
      ...base, projectId: parseProjectPeerProjectId('project-two'), peerInstallationId: parseInstallationId('peer-three'),
      grantId: parseGrantId('grant-other'), grantedAt: NOW + 1,
    })
    await store.putProjectPeerGrant({
      ...base, projectId: PROJECT, grantId: parseGrantId('grant-first'), grantedAt: NOW + 1,
    })
    await store.putProjectPeerGrant({
      ...base, projectId: PROJECT, peerInstallationId: parseInstallationId('peer-four'),
      grantId: parseGrantId('grant-alfa'), grantedAt: NOW + 3,
    })
    await store.putProjectPeerGrant({
      ...base, projectId: PROJECT, peerInstallationId: parseInstallationId('peer-five'),
      grantId: parseGrantId('grant-zeta'), grantedAt: NOW + 3,
    })
    expect((await store.listProjectPeerGrantRecords({})).map(record => record.grantId)).toEqual([
      parseGrantId('grant-first'), parseGrantId('grant-other'), parseGrantId('grant-second'),
      parseGrantId('grant-alfa'), parseGrantId('grant-zeta'),
    ])
    expect((await store.listProjectPeerGrantRecords({ projectId: PROJECT })).map(record => record.grantId)).toEqual([
      parseGrantId('grant-first'), parseGrantId('grant-second'),
      parseGrantId('grant-alfa'), parseGrantId('grant-zeta'),
    ])
    expect(() => parseProjectPeerProjectId('   ')).toThrow('must be non-empty')
    expect(() => parseGrantId('')).toThrow('must be non-empty')
  })

  it('repairs an interrupted rotation on the next grant operation', async () => {    const relay = relayStub()
    let revokeCalls = 0
    relay.revokeCredentialDigest.mockImplementation(async () => {
      revokeCalls += 1
      if (revokeCalls === 1) throw new Error('revocation unavailable')
    })
    const store = new MemoryProjectPeerGrantStore()
    let grantedIds = 0
    const provider = new PersonalPairingProvider(new Context(), providerOptions({
      membership: membership(), sealer: sealing(), store, relay,
      randomId: kind => kind === 'project-peer-grant'
        ? `grant-interrupted-${String(++grantedIds)}`
        : `${kind}-interrupted`,
    }))
    await provider.setMobileAccess({ desktop: authentication('desktop-installation'), enabled: true })
    await provider.grantProjectPeer(grantInput('desktop-installation'))
    await expect(provider.grantProjectPeer(grantInput('desktop-installation'))).rejects.toThrow('revocation unavailable')
    const interrupted = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(interrupted?.supersededCredentialDigest).toBeDefined()

    await provider.grantProjectPeer(grantInput('desktop-installation'))
    const repaired = await store.getProjectPeerGrant({
      projectId: PROJECT, peerAccountId: PEER, peerInstallationId: PEER_INSTALLATION,
    })
    expect(repaired?.supersededCredentialDigest).toBeUndefined()
    expect(repaired?.revokedAt).toBeUndefined()
  })
})

const collect = (sink: RelayCiphertextMessage[]) =>
  async (message: RelayCiphertextMessage | RelayPeerUpdateMessage): Promise<void> => {
    if (message.type === 'ciphertext') sink.push(message)
  }

function accountOne() {
  return parsePlatformAccountId('account-one')
}

/** Mutable roster state backing the membership proof double. */
function membership() {
  const members = new Map<string, Set<string>>([['project-one', new Set(['account-one', 'account-two'])]])
  return {
    roster: vi.fn(async (accountId: string, projectId: string) => {
      const pool = members.get(projectId)
      if (pool === undefined || !pool.has(accountId)) throw new Error('NOT_A_MEMBER')
      return { members: [...pool].map(member => ({ accountId: parsePlatformAccountId(member) })) }
    }),
    remove: (accountId: ReturnType<typeof parsePlatformAccountId>): void => {
      members.get('project-one')?.delete(accountId)
    },
  }
}

/** Deterministic sealing double: the envelope is JSON bytes the test can open. */
function sealing(): ProjectPeerGrantSealer & { seal: ReturnType<typeof vi.fn> } {
  return {
    seal: vi.fn(async (input: unknown) => new TextEncoder().encode(JSON.stringify(input))),
  }
}

interface OpenedEnvelope {
  projectId: string
  peerAccountId: string
  peerInstallationId: string
  grant: {
    routeId: string
    endpoint: 'mobile'
    credential: RelayCredential
    revision: number
    pairingSelector: string
  }
}

function openEnvelope(sealed: Uint8Array): OpenedEnvelope {
  return JSON.parse(new TextDecoder().decode(sealed)) as OpenedEnvelope
}

function relayStub() {
  return {
    revokeRoute: vi.fn(async () => {}),
    activateCredentialDigest: vi.fn(async () => 1),
    registerCredentialDigest: vi.fn(async () => 1),
    registerPairingCredentialDigests: vi.fn(async () => 1),
    revokeCredentialDigest: vi.fn(async () => {}),
  }
}

type TestRelayStub = ReturnType<typeof relayStub>

function grantInput(installationId: string) {
  return {
    desktop: authentication(installationId),
    projectId: PROJECT,
    peerAccountId: PEER,
    peerInstallationId: PEER_INSTALLATION,
  }
}

function peerAuthentication() {
  return authentication('peer-installation', 'account-two')
}

function providerOptions(config: {
  membership: ProjectPeerMembershipAuthority
  sealer: ProjectPeerGrantSealer
  store: ProjectPeerGrantStore
  relay?: TestRelayStub
  randomId?: (kind: string) => string
  clock?: { now(): number }
}): PersonalPairingProviderOptions {
  const relay = config.relay
  return {
    account: accountService(),
    handshake: handshakeProvider(),
    authority: new MemoryPersonalPairingAuthorityStore(),
    ownsAuthority: true,
    pairingLinkOrigin: 'https://platform.example.com/pair',
    ...(relay === undefined ? {} : { relay }),
    projectPeerGrants: {
      store: config.store,
      membership: config.membership,
      sealer: config.sealer,
    },
    clock: config.clock ?? { now: () => NOW },
    ...(config.randomId === undefined ? {} : { randomId: config.randomId }),
  }
}

function bareProvider(): PersonalPairingProvider {
  return new PersonalPairingProvider(new Context(), {
    account: accountService(),
    handshake: handshakeProvider(),
    authority: new MemoryPersonalPairingAuthorityStore(),
    ownsAuthority: true,
    pairingLinkOrigin: 'https://platform.example.com/pair',
  })
}

/** Assemble one provider with a real Relay provider, deterministic route, and store handles. */
async function assembledPlatform(config: { membership?: ProjectPeerMembershipAuthority } = {}) {
  const membershipAuthority = config.membership ?? membership()
  const sealer = sealing()
  const store = new MemoryProjectPeerGrantStore()
  const routeStore = new SharedRouteStore()
  const coordinator = new SharedCoordinator()
  const relay = new RemoteRelayProvider(new Context(), {
    instanceId: parseRelayInstanceId('platform-project-peer'),
    routeStore,
    coordinator,
    config: RELAY_TEST_CONFIG,
    randomBytes: uniqueRandomBytes(61),
  })
  const grantorRoute = await rotateCredential(relay, ROUTE, 'desktop')
  let assembledIds = 0
  const options = providerOptions({
    membership: membershipAuthority,
    sealer,
    store,
    randomId: kind => kind === 'relay-route'
      ? 'route-peer-grant'
      : `${kind}-assembled-${String(++assembledIds)}`,
  })
  options.relay = relay
  const provider = new PersonalPairingProvider(new Context(), options)
  return { provider, relay, store, coordinator, membership: membershipAuthority, grantorRoute }
}

/** Build one fully signed attachment proof from a canonical credential. */
async function attachProof(
  credential: RelayCredential,
  routeId: ReturnType<typeof parseRelayRouteId>,
  attachmentId: string,
  endpoint: 'mobile' | 'desktop',
): Promise<RelayAttachMessage> {
  const validated = parseRelayCredential(credential)
  const credentialPublicKey = await deriveRelayCredentialPublicKey(validated)
  return await signRelayAttachmentChallenge(validated, {
    type: 'attach-challenge-response', transportVersion: 1, routeId,
    attachmentId: parseRelayAttachmentId(attachmentId), endpoint, credentialPublicKey,
    challengeId: parseRelayAttachChallengeId(`challenge-${attachmentId}`),
    nonce: new Uint8Array(32).fill(6), expiresAt: Number.MAX_SAFE_INTEGER,
  })
}

function accountService() {
  return {
    currentInstallation: vi.fn(async ({ accessToken }: { accessToken: string }) => authenticated(accessToken)),
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

function authenticated(accessToken: string) {
  const [accountId, installationToken] = accessToken.split(':') as [string, string]
  const installationId = installationToken.replace(/-token$/u, '')
  return {
    account: {
      id: parsePlatformAccountId(accountId), githubId: 1, githubLogin: accountId,
      avatarUrl: 'https://avatars.example/account',
    },
    installation: installationId.includes('mobile')
      ? {
        id: parseInstallationId(installationId), kind: 'mobile' as const,
        presentation: { name: 'Phone', platform: 'ios' as const },
      }
      : {
        id: parseInstallationId(installationId), kind: 'desktop' as const,
        presentation: { name: 'Desktop', platform: 'linux' as const },
      },
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
