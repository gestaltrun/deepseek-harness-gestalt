import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingChallengeId, parsePendingPairingId, parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { initializeSnowChannel, SnowMobileHandshakeClient } from '@deepseek-ai/dsh-noise-channel'
import { parseRelayCredential, parseRelayPairingSelector, parseRelayRouteId } from '@deepseek-ai/dsh-remote-protocol'
import {
  DesktopSnowPairingVault,
  EncryptedDesktopSnowPairingStore,
} from '../src/snow-pairing-vault.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })

describe('DesktopSnowPairingVault', () => {
  it('rejects hostile ids and non-positive active Relay revisions from protected state', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-snow-vault-hostile-'))
    directories.push(directory)
    const path = join(directory, 'pairings.bin')
    const protection = {
      encrypt: (value: string) => new TextEncoder().encode(value),
      decrypt: (value: Uint8Array) => new TextDecoder().decode(value),
    }
    const store = new EncryptedDesktopSnowPairingStore(path, protection)
    const invitation = await new DesktopSnowPairingVault().createInvitation(Date.now() + 60_000)
    const recovery = Object.fromEntries(Object.entries(invitation.owner.exportRecoveryState()).map(([key, value]) => [
      key, Buffer.from(value).toString('base64url'),
    ]))
    const document = {
      active: [{
        pairingId: 'pairing-hostile', state: Buffer.alloc(96, 1).toString('base64url'),
        attachmentKey: Buffer.alloc(32, 2).toString('base64url'),
        desktopGrant: {
          routeId: 'route-hostile', endpoint: 'desktop',
          credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          revision: 1, pairingSelector: 'pairing-hostile',
        },
      }],
      challenges: [{ challengeId: 'challenge-hostile', recovery }],
      pending: [{ pendingPairingId: 'pending-hostile', recovery }],
      confirmations: [],
    }
    const persist = async (value: unknown) => {
      const encrypted = protection.encrypt(JSON.stringify(value))
      await writeFile(path, Buffer.from(encrypted).toString('base64'))
    }

    await persist({ ...document, active: [{ ...document.active[0], desktopGrant: {
      ...document.active[0]?.desktopGrant, revision: 0,
    } }] })
    await expect(store.load()).rejects.toThrow('Relay grant is invalid')
    await persist({ ...document, challenges: [{ challengeId: 7, recovery }] })
    await expect(store.load()).rejects.toThrow('Pairing Challenge id')
    await persist({ ...document, pending: [{ pendingPairingId: 7, recovery }] })
    await expect(store.load()).rejects.toThrow('Pending Pairing id')
  })

  it('rejects a seventeenth retained pairing before any external publication can begin', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const save = vi.fn(async () => {})
    const active = Array.from({ length: 16 }, (_, index) => ({
      pairingId: parsePersonalPairingId(`pairing-${String(index)}`),
      reconnectState: new Uint8Array(96).fill(index + 1),
      attachmentKey: new Uint8Array(32).fill(index + 1),
      desktopGrant: {
        routeId: parseRelayRouteId(`route-${String(index)}`), endpoint: 'desktop' as const,
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        revision: 1, pairingSelector: parseRelayPairingSelector(`pairing-${String(index)}`),
      },
    }))
    const vault = await DesktopSnowPairingVault.load({
      load: async () => ({ active, challenges: [], pending: [], confirmations: [] }), save,
    })

    await expect(vault.createInvitation(Date.now() + 60_000)).rejects.toThrow('limit reached')
    expect(save).not.toHaveBeenCalled()
    await expect(DesktopSnowPairingVault.load({
      load: async () => ({ active: [...active, active[0]], challenges: [], pending: [], confirmations: [] }),
      save,
    })).rejects.toThrow('retained state limit')
  })

  it('recovers every Desktop-owned handshake and confirmation commit point from protected state', async () => {
    initializeSnowChannel(readFileSync(new URL(
      '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
    )))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-snow-vault-'))
    directories.push(directory)
    const path = join(directory, 'pairings.bin')
    const protection = {
      encrypt: (value: string) => new TextEncoder().encode(`protected:${value}`),
      decrypt: (value: Uint8Array) => new TextDecoder().decode(value).replace(/^protected:/u, ''),
    }
    const store = new EncryptedDesktopSnowPairingStore(path, protection)
    let vault = await DesktopSnowPairingVault.load(store)
    const invitation = await vault.createInvitation(Date.now() + 60_000)
    const challengeId = parsePairingChallengeId('challenge-persist')
    const pendingPairingId = parsePendingPairingId('pending-persist')
    const pairingId = parsePersonalPairingId('pairing-persist')
    vault.retainChallenge(challengeId, invitation.owner)
    await vault.flush()

    vault = await DesktopSnowPairingVault.load(store)
    const mobile = new SnowMobileHandshakeClient()
    const message1 = await mobile.beginEndpointInvitation(invitation.invitationPayload)
    let owner = vault.bindPending(challengeId, pendingPairingId)
    const message2 = await owner.acceptMessage1(message1)
    await vault.checkpointPending(pendingPairingId)

    vault = await DesktopSnowPairingVault.load(store)
    owner = vault.pendingOwner(pendingPairingId) ?? (() => { throw new Error('pending owner was not restored') })()
    expect(await owner.acceptMessage1(message1)).toEqual(message2)
    await mobile.acceptDesktopHandshake(message2)
    await owner.finishMessage3(mobile.exportFinishMessage())
    const authenticationHash = mobile.exportAuthenticationHash()
    expect(vault.pendingAuthenticationHash(pendingPairingId)).toEqual(authenticationHash)
    await vault.checkpointPending(pendingPairingId)
    const prepared = await vault.prepareConfirmation(pendingPairingId)
    expect(prepared.desktopCredentialDigest).not.toEqual(prepared.mobileCredentialDigest)
    const preparedDocument = JSON.parse(
      Buffer.from(await readFile(path, 'utf8'), 'base64').toString('utf8').replace(/^protected:/u, ''),
    ) as { confirmations: Array<{ transaction: { attachmentKey: string } }> }
    const preparedAttachmentKey = preparedDocument.confirmations[0]?.transaction.attachmentKey
    expect(Buffer.from(preparedAttachmentKey ?? '', 'base64url')).toHaveLength(32)

    vault = await DesktopSnowPairingVault.load(store)
    const replay = await vault.prepareConfirmation(pendingPairingId)
    expect(replay).toEqual(prepared)
    const replayDocument = JSON.parse(
      Buffer.from(await readFile(path, 'utf8'), 'base64').toString('utf8').replace(/^protected:/u, ''),
    ) as { confirmations: Array<{ transaction: { attachmentKey: string } }> }
    expect(replayDocument.confirmations[0]?.transaction.attachmentKey).toBe(preparedAttachmentKey)
    const confirmation = {
      pairing: {
        id: pairingId,
        devicePrincipal: {
          id: 'principal-persist' as never, accountId: 'account-persist' as never,
          installationId: 'mobile-persist' as never, authority: 'companion-surface' as const,
        },
        device: { name: 'Alice phone', platform: 'ios' as const },
        pairedAt: 1, lastAccessAt: 1, online: false,
      },
      routeId: parseRelayRouteId('route-persist'), relayRevision: 7,
    }
    const delivery = await vault.prepareSealedAuthority(pendingPairingId, confirmation)

    vault = await DesktopSnowPairingVault.load(store)
    expect(vault.desktopRelayGrant(pendingPairingId)).toMatchObject({
      endpoint: 'desktop', routeId: 'route-persist', revision: 7, pairingSelector: pairingId,
    })
    await expect(mobile.openRelayAuthority(delivery.sealedRelayAuthority)).resolves.toMatchObject({
      endpoint: 'mobile', routeId: 'route-persist', revision: 7, pairingSelector: pairingId,
    })
    const sharedApplicationKey = mobile.exportAttachmentKey()
    expect(sharedApplicationKey).not.toEqual(authenticationHash)
    await vault.commitConfirmation(pendingPairingId)

    const disk = await readFile(path, 'utf8')
    expect(disk).not.toContain('pairing-persist')
    const restored = await DesktopSnowPairingVault.load(store)
    expect(restored.reconnectState('pairing-persist' as never)).toHaveLength(96)
    expect(restored.attachmentKey('pairing-persist' as never)).toEqual(sharedApplicationKey)
    expect(restored.attachmentKey('pairing-not-confirmed' as never)).toBeUndefined()
    expect(restored.desktopRelayGrants()).toHaveLength(1)
    restored.release(pairingId)
    await restored.flush()
    expect((await DesktopSnowPairingVault.load(store))
      .reconnectState('pairing-persist' as never)).toBeUndefined()
    expect((await DesktopSnowPairingVault.load(store))
      .attachmentKey('pairing-persist' as never)).toBeUndefined()
  })
})
