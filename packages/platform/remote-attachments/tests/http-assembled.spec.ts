import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAttachmentBlobReservationId, parsePersonalPairingId, RemoteAccessError } from '@deepseek-ai/dsh-remote-access'
import {
  deriveCompanionAttachmentKey,
  openCompanionAttachment,
  parseCompanionOperationId,
  parseCompanionSessionId,
  sealCompanionAttachment,
  type CompanionOfferAttachmentOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  RemoteAttachmentError,
  RemoteAttachmentStoreProvider,
  type RemoteAttachmentQuotaReservation,
  type RemoteAttachmentStoreOptions,
} from '../src/index.ts'
import { apply } from '../src/http.ts'
import {
  downloadCompanionAttachment,
  receiveCompanionAttachment,
} from '../../../../apps/desktop/src/companion-attachments.ts'
import { handleCompanionProductOperation } from '../../../../apps/desktop/src/companion-product.ts'
import {
  COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES,
  buildCompanionAttachmentOffer,
  sealCompanionAttachment as mobileSeal,
  transferSelectedCompanionAttachment,
} from '../../../../apps/mobile/src/companion-attachment.ts'

interface RegisteredRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const closeServers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

const pairingA = parsePersonalPairingId('pairing-a')
const attachmentKey = crypto.getRandomValues(new Uint8Array(32))
const ready = { isCurrent: () => true, requireCurrent: () => {} }

describe('Remote attachment HTTP assembled transfer', () => {
  it.each([
    ['binary', 'archive.bin', Uint8Array.of(0, 255, 1, 128, 64, 32)],
    ['image', 'pixel.png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
    ['text', 'notes.txt', new TextEncoder().encode('attachment plaintext for session submission')],
  ])('moves selected %s bytes through real HTTP and submits exact bytes while Platform retains only ciphertext', async (
    kind,
    fileName,
    plaintext,
  ) => {
    const { origin, store, responses } = await start()
    const sent: CompanionOfferAttachmentOperation[] = []
    const offer = await transferSelectedCompanionAttachment({
      name: fileName,
      type: kind === 'image' ? 'image/png' : kind === 'text' ? 'text/plain' : 'application/octet-stream',
      arrayBuffer: async () => plaintext.slice().buffer,
    }, {
      attachmentKey,
      origin: 'https://platform.example',
      authorizationHeaders: { 'x-test-pairing': 'pairing-a' },
      operationId: parseCompanionOperationId(`operation-${kind}`),
      sessionId: parseCompanionSessionId('session-one'),
      permit: ready,
      fetch: async (url, init) => {
        const requested = new URL(url instanceof Request ? url.url : url)
        return await fetch(new URL(requested.pathname, origin), init)
      },
      send: async (current) => { sent.push(current) },
    })
    expect(sent).toEqual([offer])
    expect(JSON.stringify(offer)).not.toContain(Buffer.from(plaintext).toString('base64'))

    const [retained] = store.observe()
    if (retained === undefined) throw new Error('uploaded blob was not retained')
    expect(containsBytes(retained.ciphertext, plaintext)).toBe(false)
    expect(retained.pairingId).toBe(pairingA)

    const submitted: Array<{
      sessionId: string
      operationId: string
      fileName: string
      mediaType: string
      plaintext: Uint8Array
    }> = []
    const result = await handleCompanionProductOperation(offer, {
      host: { call: async () => { throw new Error('attachment must not become a Host prompt') } },
      pairingId: pairingA,
      attachmentKey,
      now: () => offer.expiresAt - 1,
      generation: 1,
      desktopRevision: 1,
      desktopName: 'Assembled Desktop',
      resolveInteraction: () => undefined,
      pendingInteractions: () => [],
      downloadAttachment: async current => await downloadCompanionAttachment(current, {
        pairingId: pairingA,
        origin,
        headers: { 'x-test-pairing': 'pairing-a' },
      }),
      submitAttachment: async (attachment) => {
        submitted.push(attachment)
        return { ok: true, value: { accepted: true } }
      },
    })
    expect(result).toMatchObject({ type: 'confirmed', operationId: offer.operationId })
    expect(submitted).toEqual([{
      sessionId: offer.sessionId, operationId: offer.operationId,
      fileName, mediaType: offer.mediaType, plaintext,
    }])
    expect(JSON.stringify(submitted)).not.toContain(`Attached: ${fileName}`)
    expect(store.observe()).toHaveLength(0)
    for (const served of responses) {
      expect(containsBytes(served, plaintext)).toBe(false)
    }
  })

  it('fails explicitly on cross-pairing consume, hash mismatch, interruption, expiry, and limit violations', async () => {
    const { origin } = await start()
    const permit = { isCurrent: () => true, requireCurrent: () => {} }
    const sealed = await mobileSeal(attachmentKey, new TextEncoder().encode('second transfer'), permit)

    const upload = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: sealed.ciphertext,
    })
    const grant = await upload.json() as { capability: string; byteLength: number; expiresAt: number }
    const offer = buildCompanionAttachmentOffer({
      capability: grant.capability as never,
      ciphertextSha256: sealed.ciphertextSha256,
      byteLength: grant.byteLength,
      expiresAt: grant.expiresAt,
      fileName: 'notes.txt',
      mediaType: 'text/plain',
    }, 'operation-two' as never, 'session-one' as never, permit)

    const crossPairing = await fetch(`${origin}/v1/remote-attachments/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-b' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    expect(crossPairing.status).toBe(403)
    expect(await errorBody(crossPairing)).toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })

    await expect(receiveCompanionAttachment({ ...offer, ciphertextSha256: '0'.repeat(64) }, {
      pairingId: pairingA,
      attachmentKey,
      now: grant.expiresAt - 1,
      download: async () => sealed.ciphertext,
      submit: () => { throw new Error('hash mismatch must never submit') },
    })).rejects.toMatchObject({ reason: 'hash-mismatch' })

    await expect(receiveCompanionAttachment(offer, {
      pairingId: pairingA,
      attachmentKey,
      now: grant.expiresAt - 1,
      download: () => Promise.reject(new Error('socket hang up')),
      submit: () => { throw new Error('interrupted transfer must never submit') },
    })).rejects.toMatchObject({ reason: 'transfer-interrupted' })

    await expect(receiveCompanionAttachment(offer, {
      pairingId: pairingA,
      attachmentKey,
      now: grant.expiresAt,
      download: async () => sealed.ciphertext,
      submit: () => { throw new Error('expired capability must never submit') },
    })).rejects.toMatchObject({ reason: 'expired' })

    const oversized = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: new Uint8Array(16 * 1_024 * 1_024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(await errorBody(oversized)).toMatchObject({ code: 'ATTACHMENT_LIMIT_EXCEEDED' })

    const empty = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: new Uint8Array(0),
    })
    expect(empty.status).toBe(400)
    expect(await errorBody(empty)).toMatchObject({ code: 'ATTACHMENT_EMPTY' })

    const unknown = await fetch(`${origin}/v1/remote-attachments/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-a' },
      body: JSON.stringify({ capability: 'A'.repeat(43) }),
    })
    expect(unknown.status).toBe(404)
    expect(await errorBody(unknown)).toMatchObject({ code: 'ATTACHMENT_CAPABILITY_INVALID' })
  })

  it('removes the blob and capability after revocation before any consume', async () => {
    const { origin, store } = await start()
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(1, 2, 3), ready)
    const upload = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: sealed.ciphertext,
    })
    const grant = await upload.json() as { capability: string }
    const revoked = await fetch(`${origin}/v1/remote-attachments/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-a' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    expect(revoked.status).toBe(204)
    expect(store.observe()).toHaveLength(0)
    const consume = await fetch(`${origin}/v1/remote-attachments/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-a' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    expect(consume.status).toBe(404)
  })

  it('rejects cross-pairing revocation without deleting the blob', async () => {
    const { origin, store } = await start()
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(1, 2, 3), ready)
    const upload = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: sealed.ciphertext,
    })
    const grant = await upload.json() as { capability: string }
    const cross = await fetch(`${origin}/v1/remote-attachments/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-b' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    expect(cross.status).toBe(403)
    expect(await errorBody(cross)).toMatchObject({ code: 'ATTACHMENT_PAIRING_MISMATCH' })
    expect(store.observe()).toHaveLength(1)
  })

  it('accepts plaintext that seals to the ciphertext ceiling and rejects one extra byte before encrypting', async () => {
    const limit = 64
    const { origin } = await start({ store: { maxBlobBytes: limit } })
    const accepted = await mobileSeal(attachmentKey, new Uint8Array(limit - COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES), ready, limit)
    expect(accepted.ciphertext.byteLength).toBe(limit)
    const upload = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: accepted.ciphertext,
    })
    expect(upload.status).toBe(201)
    await expect(mobileSeal(attachmentKey, new Uint8Array(limit - COMPANION_ATTACHMENT_SEAL_OVERHEAD_BYTES + 1), ready, limit))
      .rejects.toThrow('ciphertext blob ceiling')
  })

  it('keeps the blob when consume fails mid-write so a second consume succeeds', async () => {
    const { routes, store } = await start()
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(9, 8, 7), ready)
    const uploadRoute = routes.get('/v1/remote-attachments')
    if (uploadRoute === undefined) throw new Error('upload route was not registered')
    const uploadResponse = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [new Uint8Array(sealed.ciphertext)]),
      uploadResponse.res,
    )
    const grant = JSON.parse(new TextDecoder().decode(concatBytes(uploadResponse.body))) as { capability: string }
    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (consumeRoute === undefined) throw new Error('consume route was not registered')
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      failingResponse('mid-write failure').res,
    )
    expect(store.observe()).toHaveLength(1)
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      failingResponse(new Error('mid-write failure')).res,
    )
    expect(store.observe()).toHaveLength(1)
    const retry = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      retry.res,
    )
    expect(retry.status).toBe(200)
    expect(concatBytes(retry.body)).toEqual(sealed.ciphertext)
    expect(store.observe()).toHaveLength(0)
  })

  it('abandons a claimed blob when the response closes before finish', async () => {
    const { routes, store } = await start()
    const uploadRoute = routes.get('/v1/remote-attachments')
    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (uploadRoute === undefined || consumeRoute === undefined) throw new Error('attachment routes were not registered')
    const upload = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [Uint8Array.of(1, 2, 3)]),
      upload.res,
    )
    const grant = JSON.parse(new TextDecoder().decode(concatBytes(upload.body))) as { capability: string }

    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      prematurelyClosedResponse().res,
    )

    expect(store.observe()).toHaveLength(1)
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      closedAfterFinishResponse().res,
    )
    expect(store.observe()).toHaveLength(0)
  })

  it('admits only one concurrent HTTP consume while the winning response remains in flight', async () => {
    const { routes } = await start()
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(3, 2, 1), ready)
    const uploadRoute = routes.get('/v1/remote-attachments')
    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (uploadRoute === undefined || consumeRoute === undefined) throw new Error('attachment routes were not registered')
    const upload = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [sealed.ciphertext]),
      upload.res,
    )
    const grant = JSON.parse(new TextDecoder().decode(concatBytes(upload.body))) as { capability: string }
    const request = (): IncomingMessage => streamingRequest(
      { 'x-test-pairing': 'pairing-a' },
      [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
    )
    const first = heldResponse()
    const firstConsume = consumeRoute.handler(request(), first.res)
    await first.written
    const second = stubResponse()
    await consumeRoute.handler(request(), second.res)

    const statuses = [first.status, second.status].sort()
    first.finish()
    await firstConsume
    expect(statuses).toEqual([200, 404])
  })

  it('never replays a delivered body when consume settlement cleanup fails', async () => {
    const { routes, store } = await start()
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(4, 5, 6), ready)
    const uploadRoute = routes.get('/v1/remote-attachments')
    if (uploadRoute === undefined) throw new Error('upload route was not registered')
    const uploadResponse = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [new Uint8Array(sealed.ciphertext)]),
      uploadResponse.res,
    )
    const grant = JSON.parse(new TextDecoder().decode(concatBytes(uploadResponse.body))) as { capability: string }
    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (consumeRoute === undefined) throw new Error('consume route was not registered')
    const consume = store.consume.bind(store)
    vi.spyOn(store, 'consume').mockImplementationOnce(async (input) => {
      const claimed = await consume(input)
      return { ...claimed, complete: async () => { throw new Error('settlement cleanup failed') } }
    })
    const first = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      first.res,
    )
    expect(first.status).toBe(200)
    expect(concatBytes(first.body)).toEqual(sealed.ciphertext)
    expect(store.observe()).toHaveLength(0)
    const retry = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      retry.res,
    )
    expect(retry.status).toBe(404)
    expect(store.observe()).toHaveLength(0)
  })

  it('keeps a foreign pairing key unable to open another pairing seal', async () => {
    const key = await deriveCompanionAttachmentKey(attachmentKey)
    const sealed = await sealCompanionAttachment(key, new TextEncoder().encode('pairing secret'))
    await expect(openCompanionAttachment(
      await deriveCompanionAttachmentKey(crypto.getRandomValues(new Uint8Array(32))),
      sealed.ciphertext,
    )).rejects.toThrow()
  })

  it('answers CORS preflight and rejects untrusted origins and wrong methods on every route', async () => {
    const { origin } = await start()
    const paths = ['/v1/remote-attachments', '/v1/remote-attachments/consume', '/v1/remote-attachments/revoke']
    for (const path of paths) {
      const preflight = await fetch(`${origin}${path}`, {
        method: 'OPTIONS',
        headers: { origin: 'https://mobile.example' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://mobile.example')
      const get = await fetch(`${origin}${path}`, { method: 'GET' })
      expect(get.status).toBe(405)
      expect(await errorBody(get)).toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
      const denied = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'x-test-pairing': 'pairing-a' },
      })
      expect(denied.status).toBe(403)
      expect(await errorBody(denied)).toMatchObject({ code: 'ORIGIN_DENIED' })
      const malformed = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { origin: 'not a url', 'x-test-pairing': 'pairing-a' },
      })
      expect(malformed.status).toBe(403)
    }
    const trusted = await fetch(`${origin}/v1/remote-attachments/revoke`, {
      method: 'POST',
      headers: {
        origin: 'https://mobile.example',
        'content-type': 'application/json',
        'x-test-pairing': 'pairing-a',
      },
      body: JSON.stringify({ capability: 'A'.repeat(43) }),
    })
    expect(trusted.status).toBe(204)
    expect(trusted.headers.get('access-control-allow-origin')).toBe('https://mobile.example')
  })

  it('answers encrypted attachment preflight for both shipped Capacitor origins', async () => {
    const { origin } = await start({
      origins: ['https://mobile.example', 'https://localhost', 'capacitor://localhost'],
    })
    for (const clientOrigin of ['https://localhost', 'capacitor://localhost']) {
      const response = await fetch(`${origin}/v1/remote-attachments`, {
        method: 'OPTIONS',
        headers: { origin: clientOrigin, 'access-control-request-method': 'POST' },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe(clientOrigin)
    }
  })

  it('rejects malformed, non-object, and oversized JSON bodies and non-canonical capabilities', async () => {
    const { origin } = await start()
    const headers = { 'content-type': 'application/json', 'x-test-pairing': 'pairing-a' }
    const consume = async (body: string): Promise<Response> =>
      await fetch(`${origin}/v1/remote-attachments/consume`, { method: 'POST', headers, body })
    expect((await consume('not json')).status).toBe(400)
    expect((await consume('[1,2]')).status).toBe(400)
    expect((await consume(JSON.stringify({ capability: 7 }))).status).toBe(400)
    const nonCanonical = await consume(JSON.stringify({ capability: `${'A'.repeat(42)}B` }))
    expect(nonCanonical.status).toBe(400)
    expect(await errorBody(nonCanonical)).toMatchObject({ code: 'BODY_INVALID' })
    const oversized = await consume(JSON.stringify({ capability: 'A'.repeat(43), padding: 'x'.repeat(8 * 1_024) }))
    expect(oversized.status).toBe(413)
    expect(await errorBody(oversized)).toMatchObject({ code: 'BODY_TOO_LARGE' })

    const { routes } = await start()
    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (consumeRoute === undefined) throw new Error('consume route was not registered')
    const missingLength = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: 'A'.repeat(43) }))],
        { contentLength: false },
      ),
      missingLength.res,
    )
    expect(missingLength.status).toBe(404)
    const streamedOversize = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a', 'content-length': '1' },
        [new Uint8Array(5 * 1_024)],
      ),
      streamedOversize.res,
    )
    expect(streamedOversize.status).toBe(413)
  })

  it('maps expiry, capacity, and unexpected failures to explicit HTTP statuses', async () => {
    const shortLived = await start({ store: { capabilityLifetimeMs: 1 } })
    const sealed = await mobileSeal(attachmentKey, Uint8Array.of(1, 2, 3), ready)
    const upload = await fetch(`${shortLived.origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: sealed.ciphertext,
    })
    const grant = await upload.json() as { capability: string }
    await new Promise(resolve => setTimeout(resolve, 5))
    const expired = await fetch(`${shortLived.origin}/v1/remote-attachments/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-pairing': 'pairing-a' },
      body: JSON.stringify({ capability: grant.capability }),
    })
    expect(expired.status).toBe(410)
    expect(await errorBody(expired)).toMatchObject({ code: 'ATTACHMENT_EXPIRED' })

    const crowded = await start({ store: { maxRetainedBlobs: 1 } })
    const first = await mobileSeal(attachmentKey, Uint8Array.of(1), ready)
    await fetch(`${crowded.origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: first.ciphertext,
    })
    const second = await mobileSeal(attachmentKey, Uint8Array.of(2), ready)
    const overCapacity = await fetch(`${crowded.origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: second.ciphertext,
    })
    expect(overCapacity.status).toBe(503)
    expect(await errorBody(overCapacity)).toMatchObject({ code: 'ATTACHMENT_CAPACITY' })

    const exploded = await fetch(`${crowded.origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'explode' },
      body: second.ciphertext,
    })
    expect(exploded.status).toBe(500)
    expect(await errorBody(exploded)).toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('admits the product upload through Remote Access quota and preserves capacity retry guidance', async () => {
    const admit = vi.fn(async () => {
      throw new RemoteAccessError('PLATFORM_CAPACITY', 'Platform attachment capacity is full', 7)
    })
    const { origin } = await start({ admit })
    const response = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: Uint8Array.of(1, 2, 3),
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(await errorBody(response)).toMatchObject({ code: 'PLATFORM_CAPACITY' })
    expect(admit).toHaveBeenCalledWith(3)
  })

  it('preserves non-capacity Remote Access failures as conflicts', async () => {
    const { origin } = await start({
      admit: async () => {
        throw new RemoteAccessError('PAIRING_PENDING_INVALID', 'Pairing is unavailable')
      },
    })
    const response = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: Uint8Array.of(1),
    })

    expect(response.status).toBe(409)
    expect(await errorBody(response)).toMatchObject({ code: 'PAIRING_PENDING_INVALID' })
  })

  it.each([
    ['class error', new RemoteAttachmentError('PLATFORM_CAPACITY', 'Attachment capacity is full', 9)],
    ['structural error', { code: 'ATTACHMENT_EMPTY', message: 'Attachment body is empty' }],
  ])('projects a %s from a durable store', async (_label, failure) => {
    const { origin, store } = await start()
    vi.spyOn(store, 'publish').mockRejectedValueOnce(failure)
    const response = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-pairing': 'pairing-a' },
      body: Uint8Array.of(1),
    })

    expect(response.status).toBe(failure instanceof RemoteAttachmentError ? 429 : 400)
    expect(await errorBody(response)).toMatchObject({ code: failure.code })
    if (failure instanceof RemoteAttachmentError) expect(response.headers.get('retry-after')).toBe('9')
  })

  it('accepts non-Buffer stream chunks at the HTTP boundary', async () => {
    const { routes } = await start()
    const sealed = await mobileSeal(attachmentKey, new TextEncoder().encode('streamed plaintext'), ready)
    const uploadRoute = routes.get('/v1/remote-attachments')
    if (uploadRoute === undefined) throw new Error('upload route was not registered')
    const uploadResponse = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [new Uint8Array(sealed.ciphertext)]),
      uploadResponse.res,
    )
    expect(uploadResponse.status).toBe(201)
    const grant = JSON.parse(new TextDecoder().decode(concatBytes(uploadResponse.body))) as { capability: string }

    const consumeRoute = routes.get('/v1/remote-attachments/consume')
    if (consumeRoute === undefined) throw new Error('consume route was not registered')
    const consumeResponse = stubResponse()
    await consumeRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [new TextEncoder().encode(JSON.stringify({ capability: grant.capability }))],
      ),
      consumeResponse.res,
    )
    expect(consumeResponse.status).toBe(200)
    expect(concatBytes(consumeResponse.body)).toEqual(sealed.ciphertext)
  })

  it('requires a positive exact upload content-length before quota admission or body reads', async () => {
    const release = vi.fn(async () => {})
    let admitted = false
    const admit = vi.fn(async () => {
      admitted = true
      return { id: parseAttachmentBlobReservationId('quota-exact'), expiresAt: Number.MAX_SAFE_INTEGER, release }
    })
    const { routes, store } = await start({ store: { maxBlobBytes: 8 }, admit })
    const uploadRoute = routes.get('/v1/remote-attachments')
    if (uploadRoute === undefined) throw new Error('upload route was not registered')

    const missing = stubResponse()
    let missingPulled = false
    await uploadRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a' },
        [Uint8Array.of(1)],
        { contentLength: false, onPull: () => { missingPulled = true } },
      ),
      missing.res,
    )
    expect(missing.status).toBe(411)
    expect(missingPulled).toBe(false)
    expect(admit).not.toHaveBeenCalled()

    const empty = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a' }, [], { contentLength: false }),
      empty.res,
    )
    expect(empty.status).toBe(411)

    const zero = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a', 'content-length': '0' }, []),
      zero.res,
    )
    expect(zero.status).toBe(400)
    expect(admit).not.toHaveBeenCalled()

    const invalidLengths: Array<string | string[]> = [['1', '2'], '+1', '9007199254740992']
    for (const invalidLength of invalidLengths) {
      const invalid = stubResponse()
      const request = streamingRequest({ 'x-test-pairing': 'pairing-a' }, [Uint8Array.of(1)])
      Object.assign(request.headers, { 'content-length': invalidLength })
      await uploadRoute.handler(
        request,
        invalid.res,
      )
      expect(invalid.status).toBe(400)
    }

    const short = stubResponse()
    await uploadRoute.handler(
      streamingRequest(
        { 'x-test-pairing': 'pairing-a', 'content-length': '3' },
        [Uint8Array.of(1, 2)],
        { onPull: () => { expect(admitted).toBe(true) } },
      ),
      short.res,
    )
    expect(short.status).toBe(400)
    expect(admit).toHaveBeenCalledWith(3)
    expect(release).toHaveBeenCalledOnce()
    expect(store.observe()).toHaveLength(0)

    const long = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a', 'content-length': '2' }, [Uint8Array.of(1, 2, 3)]),
      long.res,
    )
    expect(long.status).toBe(400)
    expect(release).toHaveBeenCalledTimes(2)

    const tooLarge = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a', 'content-length': '9' }, [new Uint8Array(9)]),
      tooLarge.res,
    )
    expect(tooLarge.status).toBe(413)
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it('preserves an upload read failure when rejected-body quota cleanup also fails', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { routes } = await start({
      admit: async () => ({
        id: parseAttachmentBlobReservationId('quota-read-failure'),
        expiresAt: Number.MAX_SAFE_INTEGER,
        release: async () => { throw new Error('quota cleanup failed') },
      }),
    })
    const uploadRoute = routes.get('/v1/remote-attachments')
    if (uploadRoute === undefined) throw new Error('upload route was not registered')
    const response = stubResponse()
    await uploadRoute.handler(
      streamingRequest({ 'x-test-pairing': 'pairing-a', 'content-length': '2' }, [Uint8Array.of(1)]),
      response.res,
    )

    expect(response.status).toBe(400)
    expect(reported).toHaveBeenCalledWith(
      '[remote-attachments-http] quota release after rejected upload failed:',
      expect.objectContaining({ message: 'quota cleanup failed' }),
    )
    reported.mockRestore()
  })

  it('fails loud when the configured browser origin is not a URL', () => {
    expect(() => { apply({} as Context, { origins: ['not a URL'] }) }).toThrow()
  })
})

async function errorBody(response: Response): Promise<{ code: string }> {
  const body = await response.json() as { error: { code: string } }
  return body.error
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return true
  }
  return false
}

function streamingRequest(
  headers: IncomingMessage['headers'],
  chunks: Uint8Array[],
  options: { contentLength?: boolean; onPull?: () => void } = {},
): IncomingMessage {
  const requestHeaders: IncomingMessage['headers'] = { ...headers }
  if (options.contentLength !== false && requestHeaders['content-length'] === undefined) {
    requestHeaders['content-length'] = String(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  }
  return {
    headers: requestHeaders,
    method: 'POST',
    async * [Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        options.onPull?.()
        yield chunk
      }
    },
  } as unknown as IncomingMessage
}

function stubResponse(): { res: ServerResponse; status: number; body: Uint8Array[] } {
  const holder: { res: ServerResponse; status: number; body: Uint8Array[] } = {
    status: 0,
    body: [],
    res: undefined as never,
  }
  const state = { headersSent: false, writableFinished: false }
  const emitter = new EventEmitter()
  Object.assign(emitter, {
    writeHead(status: number) {
      holder.status = status
      state.headersSent = true
      return emitter
    },
    setHeader() { return emitter },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') holder.body.push(new TextEncoder().encode(chunk))
      else if (chunk instanceof Uint8Array) holder.body.push(chunk)
      state.writableFinished = true
      queueMicrotask(() => { emitter.emit('finish') })
      return emitter
    },
  })
  Object.defineProperty(emitter, 'headersSent', { get() { return state.headersSent } })
  Object.defineProperty(emitter, 'writableFinished', { get() { return state.writableFinished } })
  holder.res = emitter as unknown as ServerResponse
  return holder
}

function failingResponse(failure: unknown = new Error('mid-write failure')): { res: ServerResponse } {
  const state = { headersSent: false, ended: false }
  const emitter = new EventEmitter()
  Object.assign(emitter, {
    writableFinished: false,
    writeHead() {
      state.headersSent = true
      return emitter
    },
    setHeader() { return emitter },
    end() {
      if (state.ended) return emitter
      state.ended = true
      throw failure
    },
  })
  Object.defineProperty(emitter, 'headersSent', { get() { return state.headersSent } })
  return { res: emitter as unknown as ServerResponse }
}

function prematurelyClosedResponse(): { res: ServerResponse } {
  const emitter = new EventEmitter()
  Object.assign(emitter, {
    writableFinished: false,
    writeHead() { return emitter },
    setHeader() { return emitter },
    end() { queueMicrotask(() => { emitter.emit('close') }); return emitter },
  })
  Object.defineProperty(emitter, 'headersSent', { get() { return true } })
  return { res: emitter as unknown as ServerResponse }
}

function closedAfterFinishResponse(): { res: ServerResponse } {
  const state = { writableFinished: false }
  const emitter = new EventEmitter()
  Object.assign(emitter, {
    writeHead() { return emitter },
    setHeader() { return emitter },
    end() {
      state.writableFinished = true
      queueMicrotask(() => { emitter.emit('close') })
      return emitter
    },
  })
  Object.defineProperty(emitter, 'headersSent', { get() { return true } })
  Object.defineProperty(emitter, 'writableFinished', { get() { return state.writableFinished } })
  return { res: emitter as unknown as ServerResponse }
}

function heldResponse(): {
  res: ServerResponse
  status: number
  written: Promise<void>
  finish(): void
} {
  let resolveWritten!: () => void
  const written = new Promise<void>((resolve) => { resolveWritten = resolve })
  const holder: { status: number; res: ServerResponse; written: Promise<void>; finish(): void } = {
    status: 0,
    res: undefined as never,
    written,
    finish: () => {},
  }
  const emitter = new EventEmitter()
  Object.assign(emitter, {
    writeHead(status: number) { holder.status = status; return emitter },
    setHeader() { return emitter },
    end() { resolveWritten(); return emitter },
  })
  Object.defineProperty(emitter, 'headersSent', { get() { return holder.status !== 0 } })
  holder.finish = () => { emitter.emit('finish') }
  holder.res = emitter as unknown as ServerResponse
  return holder
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function start(options: {
  store?: Partial<RemoteAttachmentStoreOptions>
  admit?: (bytes: number) => Promise<RemoteAttachmentQuotaReservation>
  origins?: string[]
} = {}): Promise<{
  origin: string
  store: RemoteAttachmentStoreProvider
  responses: Uint8Array[]
  routes: Map<string, RegisteredRoute>
}> {
  const routes = new Map<string, RegisteredRoute>()
  const responses: Uint8Array[] = []
  const ctx = new Context()
  const store = new RemoteAttachmentStoreProvider(ctx, {
    maxBlobBytes: 16 * 1_024 * 1_024,
    maxRetainedBlobs: 16,
    sweepIntervalMs: 60_000,
    schedule: () => ({ unref: vi.fn(), cancel: vi.fn() }),
    ...options.store,
  })
  const fake = {
    remoteAttachments: store,
    remoteAttachmentAuthority: {
      authenticate: async ({ headers }: { headers: IncomingMessage['headers'] }) => {
        const value = headers['x-test-pairing'] ?? headers['x-gestalt-pairing-id']
        if (typeof value !== 'string') throw new Error('pairing header is required')
        if (value === 'explode') throw new Error('authority exploded')
        return {
          pairingId: parsePersonalPairingId(value),
          admit: options.admit ?? (async () => ({
            id: parseAttachmentBlobReservationId(crypto.randomUUID()),
            expiresAt: Number.MAX_SAFE_INTEGER,
            release: async () => {},
          })),
        }
      },
    },
    webServer: {
      register(route: RegisteredRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect(register: () => () => void) { register() },
  } as unknown as Context
  apply(fake, { origins: options.origins ?? ['https://mobile.example'] })
  const http = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (route === undefined) { res.writeHead(404).end(); return }
    const originalWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean
    const originalEnd = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => unknown
    const capture = (chunk: unknown): void => {
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) responses.push(new Uint8Array(chunk))
    }
    res.write = (chunk: unknown, ...rest: unknown[]) => {
      capture(chunk)
      return originalWrite(chunk, ...rest)
    }
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      capture(chunk)
      return originalEnd(chunk, ...rest)
    }) as unknown as typeof res.end
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Remote Attachments test server did not bind')
  closeServers.push(async () => {
    await new Promise<void>((resolve, reject) => {
      http.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    await store.dispose()
  })
  return { origin: `http://127.0.0.1:${String(address.port)}`, store, responses, routes }
}
