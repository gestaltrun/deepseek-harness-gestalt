import { describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  deriveCompanionAttachmentKey,
  hashCompanionCiphertext,
  parseCompanionOperationId,
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  sealCompanionAttachment,
  type CompanionOfferAttachmentOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  CompanionAttachmentReceiveError,
  companionAttachmentReasonFromHttpStatus,
  downloadCompanionAttachment,
  receiveCompanionAttachment,
} from '../src/companion-attachments.ts'

const pairingId = parsePersonalPairingId('pairing-a')
const attachmentKey = crypto.getRandomValues(new Uint8Array(32))
const plaintext = new TextEncoder().encode('desktop-bound attachment')

async function offer(overrides: Partial<CompanionOfferAttachmentOperation> = {}): Promise<{
  offer: CompanionOfferAttachmentOperation
  ciphertext: Uint8Array
  hash: string
}> {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc resolves CryptoKey via @types/node; oxlint's program misses that global
  const key = await deriveCompanionAttachmentKey(attachmentKey)
  const sealed = await sealCompanionAttachment(key, plaintext)
  return {
    ciphertext: sealed.ciphertext,
    hash: sealed.ciphertextSha256,
    offer: {
      type: 'offer-attachment',
      operationId: parseCompanionOperationId('operation-one'),
      sessionId: parseCompanionSessionId('session-one'),
      capability: 'A'.repeat(43) as never,
      ciphertextSha256: sealed.ciphertextSha256,
      byteLength: sealed.ciphertext.byteLength,
      expiresAt: 2_000,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
      ...overrides,
    },
  }
}

describe('Desktop Companion attachment receive', () => {
  it('verifies the ciphertext hash before decrypting and submitting into the Session path', async () => {
    const prepared = await offer()
    const submit = vi.fn(async () => {})
    const download = vi.fn(async () => prepared.ciphertext)
    const received = await receiveCompanionAttachment(prepared.offer, {
      pairingId,
      attachmentKey,
      now: 1_000,
      download,
      submit,
    })
    expect(received).toEqual({ fileName: 'notes.txt', byteLength: plaintext.byteLength })
    expect(download).toHaveBeenCalledWith(prepared.offer, pairingId)
    expect(submit).toHaveBeenCalledWith({ fileName: 'notes.txt', plaintext })
  })

  it('never decrypts or submits on hash mismatch', async () => {
    const prepared = await offer({ ciphertextSha256: '0'.repeat(64) })
    const submit = vi.fn()
    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId,
      attachmentKey,
      now: 1_000,
      download: vi.fn(async () => prepared.ciphertext),
      submit,
    })).rejects.toMatchObject({ reason: 'hash-mismatch' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('fails explicitly on byte-count mismatch, tampered ciphertext, expiry, interruption, and limit violations', async () => {
    const prepared = await offer()
    const noSubmit = () => { throw new Error('rejected receive must never submit') }

    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId, attachmentKey, now: 1_000,
      download: async () => prepared.ciphertext.slice(0, -1),
      submit: noSubmit,
    })).rejects.toMatchObject({ reason: 'hash-mismatch' })

    const tampered = new Uint8Array(prepared.ciphertext)
    tampered[0] ^= 0xff
    expect(await hashCompanionCiphertext(tampered)).not.toBe(prepared.hash)
    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId, attachmentKey, now: 1_000,
      download: async () => tampered,
      submit: noSubmit,
    })).rejects.toMatchObject({ reason: 'hash-mismatch' })

    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId, attachmentKey, now: 2_000,
      download: async () => prepared.ciphertext,
      submit: noSubmit,
    })).rejects.toMatchObject({ reason: 'expired' })

    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId, attachmentKey, now: 1_000,
      download: () => Promise.reject(new Error('connection reset')),
      submit: noSubmit,
    })).rejects.toMatchObject({ reason: 'transfer-interrupted' })

    await expect(receiveCompanionAttachment(
      (await offer({ byteLength: REMOTE_PROTOCOL_LIMITS.attachmentBlobBytes + 1 })).offer,
      {
        pairingId, attachmentKey, now: 1_000,
        download: async () => prepared.ciphertext,
        submit: noSubmit,
      },
    )).rejects.toMatchObject({ reason: 'limit-exceeded' })

    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId,
      attachmentKey: crypto.getRandomValues(new Uint8Array(32)),
      now: 1_000,
      download: async () => prepared.ciphertext,
      submit: noSubmit,
    })).rejects.toMatchObject({ reason: 'hash-mismatch' })
  })

  it('propagates an explicit cross-pairing rejection from the blob store boundary', async () => {
    const prepared = await offer()
    await expect(receiveCompanionAttachment(prepared.offer, {
      pairingId,
      attachmentKey,
      now: 1_000,
      download: () => Promise.reject(new CompanionAttachmentReceiveError(
        'cross-pairing',
        'Remote attachment capability belongs to another Personal Pairing',
      )),
      submit: () => { throw new Error('cross-pairing must never submit') },
    })).rejects.toMatchObject({ reason: 'cross-pairing' })
  })

  it('maps Platform consume HTTP statuses onto protocol-native rejection reasons', async () => {
    expect(companionAttachmentReasonFromHttpStatus(403)).toBe('cross-pairing')
    expect(companionAttachmentReasonFromHttpStatus(404)).toBe('absent')
    expect(companionAttachmentReasonFromHttpStatus(410)).toBe('expired')
    expect(companionAttachmentReasonFromHttpStatus(413)).toBe('limit-exceeded')
    expect(companionAttachmentReasonFromHttpStatus(500)).toBeUndefined()
    const prepared = await offer()
    const origin = 'https://platform.example'
    const download = async (status: number, body = new Uint8Array()) =>
      await downloadCompanionAttachment(prepared.offer, {
        pairingId,
        origin,
        fetch: async () => new Response(body, { status }),
      })
    await expect(download(403)).rejects.toMatchObject({ reason: 'cross-pairing' })
    await expect(download(404)).rejects.toMatchObject({ reason: 'absent' })
    await expect(download(410)).rejects.toMatchObject({ reason: 'expired' })
    await expect(download(413)).rejects.toMatchObject({ reason: 'limit-exceeded' })
    await expect(download(500)).rejects.toMatchObject({ reason: 'transfer-interrupted' })
    await expect(downloadCompanionAttachment(prepared.offer, {
      pairingId,
      origin,
      fetch: async () => { throw new Error('socket hang up') },
    })).rejects.toMatchObject({ reason: 'transfer-interrupted' })
    await expect(downloadCompanionAttachment(prepared.offer, {
      pairingId,
      origin,
      fetch: async () => {
        throw new CompanionAttachmentReceiveError('absent', 'already mapped')
      },
    })).rejects.toMatchObject({ reason: 'absent' })
    await expect(downloadCompanionAttachment(prepared.offer, {
      pairingId,
      origin,
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('x-gestalt-pairing-selector')).toBe(pairingId)
        return new Response(prepared.ciphertext, { status: 200 })
      },
    })).resolves.toEqual(prepared.ciphertext)
  })
})
