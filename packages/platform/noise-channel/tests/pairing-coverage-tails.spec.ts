import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  acceptSnowDesktopReconnect,
  beginSnowMobileReconnect,
  SnowDesktopEndpointPairingOwner,
  SnowDesktopAttachmentOwner,
  SnowMobileAttachmentOwner,
  SnowMobileHandshakeClient,
  SnowPairingHandshakeProvider,
  decodeSnowEndpointInvitation,
  initializeSnowChannel,
} from '../src/index.ts'
import {
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'

beforeAll(() => {
  initializeSnowChannel(readFileSync(new URL('../pkg/dsh_noise_channel_bg.wasm', import.meta.url)))
})

describe('Snow pairing hostile persisted and wire state', () => {
  it('rejects malformed endpoint invitations before allocating Mobile keys', () => {
    const future = Date.now() + 60_000
    const valid = {
      version: 1, expiresAt: future,
      desktopPublic: new Array<number>(32).fill(1),
      psk: new Array<number>(32).fill(2),
    }
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    for (const [value, message] of [
      [null, 'must be an object'],
      [[], 'must be an object'],
      [{ ...valid, extra: true }, 'unsupported fields'],
      [{ ...valid, version: 2 }, 'version is unsupported'],
      [{ ...valid, expiresAt: 1 }, 'invitation expired'],
      [{ ...valid, desktopPublic: [1] }, 'Desktop public key must contain 32 bytes'],
      [{ ...valid, psk: new Array<number>(32).fill(300) }, 'invitation PSK must contain 32 bytes'],
    ] as const) {
      expect(() => decodeSnowEndpointInvitation(encode(value))).toThrow(message)
    }
  })

  it('rejects incomplete Desktop recovery records', () => {
    const bytes = () => new Uint8Array(32).fill(1)
    const valid = {
      desktopPrivate: bytes(), desktopPublic: bytes(), ephemeralPrivate: bytes(), psk: bytes(),
    }
    expect(SnowDesktopEndpointPairingOwner.restore(valid).exportRecoveryState()).toEqual(valid)
    expect(() => SnowDesktopEndpointPairingOwner.restore({
      ...valid, desktopPrivate: Uint8Array.of(1),
    })).toThrow('desktopPrivate must contain 32 bytes')
    expect(() => SnowDesktopEndpointPairingOwner.restore({
      ...valid, message1: Uint8Array.of(1),
    })).toThrow('messages 1 and 2 must settle together')
    expect(() => SnowDesktopEndpointPairingOwner.restore({
      ...valid, message1: Uint8Array.of(1), message2: Uint8Array.of(2), message3: Uint8Array.of(3),
    })).toThrow('message 3 is incomplete')
    expect(() => SnowDesktopEndpointPairingOwner.restore({
      ...valid, message1: Uint8Array.of(1), message2: Uint8Array.of(2), message3: Uint8Array.of(3),
      mobilePublic: bytes(),
    })).toThrow('message 3 is incomplete')
    expect(() => SnowDesktopEndpointPairingOwner.restore({
      ...valid, reconnectState: Uint8Array.of(1),
    })).toThrow('reconnect state is invalid')
    const complete = {
      ...valid,
      message1: Uint8Array.of(1),
      message2: Uint8Array.of(2),
      message3: Uint8Array.of(3),
      mobilePublic: bytes(),
      handshakeHash: bytes(),
      reconnectState: new Uint8Array(96).fill(2),
    }
    expect(SnowDesktopEndpointPairingOwner.restore(complete).exportRecoveryState()).toEqual(complete)
  })

  it('rejects Desktop ordering and replay before sealing', async () => {
    const desktop = new SnowDesktopEndpointPairingOwner()
    await expect(desktop.createInvitation(Date.now())).rejects.toThrow('expiry must be in the future')
    await expect(desktop.acceptMessage1(Uint8Array.of(1))).rejects.toThrow('no invitation state')
    const invitation = await desktop.createInvitation(Date.now() + 60_000)
    expect(() => desktop.exportReconnectState()).toThrow('unavailable before grant sealing')
    await expect(desktop.finishMessage3(Uint8Array.of(1))).rejects.toThrow('message 1 is not complete')
    await expect(desktop.sealMobileRelayAuthority({} as never, new Uint8Array(32))).rejects.toThrow('has not finished message 3')

    const mobile = new SnowMobileHandshakeClient()
    expect(() => mobile.exportAttachmentKey()).toThrow('unavailable before Relay authority opening')
    const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
    const message2 = await desktop.acceptMessage1(message1)
    await expect(desktop.acceptMessage1(message1)).resolves.toEqual(message2)
    await expect(desktop.acceptMessage1(Uint8Array.of(9))).rejects.toThrow('message 1 replay is stale')
    await mobile.acceptDesktopHandshake(message2)
    const message3 = mobile.exportFinishMessage()
    const authenticationHash = await desktop.finishMessage3(message3)
    expect(desktop.exportRecoveryState().message3).toEqual(message3)
    expect(desktop.exportAuthenticationHash()).toHaveLength(32)
    await expect(desktop.finishMessage3(message3)).resolves.toEqual(authenticationHash)
    await expect(desktop.finishMessage3(Uint8Array.of(9))).rejects.toThrow('message 3 replay is stale')
    Reflect.set(desktop, 'state', {
      ...Reflect.get(desktop, 'state') as object,
      handshakeHash: undefined,
    })
    await expect(desktop.finishMessage3(message3)).rejects.toThrow('message 3 replay is stale')
    desktop.wipe()
    expect(() => desktop.exportRecoveryState()).toThrow('no invitation state')
  })

  it('rejects Mobile reads before their owning handshake stage', async () => {
    const mobile = new SnowMobileHandshakeClient()
    expect(() => mobile.exportFinishMessage()).toThrow('no finish message')
    expect(() => mobile.exportAuthenticationHash()).toThrow('no authentication hash')
    expect(() => mobile.exportReconnectState()).toThrow('unavailable before Relay authority opening')

    const desktop = new SnowDesktopEndpointPairingOwner()
    const invitation = await desktop.createInvitation(Date.now() + 60_000)
    await mobile.beginEndpointInvitation(invitation.invitationPayload)
    await expect(mobile.openRelayAuthority(Uint8Array.of(1))).rejects.toThrow('has not finished XKpsk3')
    const preparedRecovery = mobile.exportRecoveryState()
    const restored = new SnowMobileHandshakeClient()
    restored.restoreRecoveryState(preparedRecovery)
    expect(restored.exportRecoveryState()).toEqual(preparedRecovery)

    Reflect.set(restored, 'mobilePublic', undefined)
    expect(() => restored.exportRecoveryState()).toThrow('no Mobile public key')
    const incomplete = new SnowMobileHandshakeClient()
    incomplete.restoreRecoveryState(preparedRecovery)
    Reflect.set(incomplete, 'message2', Uint8Array.of(1))
    expect(() => incomplete.exportRecoveryState()).toThrow('recovery transcript is incomplete')
  })

  it('rejects malformed legacy invitations and Mobile recovery records', async () => {
    const link = new URL('https://www.gestaltrun.com/pair')
    link.searchParams.set('challenge', 'challenge-one')
    link.searchParams.set('secret', Buffer.alloc(32, 1).toString('base64url'))
    link.searchParams.set('fingerprint', 'snow-test')
    link.searchParams.set('rendezvous', 'rendezvous-one')
    link.searchParams.set('expires', String(Date.now() + 60_000))
    link.searchParams.set('protocol', '1')
    await expect(new SnowMobileHandshakeClient().begin(link.toString()))
      .rejects.toThrow('no Desktop static public key')

    const client = new SnowMobileHandshakeClient()
    expect(() => { client.restoreRecoveryState(Uint8Array.of(6)) }).toThrow('prepared recovery state is invalid')
    const trailing = new Uint8Array(162)
    trailing[0] = 6
    expect(() => { client.restoreRecoveryState(trailing) }).toThrow('trailing bytes')
    const truncated = new Uint8Array(167)
    truncated[0] = 7
    truncated[161] = 1
    expect(() => { client.restoreRecoveryState(truncated) }).toThrow('finished recovery state is truncated')
  })

  it('rejects authenticated but malformed Relay authority payloads', async () => {
    const valid = {
      endpoint: 'mobile', routeId: parseRelayRouteId('route-hostile'),
      credential: parseRelayCredential('A'.repeat(43)), revision: 1,
      pairingSelector: parseRelayPairingSelector('pairing-hostile'),
    }
    for (const [grant, message] of [
      [null, 'must be an object'],
      [{ ...valid, extra: true }, 'unsupported fields'],
      [{ ...valid, endpoint: 'desktop' }, 'endpoint must be mobile'],
      [{ ...valid, revision: 0 }, 'revision must be positive'],
    ] as const) {
      const desktop = new SnowDesktopEndpointPairingOwner()
      const invitation = await desktop.createInvitation(Date.now() + 60_000)
      const mobile = new SnowMobileHandshakeClient()
      const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
      const message2 = await desktop.acceptMessage1(message1)
      await mobile.acceptDesktopHandshake(message2)
      await desktop.finishMessage3(mobile.exportFinishMessage())
      const sealed = await desktop.sealMobileRelayAuthority(grant as never, new Uint8Array(32).fill(19))
      await expect(mobile.openRelayAuthority(sealed)).rejects.toThrow(message)
    }
  })

  it('rejects legacy provider reconnect reads before sealing and wipes every allocation kind', async () => {
    const provider = new SnowPairingHandshakeProvider()
    await expect(provider.createChallenge({ invitationSecret: Uint8Array.of(1), expiresAt: 1 }))
      .rejects.toThrow('must contain exactly 32 bytes')
    await expect(provider.completeChallenge({
      invitationSecret: new Uint8Array(32), challengeState: Uint8Array.of(1),
      mobileHandshake: Uint8Array.of(1),
    })).rejects.toThrow('challenge state is invalid')
    expect(() => provider.exportReconnectState(Uint8Array.of(1)))
      .toThrow('unavailable before Relay authority sealing')
    const challenge = Uint8Array.of(1, 2)
    const pending = Uint8Array.of(3, 4)
    const active = Uint8Array.of(5, 6)
    provider.destroyChallenge(challenge)
    provider.destroyPendingPairing(pending)
    provider.destroyPairing(active)
    expect([challenge, pending, active]).toEqual([
      new Uint8Array(2), new Uint8Array(2), new Uint8Array(2),
    ])
  })

  it('rejects malformed or unmatched attachment-owned IK projections', async () => {
    const paired = await endpointReconnectState()
    const selector = parseRelayPairingSelector('pairing-attachment-tail')
    const routeId = parseRelayRouteId('route-attachment-tail')
    const mobileAttachmentId = parseRelayAttachmentId('mobile-attachment-tail')
    const desktopAttachmentId = parseRelayAttachmentId('desktop-attachment-tail')
    const ready = {
      type: 'ready' as const, transportVersion: 1 as const, routeId, attachmentId: mobileAttachmentId,
      peers: [{ attachmentId: desktopAttachmentId, pairingSelector: selector, generation: 1 }],
    }
    const mobile = new SnowMobileAttachmentOwner(paired.mobileState, selector)
    await expect(mobile.begin({ ...ready, peers: [] })).rejects.toThrow('exactly one Desktop peer')
    await expect(mobile.begin({ ...ready, peers: [...ready.peers, ...ready.peers] }))
      .rejects.toThrow('exactly one Desktop peer')
    await mobile.begin(ready)
    const missingOffer = new TextEncoder().encode(JSON.stringify({
      type: 'snow-ik-2', version: 1, generation: 1, routeId,
      desktopAttachmentId, mobileAttachmentId, pairingSelector: selector,
      message: [1], companionOffer: [],
    }))
    expect(() => mobile.finish(missingOffer, desktopAttachmentId)).toThrow('offer must contain bytes')
    const mismatched = new TextEncoder().encode(JSON.stringify({
      type: 'snow-ik-2', version: 1, generation: 1, routeId,
      desktopAttachmentId: 'desktop-other', mobileAttachmentId, pairingSelector: selector,
      message: [1], companionOffer: [2],
    }))
    expect(() => mobile.finish(mismatched, desktopAttachmentId)).toThrow('does not match')
    mobile.cancel()
    mobile.dispose()
    mobile.dispose()
    await expect(mobile.begin(ready)).rejects.toThrow('is disposed')
    expect(() => mobile.finish(mismatched, desktopAttachmentId)).toThrow('is disposed')

    const desktop = new SnowDesktopAttachmentOwner(() => undefined)
    const missingMobile = new SnowMobileAttachmentOwner(paired.mobileState, selector)
    const missing = await missingMobile.begin(ready)
    await expect(desktop.accept(missing.payload, mobileAttachmentId, routeId, desktopAttachmentId))
      .rejects.toThrow('has no local Personal Pairing')
    missingMobile.cancel()

    for (const value of [
      null,
      { type: 'snow-ik-1' },
      { type: 'other', version: 1, generation: 1, routeId, desktopAttachmentId, mobileAttachmentId,
        pairingSelector: selector, message: [1] },
      { type: 'snow-ik-1', version: 2, generation: 1, routeId, desktopAttachmentId, mobileAttachmentId,
        pairingSelector: selector, message: [1] },
      { type: 'snow-ik-1', version: 1, generation: 0, routeId, desktopAttachmentId, mobileAttachmentId,
        pairingSelector: selector, message: [1] },
      { type: 'snow-ik-1', version: 1, generation: 1, routeId, desktopAttachmentId, mobileAttachmentId,
        pairingSelector: selector, message: [] },
    ]) {
      await expect(desktop.accept(
        new TextEncoder().encode(JSON.stringify(value)), mobileAttachmentId, routeId, desktopAttachmentId,
      )).rejects.toThrow()
    }
  })

  it('rejects invalid reconnect bindings and record sizes', async () => {
    const paired = await endpointReconnectState()
    const binding = {
      routeId: parseRelayRouteId('route-attachment-tail'),
      pairingSelector: parseRelayPairingSelector('pairing-attachment-tail'),
      desktopAttachmentId: parseRelayAttachmentId('desktop-attachment-tail'),
      mobileAttachmentId: parseRelayAttachmentId('mobile-attachment-tail'),
      generation: 1,
    }
    await expect(beginSnowMobileReconnect(paired.mobileState, { ...binding, generation: 0 }))
      .rejects.toThrow('generation must be a positive safe integer')
    await expect(beginSnowMobileReconnect(Uint8Array.of(1), binding))
      .rejects.toThrow('Mobile reconnect state must contain 96 bytes')
    await expect(acceptSnowDesktopReconnect(Uint8Array.of(1), binding, Uint8Array.of(1)))
      .rejects.toThrow('Desktop reconnect state must contain 96 bytes')
  })

  it('rejects recovery messages larger than the persisted record encoding', async () => {
    const mobile = new SnowMobileHandshakeClient()
    Reflect.set(mobile, 'mobilePrivate', new Uint8Array(32))
    Reflect.set(mobile, 'mobilePublic', new Uint8Array(32))
    Reflect.set(mobile, 'mobileEphemeral', new Uint8Array(32))
    Reflect.set(mobile, 'desktopPublic', new Uint8Array(32))
    Reflect.set(mobile, 'psk', new Uint8Array(32))
    Reflect.set(mobile, 'message1', Uint8Array.of(1))
    Reflect.set(mobile, 'message2', new Uint8Array(65_536))
    Reflect.set(mobile, 'finishMessage', Uint8Array.of(1))
    Reflect.set(mobile, 'handshakeHash', new Uint8Array(32))
    expect(() => mobile.exportRecoveryState()).toThrow('exceeds 65535 bytes')
  })
})

async function endpointReconnectState(): Promise<{ desktopState: Uint8Array; mobileState: Uint8Array }> {
  const desktop = new SnowDesktopEndpointPairingOwner()
  const invitation = await desktop.createInvitation(Date.now() + 60_000)
  const mobile = new SnowMobileHandshakeClient()
  const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
  const message2 = await desktop.acceptMessage1(message1)
  await mobile.acceptDesktopHandshake(message2)
  await desktop.finishMessage3(mobile.exportFinishMessage())
  const grant = {
    endpoint: 'mobile' as const,
    routeId: parseRelayRouteId('route-attachment-tail'),
    credential: parseRelayCredential('A'.repeat(43)), revision: 1,
    pairingSelector: parseRelayPairingSelector('pairing-attachment-tail'),
  }
  const sealed = await desktop.sealMobileRelayAuthority(grant, new Uint8Array(32).fill(23))
  await mobile.openRelayAuthority(sealed)
  return { desktopState: desktop.exportReconnectState(), mobileState: mobile.exportReconnectState() }
}
