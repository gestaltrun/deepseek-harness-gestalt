import { describe, expect, it, vi } from 'vitest'
import { deriveKeylessMobileHandshake, deriveKeylessPairingKey } from '@deepseek-ai/dsh-remote-access'
import { KeylessMobileHandshakeFixture } from './fixtures/development-keyless-pairing.fixture.ts'

const SECRET = new Uint8Array(32)
const LINK = invitationLink(SECRET)

describe('KeylessMobileHandshakeFixture', () => {
  it('derives handshake bytes from the invitation and retains the pairing key after Desktop match', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
    const client = new KeylessMobileHandshakeFixture()
    const mobileHandshake = await deriveKeylessMobileHandshake(SECRET)
    const pairingKey = await deriveKeylessPairingKey(SECRET)

    await expect(client.begin(LINK)).resolves.toEqual({
      completionId: 'fixture-00000000-0000-4000-8000-000000000001',
      mobileHandshake,
    })
    await expect(client.acceptDesktopHandshake(Uint8Array.of(1))).rejects.toThrow('does not match')
    await expect(client.acceptDesktopHandshake(pairingKey)).resolves.toBeUndefined()
    expect(client.exportPairingKeyMaterial()).toEqual(pairingKey)
    expect(client.exportPairingKeyMaterial()).not.toBe(client.exportPairingKeyMaterial())
    client.wipe()
    expect(client.exportPairingKeyMaterial()).toBeUndefined()
    await expect(client.acceptDesktopHandshake(pairingKey)).rejects.toThrow('no prepared invitation')

    await expect(client.openRelayAuthority(new TextEncoder().encode(JSON.stringify({
      endpoint: 'mobile',
      routeId: 'route-mobile',
      credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      revision: 2,
    })))).resolves.toEqual({
      endpoint: 'mobile',
      routeId: 'route-mobile',
      credential: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      revision: 2,
    })
  })

  it.each([
    ['null', 'must be an object'],
    ['[]', 'must be an object'],
    ['{}', 'endpoint must be mobile'],
    ['{"endpoint":"desktop","revision":1}', 'endpoint must be mobile'],
    ['{"endpoint":"mobile"}', 'revision must be positive'],
    ['{"endpoint":"mobile","revision":0}', 'revision must be positive'],
    ['{"endpoint":"mobile","revision":1,"routeId":"","credential":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"}', 'routeId must be'],
    ['{"endpoint":"mobile","revision":1,"routeId":"route","credential":"short"}', 'Relay credential'],
  ])('rejects malformed development authority %s', async (encoded, message) => {
    const client = new KeylessMobileHandshakeFixture()
    await expect(client.openRelayAuthority(new TextEncoder().encode(encoded))).rejects.toThrow(message)
  })
})

function invitationLink(secret: Uint8Array): string {
  return `https://platform.example/pair?challenge=challenge-one&secret=${encodeBase64Url(secret)}&fingerprint=desktop-fingerprint&rendezvous=rendezvous-one&expires=1&protocol=1`
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
