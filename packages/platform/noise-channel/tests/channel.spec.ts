import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  SnowMobileHandshakeClient,
  SnowMobileAttachmentOwner,
  SnowDesktopAttachmentOwner,
  SnowDesktopEndpointPairingOwner,
  SnowPairingHandshakeProvider,
  SnowCompanionProtocolChannel,
  initializeSnowChannel,
  acceptSnowDesktopReconnect,
  beginSnowMobileReconnect,
} from '../src/index.ts'

beforeAll(() => {
  initializeSnowChannel(readFileSync(new URL('../pkg/dsh_noise_channel_bg.wasm', import.meta.url)))
})

describe('Snow product Companion channel', () => {
  it('keeps XKpsk3 Desktop private state endpoint-owned across opaque mailbox messages', async () => {
    const desktop = new SnowDesktopEndpointPairingOwner()
    const invitation = await desktop.createInvitation(Date.now() + 60_000)
    const mobile = new SnowMobileHandshakeClient()
    const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
    const message2 = await desktop.acceptMessage1(message1)
    await mobile.acceptDesktopHandshake(message2)
    const recovery = mobile.exportRecoveryState()
    const restoredMobile = new SnowMobileHandshakeClient()
    restoredMobile.restoreRecoveryState(recovery)
    recovery.fill(0)
    const message3 = restoredMobile.exportFinishMessage()
    const desktopHash = await desktop.finishMessage3(message3)
    expect(desktopHash).toEqual(restoredMobile.exportAuthenticationHash())
    const grant = {
      endpoint: 'mobile' as const,
      routeId: parseRelayRouteId('route-endpoint'),
      credential: parseRelayCredential('A'.repeat(43)),
      revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-endpoint'),
    }
    const sealed = await desktop.sealMobileRelayAuthority(grant)
    expect(new TextDecoder().decode(sealed)).not.toContain(grant.credential)
    let writes = 0
    await expect(restoredMobile.openRelayAuthorityDurably(sealed, async () => {
      writes += 1
      throw new Error('IndexedDB commit failed')
    })).rejects.toThrow('IndexedDB commit failed')
    expect(restoredMobile.exportRecoveryState()).not.toHaveLength(0)
    await expect(restoredMobile.openRelayAuthorityDurably(sealed, async (opened, reconnectState) => {
      writes += 1
      expect(opened).toEqual(grant)
      expect(reconnectState).toHaveLength(96)
    })).resolves.toEqual(grant)
    expect(writes).toBe(2)
    expect(() => restoredMobile.exportRecoveryState()).toThrow('no prepared invitation')
    expect(desktop.exportReconnectState()).toHaveLength(96)
    expect(restoredMobile.exportReconnectState()).toHaveLength(96)
  })

  it('seals Mobile Relay authority in the completed XKpsk3 channel', async () => {
    const paired = await completePairing()
    const grant = {
      endpoint: 'mobile' as const,
      routeId: parseRelayRouteId('route-one'),
      credential: parseRelayCredential('A'.repeat(43)),
      revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-one'),
    }

    const sealed = await paired.desktop.sealMobileRelayAuthority({
      activePairingKey: paired.activePairingKey,
      grant,
    })

    expect(new TextDecoder().decode(sealed)).not.toContain(grant.credential)
    await expect(paired.mobile.openRelayAuthority(sealed)).resolves.toEqual(grant)
    expect(paired.desktop.exportReconnectState(paired.activePairingKey)).toHaveLength(96)
    expect(paired.mobile.exportReconnectState()).toHaveLength(96)
  })

  it('uses a fresh IK ephemeral and attachment-bound transcript for every physical Relay connection', async () => {
    const paired = await completePairingAndOpenGrant()
    const firstBinding = binding('desktop-one', 'mobile-one', 1)
    const firstMobile = await beginSnowMobileReconnect(paired.mobileState, firstBinding)
    const firstDesktop = await acceptSnowDesktopReconnect(paired.desktopState, firstBinding, firstMobile.message1)
    const firstMobileChannel = firstMobile.finish(firstDesktop.message2)
    const sync = new TextEncoder().encode(JSON.stringify({ type: 'desktop-resync', version: 1, generation: 1 }))
    const sealed = firstDesktop.channel.seal(sync)
    expect(firstMobileChannel.open(sealed)).toEqual(sync)

    const secondBinding = binding('desktop-two', 'mobile-two', 2)
    const secondMobile = await beginSnowMobileReconnect(paired.mobileState, secondBinding)
    expect(secondMobile.message1.slice(0, 32)).not.toEqual(firstMobile.message1.slice(0, 32))
    await expect(acceptSnowDesktopReconnect(paired.desktopState, secondBinding, firstMobile.message1))
      .rejects.toThrow()
    secondMobile.cancel()
    expect(() => { secondMobile.cancel() }).not.toThrow()
    expect(() => secondMobile.finish(Uint8Array.of())).toThrow('already settled')
  })

  it('rejects replay, ordering, cross-pairing, and stale attachment transcripts', async () => {
    const paired = await completePairingAndOpenGrant()
    const connected = await connect(paired.mobileState, paired.desktopState, binding('desktop-one', 'mobile-one', 1))
    const first = connected.mobile.seal(Uint8Array.of(1))
    expect(connected.desktop.open(first)).toEqual(Uint8Array.of(1))
    expect(() => connected.desktop.open(first)).toThrow()

    const ordered = await connect(paired.mobileState, paired.desktopState, binding('desktop-two', 'mobile-two', 2))
    const earlier = ordered.mobile.seal(Uint8Array.of(2))
    const later = ordered.mobile.seal(Uint8Array.of(3))
    expect(() => ordered.desktop.open(later)).toThrow()
    expect(ordered.desktop.open(earlier)).toEqual(Uint8Array.of(2))

    const other = await completePairingAndOpenGrant()
    const wrongMobile = await beginSnowMobileReconnect(other.mobileState, binding('desktop-three', 'mobile-three', 3))
    await expect(acceptSnowDesktopReconnect(paired.desktopState, binding('desktop-three', 'mobile-three', 3), wrongMobile.message1))
      .rejects.toThrow()
    wrongMobile.cancel()

    const wrongRoute = await beginSnowMobileReconnect(paired.mobileState, {
      ...binding('desktop-four', 'mobile-four', 4), routeId: parseRelayRouteId('route-other'),
    })
    await expect(acceptSnowDesktopReconnect(
      paired.desktopState,
      binding('desktop-four', 'mobile-four', 4),
      wrongRoute.message1,
    )).rejects.toThrow()
    wrongRoute.cancel()

    const wrongSelector = await beginSnowMobileReconnect(paired.mobileState, {
      ...binding('desktop-five', 'mobile-five', 5),
      pairingSelector: parseRelayPairingSelector('pairing-other'),
    })
    await expect(acceptSnowDesktopReconnect(
      paired.desktopState,
      binding('desktop-five', 'mobile-five', 5),
      wrongSelector.message1,
    )).rejects.toThrow()
    wrongSelector.cancel()
  })

  it('admits foreground synchronization only as a versioned authenticated Companion message', async () => {
    const paired = await completePairingAndOpenGrant()
    const connected = await connect(paired.mobileState, paired.desktopState, binding('desktop-sync', 'mobile-sync', 4))
    const desktop = new SnowCompanionProtocolChannel(connected.desktop)
    const mobile = new SnowCompanionProtocolChannel(connected.mobile)
    const sync = {
      type: 'projection' as const,
      projection: { type: 'foreground-sync' as const, generation: 4, desktopRevision: 19 },
    }

    expect(mobile.open(desktop.seal(sync))).toEqual(sync)
    const oneByte = connected.desktop.seal(Uint8Array.of(1))
    expect(() => mobile.open(oneByte)).toThrow()
  })

  it('assembles endpoint-owned IK over route-bound Relay ready metadata', async () => {
    const paired = await completePairingAndOpenGrant()
    const routeId = parseRelayRouteId('route-owner')
    const pairingSelector = parseRelayPairingSelector('pairing-owner')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-owner')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-owner')
    const mobile = new SnowMobileAttachmentOwner(paired.mobileState, pairingSelector)
    paired.mobileState.fill(0)
    const desktop = new SnowDesktopAttachmentOwner(selector => selector === pairingSelector
      ? paired.desktopState
      : undefined)
    const begun = await mobile.begin({
      type: 'ready', transportVersion: 1, routeId, attachmentId: mobileAttachmentId,
      peers: [{ attachmentId: desktopAttachmentId, pairingSelector, generation: 9 }],
    })
    const accepted = await desktop.accept(begun.payload, mobileAttachmentId, routeId, desktopAttachmentId)
    const mobileChannel = mobile.finish(accepted.payload, desktopAttachmentId)
    const synchronization = {
      type: 'projection' as const,
      projection: { type: 'foreground-sync' as const, generation: 9, desktopRevision: 4 },
    }
    expect(mobileChannel.open(accepted.channel.seal(synchronization))).toEqual(synchronization)
    expect(() => mobile.finish(accepted.payload, desktopAttachmentId)).toThrow('no pending attempt')
    await expect(desktop.accept(
      begun.payload,
      parseRelayAttachmentId('mobile-forged'),
      routeId,
      desktopAttachmentId,
    )).rejects.toThrow('does not belong')
    mobile.dispose()
    await expect(mobile.begin({
      type: 'ready', transportVersion: 1, routeId, attachmentId: mobileAttachmentId,
      peers: [{ attachmentId: desktopAttachmentId, pairingSelector, generation: 10 }],
    })).rejects.toThrow('disposed')
  })
})

async function completePairing() {
  const invitationSecret = crypto.getRandomValues(new Uint8Array(32))
  const desktop = new SnowPairingHandshakeProvider()
  const challenge = await desktop.createChallenge({ invitationSecret, expiresAt: Date.now() + 60_000 })
  const mobile = new SnowMobileHandshakeClient()
  const link = new URL('https://www.gestaltrun.com/pair')
  link.searchParams.set('challenge', 'challenge-one')
  link.searchParams.set('secret', Buffer.from(invitationSecret).toString('base64url'))
  link.searchParams.set('fingerprint', challenge.desktopFingerprint)
  link.searchParams.set('spk', Buffer.from(challenge.desktopStaticPublicKey).toString('base64url'))
  link.searchParams.set('rendezvous', 'rendezvous-one')
  link.searchParams.set('expires', String(Date.now() + 60_000))
  link.searchParams.set('protocol', '1')
  const begun = await mobile.begin(link.toString())
  const opened = await desktop.completeChallenge({
    invitationSecret,
    challengeState: challenge.state,
    mobileHandshake: begun.mobileHandshake,
  })
  await mobile.acceptDesktopHandshake(opened.desktopHandshake)
  const finished = await desktop.finishChallenge({
    pendingPairingKey: opened.pendingPairingKey,
    mobileFinish: mobile.exportFinishMessage(),
  })
  const activated = await desktop.activatePairing({ pendingPairingKey: finished.pendingPairingKey })
  return { desktop, mobile, activePairingKey: activated.activePairingKey }
}

async function completePairingAndOpenGrant() {
  const paired = await completePairing()
  const sealed = await paired.desktop.sealMobileRelayAuthority({
    activePairingKey: paired.activePairingKey,
    grant: {
      endpoint: 'mobile', routeId: parseRelayRouteId('route-one'),
      credential: parseRelayCredential('A'.repeat(43)), revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-one'),
    },
  })
  await paired.mobile.openRelayAuthority(sealed)
  return {
    mobileState: paired.mobile.exportReconnectState(),
    desktopState: paired.desktop.exportReconnectState(paired.activePairingKey),
  }
}

function binding(desktopAttachmentId: string, mobileAttachmentId: string, generation: number) {
  return {
    routeId: parseRelayRouteId('route-one'),
    pairingSelector: parseRelayPairingSelector('pairing-one'),
    desktopAttachmentId: parseRelayAttachmentId(desktopAttachmentId),
    mobileAttachmentId: parseRelayAttachmentId(mobileAttachmentId),
    generation,
  }
}

async function connect(
  mobileState: Uint8Array,
  desktopState: Uint8Array,
  channelBinding: ReturnType<typeof binding>,
) {
  const mobile = await beginSnowMobileReconnect(mobileState, channelBinding)
  const desktop = await acceptSnowDesktopReconnect(desktopState, channelBinding, mobile.message1)
  return { mobile: mobile.finish(desktop.message2), desktop: desktop.channel }
}
