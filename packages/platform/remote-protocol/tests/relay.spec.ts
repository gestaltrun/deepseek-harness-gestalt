import { describe, expect, it, vi } from 'vitest'
import {
  decodeRelayMessage,
  deriveRelayCredentialDigest,
  deriveRelayCredentialPublicKey,
  encodeRelayMessage,
  generateRelayCredential,
  negotiateRelayTransportVersion,
  parseRelayAttachmentId,
  parseRelayAttachChallengeId,
  parseRelayCredential,
  parseRelayCredentialPublicKey,
  parseRelayPairingSelector,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
  RemoteProtocolError,
  signRelayAttachmentChallenge,
  verifyRelayAttachmentProof,
} from '../src/index.ts'

describe('Relay Transport Protocol codec', () => {
  it('derives stable authority from an endpoint-owned signing credential', async () => {
    const credential = await generateRelayCredential()
    await expect(deriveRelayCredentialDigest(credential)).resolves.toHaveLength(32)
    await expect(deriveRelayCredentialDigest(credential)).resolves.toEqual(await deriveRelayCredentialDigest(credential))
  })

  it('round-trips only routing metadata and opaque ciphertext', () => {
    const applicationPlaintext = 'submit the private prompt'
    const encoded = encodeRelayMessage({
      type: 'ciphertext',
      transportVersion: 1,
      routeId: parseRelayRouteId('route-keyless'),
      sourceAttachmentId: parseRelayAttachmentId('mobile-keyless'),
      targetAttachmentId: parseRelayAttachmentId('desktop-keyless'),
      ciphertext: new TextEncoder().encode('opaque-encrypted-bytes'),
    })

    expect(new TextDecoder().decode(encoded)).not.toContain(applicationPlaintext)
    expect(decodeRelayMessage(encoded)).toEqual({
      type: 'ciphertext',
      transportVersion: 1,
      routeId: 'route-keyless',
      sourceAttachmentId: 'mobile-keyless',
      targetAttachmentId: 'desktop-keyless',
      ciphertext: new TextEncoder().encode('opaque-encrypted-bytes'),
    })
  })

  it('admits only proof-based attachment, forwarding, heartbeat, revocation, and transport errors', async () => {
    const routeId = parseRelayRouteId('route-keyless')
    const attachmentId = parseRelayAttachmentId('mobile-keyless')
    const credential = await generateRelayCredential()
    const credentialPublicKey = await deriveRelayCredentialPublicKey(credential)
    const request = { type: 'attach-challenge' as const, transportVersion: 1 as const, routeId, attachmentId, endpoint: 'mobile' as const, credentialPublicKey }
    const challenge = {
      ...request, type: 'attach-challenge-response' as const,
      challengeId: parseRelayAttachChallengeId('challenge-one'), nonce: new Uint8Array(32).fill(7),
      expiresAt: 1_787_027_200_000,
    }
    const proof = await signRelayAttachmentChallenge(credential, challenge)
    const messages = [
      request,
      challenge,
      proof,
      { type: 'heartbeat', transportVersion: 1, attachmentId, sentAt: 1_787_027_200_000 },
      {
        type: 'ready', transportVersion: 1, routeId, attachmentId,
        peers: [{
          attachmentId: parseRelayAttachmentId('desktop-peer'),
          pairingSelector: parseRelayPairingSelector('pairing-one'),
          generation: 7,
        }],
      },
      { type: 'revoke', transportVersion: 1, routeId, attachmentId, reason: 'device' },
      { type: 'revoke', transportVersion: 1, routeId, attachmentId, reason: 'all' },
      { type: 'revoke', transportVersion: 1, routeId, attachmentId, reason: 'disabled' },
      { type: 'error', transportVersion: 1, code: 'RELAY_ROUTE_REVOKED' },
      { type: 'error', transportVersion: 1, code: 'PLATFORM_CAPACITY', retryAfterMs: 1_000 },
      { type: 'error', transportVersion: 1, code: 'RELAY_ATTACHMENT_REJECTED' },
      { type: 'error', transportVersion: 1, code: 'RELAY_SLOW_CONSUMER' },
      { type: 'error', transportVersion: 1, code: 'RELAY_TRANSPORT_INCOMPATIBLE' },
      { type: 'error', transportVersion: 1, code: 'REMOTE_OFFLINE' },
    ] as const

    for (const message of messages) {
      expect(decodeRelayMessage(encodeRelayMessage(message))).toEqual(message)
    }
    expect(negotiateRelayTransportVersion([1], [1])).toBe(1)

    const forbidden = new TextEncoder().encode(JSON.stringify({
      type: 'attach',
      transportVersion: 1,
      routeId,
      attachmentId,
      endpoint: 'mobile',
      credentialPublicKey,
      challengeId: challenge.challengeId,
      nonce: Buffer.from(challenge.nonce).toString('base64url'),
      expiresAt: challenge.expiresAt,
      signature: Buffer.from(proof.signature).toString('base64url'),
      prompt: 'must never reach Relay',
    }))
    expect(() => decodeRelayMessage(forbidden)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => { Reflect.apply(encodeRelayMessage, undefined, [{ type: 'host-request' }]) }).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })

  it('fails closed when Relay transport versions do not overlap', () => {
    expect(() => negotiateRelayTransportVersion([1], [2])).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'RELAY_TRANSPORT_INCOMPATIBLE' }),
    )
  })

  it('binds attachment proofs to the exact challenge tuple', async () => {
    const credential = await generateRelayCredential()
    const challenge = {
      type: 'attach-challenge-response' as const, transportVersion: 1 as const,
      routeId: parseRelayRouteId('route-proof'), attachmentId: parseRelayAttachmentId('mobile-proof'),
      endpoint: 'mobile' as const, credentialPublicKey: await deriveRelayCredentialPublicKey(credential),
      challengeId: parseRelayAttachChallengeId('challenge-proof'), nonce: new Uint8Array(32).fill(3),
      expiresAt: 1_787_027_200_000,
    }
    const proof = await signRelayAttachmentChallenge(credential, challenge)
    await expect(verifyRelayAttachmentProof(proof)).resolves.toBe(true)
    await expect(verifyRelayAttachmentProof({ ...proof, routeId: parseRelayRouteId('route-tampered') }))
      .resolves.toBe(false)
    await expect(verifyRelayAttachmentProof({ ...proof, attachmentId: parseRelayAttachmentId('mobile-tampered') }))
      .resolves.toBe(false)
    await expect(verifyRelayAttachmentProof({ ...proof, expiresAt: proof.expiresAt + 1 }))
      .resolves.toBe(false)
  })

  it('enforces message, parser-depth, encoded-value, and ciphertext limits before dispatch', () => {
    const overMessageLimit = new Uint8Array(REMOTE_PROTOCOL_LIMITS.relayMessageBytes + 1)
    expect(() => decodeRelayMessage(overMessageLimit)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    let deepValue: unknown = 'leaf'
    for (let depth = 0; depth <= REMOTE_PROTOCOL_LIMITS.parserDepth; depth += 1) deepValue = [deepValue]
    const overDepth = new TextEncoder().encode(JSON.stringify({
      type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', endpoint: 'mobile',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', extra: deepValue,
    }))
    expect(() => decodeRelayMessage(overDepth)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const tooManyValues = new TextEncoder().encode(JSON.stringify({
      type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', endpoint: 'mobile',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      extra: Array.from({ length: REMOTE_PROTOCOL_LIMITS.containerValues + 1 }, () => null),
    }))
    expect(() => decodeRelayMessage(tooManyValues)).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )

    const exactCiphertext = Uint8Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.ciphertextBytes },
      (_, index) => index % 256,
    )
    const exactCiphertextMessage = {
      type: 'ciphertext' as const,
      transportVersion: 1 as const,
      routeId: parseRelayRouteId('route'),
      sourceAttachmentId: parseRelayAttachmentId('mobile'),
      targetAttachmentId: parseRelayAttachmentId('desktop'),
      ciphertext: exactCiphertext,
    }
    expect(decodeRelayMessage(encodeRelayMessage(exactCiphertextMessage))).toEqual(exactCiphertextMessage)

    expect(() => encodeRelayMessage({
      type: 'ciphertext', transportVersion: 1,
      routeId: parseRelayRouteId('route'),
      sourceAttachmentId: parseRelayAttachmentId('mobile'),
      targetAttachmentId: parseRelayAttachmentId('desktop'),
      ciphertext: new Uint8Array(REMOTE_PROTOCOL_LIMITS.ciphertextBytes + 1),
    })).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
  })

  it('rejects malformed transport fields with stable errors', () => {
    expect(() => parseRelayCredentialPublicKey('short')).toThrow('canonical base64url SPKI')
    const invalidEndpoint = new TextEncoder().encode(JSON.stringify({
      type: 'attach-challenge', transportVersion: 1, routeId: 'route', attachmentId: 'mobile',
      endpoint: 'relay', credentialPublicKey: 'A'.repeat(64),
    }))
    expect(() => decodeRelayMessage(invalidEndpoint)).toThrow('Relay endpoint must be mobile or desktop')
    const attach = {
      type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', endpoint: 'mobile',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }
    const malformed = [
      null,
      [],
      'not-an-object',
      { ...attach, transportVersion: 2 },
      { ...attach, endpoint: 'relay' },
      { ...attach, type: 'host-request' },
      { type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', endpoint: 'mobile' },
      { ...attach, credential: 'route-id-is-not-authentication' },
      { type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', wrong: 'mobile' },
      { type: 'ciphertext', transportVersion: 1, routeId: 'route', sourceAttachmentId: 'mobile', targetAttachmentId: 'desktop', ciphertext: 1 },
      { type: 'ciphertext', transportVersion: 1, routeId: 'route', sourceAttachmentId: 'mobile', targetAttachmentId: 'desktop', ciphertext: '*' },
      { type: 'heartbeat', transportVersion: 1, attachmentId: 'mobile', sentAt: 1.5 },
      { type: 'heartbeat', transportVersion: 1, attachmentId: 'mobile', sentAt: -1 },
      { type: 'ready', transportVersion: 1 },
      { type: 'ready', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', peers: {} },
      {
        type: 'ready', transportVersion: 1, routeId: 'route', attachmentId: 'mobile',
        peers: [{ attachmentId: 'desktop', pairingSelector: 'pairing', generation: 0 }],
      },
      {
        type: 'ready', transportVersion: 1, routeId: 'route', attachmentId: 'mobile',
        peers: [
          { attachmentId: 'desktop-one', pairingSelector: 'pairing', generation: 1 },
          { attachmentId: 'desktop-two', pairingSelector: 'pairing', generation: 2 },
        ],
      },
      { type: 'revoke', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', reason: 'unknown' },
      { type: 'error', transportVersion: 1, code: 'UNKNOWN' },
      { type: 'error', transportVersion: 1, code: 'PLATFORM_CAPACITY', retryAfterMs: -1 },
    ]
    for (const value of malformed) {
      expect(() => decodeRelayMessage(json(value))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }

    expect(() => decodeRelayMessage(Uint8Array.of(0xff))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => decodeRelayMessage(json({
      type: 'ciphertext', transportVersion: 1, routeId: 'route',
      sourceAttachmentId: 'mobile', targetAttachmentId: 'desktop', ciphertext: 'A',
    }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
  })

  it('rejects non-canonical base64url aliases for opaque ciphertext', () => {
    const frame = {
      type: 'ciphertext', transportVersion: 1, routeId: 'route',
      sourceAttachmentId: 'mobile', targetAttachmentId: 'desktop',
    }
    expect(() => decodeRelayMessage(json({ ...frame, ciphertext: 'AB' }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(decodeRelayMessage(json({ ...frame, ciphertext: 'AA' }))).toEqual({
      ...frame,
      routeId: 'route',
      sourceAttachmentId: 'mobile',
      targetAttachmentId: 'desktop',
      ciphertext: Uint8Array.of(0),
    })

    const decodeFailure = vi.spyOn(Uint8Array, 'from').mockImplementationOnce(() => {
      throw new Error('base64 decoder unavailable')
    })
    try {
      expect(() => decodeRelayMessage(json({ ...frame, ciphertext: 'AA' }))).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    } finally {
      decodeFailure.mockRestore()
    }
  })

  it('bounds every encoded JSON value before Relay dispatch', () => {
    const attach = {
      type: 'attach', transportVersion: 1, routeId: 'route', attachmentId: 'mobile', endpoint: 'mobile',
      credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }
    expect(() => decodeRelayMessage(json({ ...attach, extra: 'x'.repeat(REMOTE_PROTOCOL_LIMITS.stringBytes + 1) }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeRelayMessage(json({
      ...attach,
      extra: Array.from({ length: 17 }, () => Array.from({ length: 256 }, () => null)),
    }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
    expect(() => decodeRelayMessage(json({ ...attach, extra: [null, true, false] }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
    )
    expect(() => decodeRelayMessage(json({
      type: 'ciphertext', transportVersion: 1, routeId: 'route',
      sourceAttachmentId: 'mobile', targetAttachmentId: 'desktop',
      ciphertext: Buffer.alloc(REMOTE_PROTOCOL_LIMITS.ciphertextBytes + 1).toString('base64url'),
    }))).toThrow(
      expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_LIMIT_EXCEEDED' }),
    )
  })

  it('brands only bounded canonical Relay identifiers', () => {
    for (const value of [undefined, '', 'x'.repeat(129), 'not valid']) {
      expect(() => parseRelayRouteId(value)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
    expect(parseRelayAttachmentId('attachment_valid-1')).toBe('attachment_valid-1')
    for (const value of [undefined, '', 'route-only', 'A'.repeat(42), 'A'.repeat(513), 'not+canonical']) {
      expect(() => parseRelayCredential(value)).toThrow(
        expect.objectContaining<Partial<RemoteProtocolError>>({ code: 'REMOTE_PROTOCOL_INVALID_MESSAGE' }),
      )
    }
  })
})

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}
