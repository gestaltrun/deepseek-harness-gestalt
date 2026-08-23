import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  deriveCompanionAttachmentKey,
  parseCompanionOperationId,
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  sealCompanionAttachment,
  type CompanionOfferAttachmentOperation,
  type CompanionSearchSessionsOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  DesktopCompanionProductOwner,
  handleCompanionProductOperation,
} from '../src/companion-product.ts'
import type { DesktopHostRpc, DesktopHostRpcResult } from '../src/host-rpc.ts'

const pairingId = parsePersonalPairingId('pairing-product')
const attachmentKey = crypto.getRandomValues(new Uint8Array(32))
const sessionId = parseCompanionSessionId('session-product')
const closeServers: Array<() => Promise<void>> = []

afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())) })

describe('Desktop Companion product operations', () => {
  it.each([
    ['binary', 'archive.bin', Uint8Array.of(0, 255, 1, 128)],
    ['image', 'pixel.png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
    ['text', 'notes.txt', new TextEncoder().encode('actual text attachment')],
  ])('downloads, verifies, decrypts, and submits actual %s bytes through the Session attachment path', async (
    kind,
    fileName,
    plaintext,
  ) => {
    const prepared = await offer(fileName, plaintext, `operation-${kind}`)
    const host = hostRpc(() => { throw new Error('attachment must not become a placeholder Host prompt') })
    const submitAttachment = vi.fn(async () => ({ ok: true, value: { accepted: true } } as const))
    const result = await handleCompanionProductOperation(prepared.operation, {
      host,
      pairingId,
      attachmentKey,
      now: () => 1_000,
      downloadAttachment: async () => prepared.ciphertext,
      submitAttachment,
    })

    expect(result).toMatchObject({ type: 'confirmed', operationId: prepared.operation.operationId })
    expect(submitAttachment).toHaveBeenCalledOnce()
    expect(submitAttachment.mock.calls[0]?.[0]).toEqual({
      sessionId, operationId: prepared.operation.operationId,
      fileName, mediaType: prepared.operation.mediaType, plaintext,
    })
    expect(JSON.stringify(submitAttachment.mock.calls)).not.toContain(`Attached: ${fileName}`)
  })

  it('returns explicit attachment rejection results for expiry and hash failure', async () => {
    const expired = await offer('expired.bin', Uint8Array.of(1), 'operation-expired')
    const hash = await offer('hash.bin', Uint8Array.of(2), 'operation-hash')
    const dependencies = {
      host: hostRpc(() => { throw new Error('rejected attachment must not call Host') }),
      pairingId,
      attachmentKey,
      now: () => 2_000,
      downloadAttachment: async () => hash.ciphertext,
      submitAttachment: async () => { throw new Error('rejected attachment must not submit') },
    }
    await expect(handleCompanionProductOperation(expired.operation, dependencies)).resolves.toEqual({
      type: 'attachment-rejected',
      operationId: expired.operation.operationId,
      reason: 'expired',
    })
    await expect(handleCompanionProductOperation({
      ...hash.operation,
      ciphertextSha256: '0'.repeat(64),
      expiresAt: 3_000,
    }, dependencies)).resolves.toEqual({
      type: 'attachment-rejected',
      operationId: hash.operation.operationId,
      reason: 'hash-mismatch',
    })
  })

  it('returns authoritative full-text hits and no-hit results without cached substring filtering', async () => {
    const operation = search('needle')
    const call = vi.fn(async (_method: string, payload: Record<string, unknown>): Promise<DesktopHostRpcResult> => {
      expect(payload).toEqual({ query: 'needle' })
      return {
        ok: true,
        value: {
          items: [{ sessionId: 'session-hit', snippet: 'Desktop indexed needle' }],
          hasMore: false,
        },
      }
    })
    const dependencies = baseDependencies({ call })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toEqual({
      type: 'session-search',
      operationId: operation.operationId,
      items: [{ sessionId: parseCompanionSessionId('session-hit'), snippet: 'Desktop indexed needle' }],
      hasMore: false,
    })
    call.mockResolvedValueOnce({ ok: true, value: { items: [], hasMore: false } })
    await expect(handleCompanionProductOperation(search('absent'), dependencies)).resolves.toMatchObject({
      type: 'session-search', items: [], hasMore: false,
    })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['disabled', { kind: 'business', code: 'internal', message: 'session search failed: SESSION_QUERY_SEARCH_DISABLED' }],
    ['index', { kind: 'business', code: 'internal', message: 'session search failed: SESSION_QUERY_INDEX_FAILED' }],
    ['http-400', { kind: 'http', code: 'HOST_HTTP_STATUS', message: 'Desktop Host returned HTTP 400', status: 400 }],
  ] as const)('projects %s Host search refusal without stream loss', async (_name, failure) => {
    const operation = search(_name)
    await expect(handleCompanionProductOperation(operation, baseDependencies({
      call: async () => ({ ok: false, failure }),
    }))).resolves.toEqual({ type: 'operation-failed', operationId: operation.operationId, failure })
  })

  it('installs the real Web Host RPC in the product owner and invalidates it on Host exit', async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string }
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: { items: [{ sessionId: 'session-real-entry', snippet: 'real Host result' }], hasMore: false },
          },
        }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    closeServers.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')
    const owner = new DesktopCompanionProductOwner({
      responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    })
    const uninstallReplaced = owner.installHost(`http://127.0.0.1:${String(address.port)}`)
    const uninstall = owner.installHost(`http://127.0.0.1:${String(address.port)}`)
    uninstallReplaced()

    await expect(owner.handle(search('entry'), baseDependencies(hostRpc(() => {
      throw new Error('owner must use its installed Host RPC')
    })))).resolves.toEqual({
      type: 'session-search',
      operationId: parseCompanionOperationId('search-entry'),
      items: [{ sessionId: parseCompanionSessionId('session-real-entry'), snippet: 'real Host result' }],
      hasMore: false,
    })
    uninstall()
    await expect(owner.handle(search('after-exit'), baseDependencies(hostRpc(() => {
      throw new Error('uninstalled owner must not call an injected Host')
    })))).resolves.toEqual({
      type: 'operation-failed',
      operationId: parseCompanionOperationId('search-after-exit'),
      failure: {
        kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Web Host is not available',
      },
    })
  })
})

async function offer(fileName: string, plaintext: Uint8Array, id: string): Promise<{
  operation: CompanionOfferAttachmentOperation
  ciphertext: Uint8Array
}> {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- tsc resolves CryptoKey via @types/node; oxlint misses that global
  const key = await deriveCompanionAttachmentKey(attachmentKey)
  const sealed = await sealCompanionAttachment(key, plaintext)
  return {
    ciphertext: sealed.ciphertext,
    operation: {
      type: 'offer-attachment',
      operationId: parseCompanionOperationId(id),
      sessionId,
      capability: 'A'.repeat(43) as never,
      ciphertextSha256: sealed.ciphertextSha256,
      byteLength: sealed.ciphertext.byteLength,
      expiresAt: 2_000,
      fileName,
      mediaType: 'application/octet-stream',
    },
  }
}

function search(query: string): CompanionSearchSessionsOperation {
  return {
    type: 'search-sessions',
    operationId: parseCompanionOperationId(`search-${query}`),
    query,
  }
}

function hostRpc(call: DesktopHostRpc['call']): DesktopHostRpc { return { call } }

function baseDependencies(host: DesktopHostRpc) {
  return {
    host,
    pairingId,
    attachmentKey,
    now: () => 1_000,
    downloadAttachment: async () => { throw new Error('search must not download attachments') },
    submitAttachment: async () => { throw new Error('search must not submit attachments') },
  }
}
