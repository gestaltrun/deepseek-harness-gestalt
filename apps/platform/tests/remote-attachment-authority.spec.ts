import { describe, expect, it, vi } from 'vitest'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { OperatedRemoteAttachmentAuthority } from '../src/remote-attachment-authority.ts'

const pairingId = parsePersonalPairingId('pairing-authorized')
const authenticationHeaders = {
  authorization: 'Bearer current-access',
  'x-gestalt-proof-jti': 'proof-jti',
  'x-gestalt-proof-issued-at': '1234',
  'x-gestalt-proof-signature': 'proof-signature',
  'x-gestalt-pairing-selector': pairingId,
}

describe('operated remote attachment authority', () => {
  it('derives pairing scope only after current Installation and durable membership verification', async () => {
    const currentInstallation = vi.fn(async () => ({
      account: {
        id: parsePlatformAccountId('account-authorized'), githubId: 1,
        githubLogin: 'authorized', avatarUrl: 'https://avatars.example/authorized',
      },
      installation: { id: parseInstallationId('mobile-authorized'), kind: 'mobile' as const,
        presentation: { name: 'Real phone', platform: 'ios' as const } },
    }))
    const ownsConfirmedPairing = vi.fn(async () => true)
    const authority = new OperatedRemoteAttachmentAuthority(
      { currentInstallation },
      { ownsConfirmedPairing },
    )

    await expect(authority.authenticate({ headers: authenticationHeaders })).resolves.toBe(pairingId)
    expect(currentInstallation).toHaveBeenCalledWith({
      accessToken: 'current-access',
      proof: { jti: 'proof-jti', issuedAt: 1234, signature: 'proof-signature' },
    })
    expect(ownsConfirmedPairing).toHaveBeenCalledWith(
      'account-authorized', 'mobile-authorized', pairingId,
    )
  })

  it('rejects a selector missing durable Installation membership', async () => {
    const authority = new OperatedRemoteAttachmentAuthority({
      currentInstallation: async () => ({
        account: {
          id: parsePlatformAccountId('account-hostile'), githubId: 2,
          githubLogin: 'hostile', avatarUrl: 'https://avatars.example/hostile',
        },
        installation: { id: parseInstallationId('mobile-hostile'), kind: 'mobile' },
      }),
    } as never, { ownsConfirmedPairing: async () => false })

    await expect(authority.authenticate({ headers: authenticationHeaders }))
      .rejects.toMatchObject({ status: 403, code: 'ATTACHMENT_PAIRING_DENIED' })
  })

  it('rejects a missing selector before Account verification', async () => {
    const currentInstallation = vi.fn()
    const authority = new OperatedRemoteAttachmentAuthority(
      { currentInstallation },
      { ownsConfirmedPairing: vi.fn() },
    )
    const { 'x-gestalt-pairing-selector': _selector, ...headers } = authenticationHeaders
    await expect(authority.authenticate({ headers }))
      .rejects.toMatchObject({ status: 400, code: 'ATTACHMENT_PAIRING_REQUIRED' })
    expect(currentInstallation).not.toHaveBeenCalled()
  })
})
