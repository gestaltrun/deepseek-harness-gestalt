import { describe, expect, it, vi } from 'vitest'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  type CompanionOfferAttachmentOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  buildCompanionAttachmentOffer,
  CompanionAttachmentDeliveryUncertainError,
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES,
  sealCompanionAttachment,
  transferSelectedCompanionAttachment,
} from '../src/companion-attachment.ts'

const attachmentKey = crypto.getRandomValues(new Uint8Array(32))

describe('Companion encrypted attachments', () => {
  it('encrypts on Mobile with a pairing-derived key and returns the ciphertext hash', async () => {
    const plaintext = new TextEncoder().encode('secret attachment')
    const sealed = await sealCompanionAttachment(attachmentKey, plaintext, readyPermit())
    expect(sealed.ciphertext).not.toEqual(plaintext)
    expect(sealed.ciphertext.byteLength).toBe(plaintext.byteLength + COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES)
    expect(sealed.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/u)

    const offer = buildCompanionAttachmentOffer({
      capability: 'A'.repeat(43) as never,
      ciphertextSha256: sealed.ciphertextSha256,
      byteLength: sealed.ciphertext.byteLength,
      expiresAt: 1_000_000 + 900_000,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    }, parseCompanionOperationId('operation-one'), parseCompanionSessionId('session-one'), readyPermit())
    expect(offer).toEqual({
      type: 'offer-attachment',
      operationId: 'operation-one',
      sessionId: 'session-one',
      capability: 'A'.repeat(43),
      ciphertextSha256: sealed.ciphertextSha256,
      byteLength: sealed.ciphertext.byteLength,
      expiresAt: 1_900_000,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    })
  })

  it('rejects plaintext that cannot fit in the ciphertext ceiling after the GCM seal', async () => {
    const limit = 64
    const accepted = await sealCompanionAttachment(
      attachmentKey,
      new Uint8Array(limit - COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES),
      readyPermit(),
      limit,
    )
    expect(accepted.ciphertext.byteLength).toBe(limit)
    await expect(sealCompanionAttachment(
      attachmentKey,
      new Uint8Array(limit - COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES + 1),
      readyPermit(),
      limit,
    )).rejects.toThrow('ciphertext blob ceiling')
    expect(COMPANION_ATTACHMENT_MAX_BYTES).toBeGreaterThan(limit)
    await expect(sealCompanionAttachment(new Uint8Array(31), Uint8Array.of(1), readyPermit()))
      .rejects.toThrow('at least 32 bytes')
  })

  it('refuses attachment preparation and offers before foreground synchronization', async () => {
    await expect(sealCompanionAttachment(attachmentKey, Uint8Array.of(1), blockedPermit()))
      .rejects.toThrow(/foreground synchronization/)
    expect(() => buildCompanionAttachmentOffer({
      capability: 'A'.repeat(43) as never,
      ciphertextSha256: 'a'.repeat(64),
      byteLength: 29,
      expiresAt: 1_900_000,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    }, parseCompanionOperationId('operation-blocked'), parseCompanionSessionId('session-one'), blockedPermit()))
      .toThrow(/foreground synchronization/)
  })

  it.each([
    ['binary', 'archive.bin', Uint8Array.of(0, 255, 1, 128)],
    ['image', 'pixel.png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
    ['text', 'notes.txt', new TextEncoder().encode('real selected text bytes')],
  ])('reads real %s file bytes, uploads only ciphertext, and sends only the capability control message', async (
    _kind,
    name,
    plaintext,
  ) => {
    const uploaded: Uint8Array[] = []
    const sent: unknown[] = []
    const file = {
      name,
      type: _kind === 'image' ? 'image/png' : _kind === 'text' ? 'text/plain' : 'application/octet-stream',
      arrayBuffer: async () => plaintext.buffer.slice(
        plaintext.byteOffset,
        plaintext.byteOffset + plaintext.byteLength,
      ),
    }
    const operation = await transferSelectedCompanionAttachment(file, {
      attachmentKey,
      origin: 'https://platform.example',
      authorizationHeaders: { authorization: 'Bearer opaque-current-installation-proof' },
      operationId: parseCompanionOperationId(`operation-${_kind}`),
      sessionId: parseCompanionSessionId('session-one'),
      permit: readyPermit(),
      fetch: async (input, init) => {
        expect(input).toBe('https://platform.example/v1/remote-attachments')
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBe('Bearer opaque-current-installation-proof')
        expect(headers.get('content-type')).toBe('application/octet-stream')
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
        uploaded.push(body)
        expect(body).not.toEqual(plaintext)
        return new Response(JSON.stringify({
          capability: 'A'.repeat(43),
          byteLength: body.byteLength,
          expiresAt: 1_900_000,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      },
      send: async (offer) => { sent.push(offer) },
    })

    expect(uploaded).toHaveLength(1)
    expect(operation.fileName).toBe(name)
    expect(operation.byteLength).toBe(uploaded[0]?.byteLength)
    expect(sent).toEqual([operation])
    expect(JSON.stringify(sent)).not.toContain(Buffer.from(plaintext).toString('base64'))
    expect(Object.keys(operation).sort()).toEqual([
      'byteLength', 'capability', 'ciphertextSha256', 'expiresAt', 'fileName', 'mediaType', 'operationId', 'sessionId', 'type',
    ])
  })

  it('does not upload when its connection generation is replaced while reading the selected file', async () => {
    let releaseRead: ((value: ArrayBuffer) => void) | undefined
    const permit = controlledPermit()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const selectedBytes = Uint8Array.of(1, 2, 3)
    const transfer = transferSelectedCompanionAttachment({
      name: 'late.bin',
      type: 'application/octet-stream',
      arrayBuffer: async () => await new Promise<ArrayBuffer>((resolve) => { releaseRead = resolve }),
    }, transferOptions(permit, fetch, vi.fn(async () => {})))

    await Promise.resolve()
    permit.invalidate()
    if (releaseRead === undefined) throw new Error('expected selected-file read to start')
    releaseRead(selectedBytes.buffer)

    await expect(transfer).rejects.toThrow(/connection generation/)
    expect(selectedBytes).toEqual(Uint8Array.of(0, 0, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send a capability when backgrounding happens during upload', async () => {
    const permit = controlledPermit()
    const send = vi.fn(async () => {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
      permit.invalidate()
      return new Response(JSON.stringify({
        capability: 'A'.repeat(43),
        byteLength: body.byteLength,
        expiresAt: 1_900_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    })

    await expect(transferSelectedCompanionAttachment({
      name: 'background.bin',
      type: 'application/octet-stream',
      arrayBuffer: async () => Uint8Array.of(4, 5, 6).buffer,
    }, transferOptions(permit, fetch, send))).rejects.toThrow(/connection generation/)
    expect(fetch).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it('reports uncertain delivery without resending when the connection is replaced during send', async () => {
    const permit = controlledPermit()
    const send = vi.fn(async () => { permit.invalidate() })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
      return new Response(JSON.stringify({
        capability: 'A'.repeat(43),
        byteLength: body.byteLength,
        expiresAt: 1_900_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    })

    const transfer = transferSelectedCompanionAttachment({
      name: 'uncertain.bin',
      type: 'application/octet-stream',
      arrayBuffer: async () => Uint8Array.of(7, 8, 9).buffer,
    }, transferOptions(permit, fetch, send))

    await expect(transfer).rejects.toMatchObject({
      name: 'CompanionAttachmentDeliveryUncertainError',
      code: 'COMPANION_ATTACHMENT_DELIVERY_UNCERTAIN',
      operationId: parseCompanionOperationId('operation-race'),
    } satisfies Partial<CompanionAttachmentDeliveryUncertainError>)
    expect(send).toHaveBeenCalledOnce()
  })
})

function readyPermit() {
  return { isCurrent: () => true, requireCurrent: () => {} }
}

function blockedPermit() {
  return {
    isCurrent: () => true,
    requireCurrent: () => { throw new Error('Companion attachment requires foreground synchronization') },
  }
}

function controlledPermit() {
  let current = true
  return {
    invalidate: () => { current = false },
    isCurrent: () => current,
    requireCurrent: () => {
      if (!current) throw new Error('Companion attachment connection generation is no longer current')
    },
  }
}

function transferOptions(
  permit: { isCurrent(): boolean; requireCurrent(): void },
  fetch: typeof globalThis.fetch,
  send: (offer: CompanionOfferAttachmentOperation) => Promise<void>,
) {
  return {
    attachmentKey,
    origin: 'https://platform.example',
    authorizationHeaders: { authorization: 'Bearer opaque-current-installation-proof' },
    operationId: parseCompanionOperationId('operation-race'),
    sessionId: parseCompanionSessionId('session-one'),
    permit,
    fetch,
    send,
  }
}
