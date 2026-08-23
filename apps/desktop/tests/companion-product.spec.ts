import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  deriveCompanionAttachmentKey,
  parseCompanionOperationId,
  parseCompanionInteractionId,
  parseCompanionSessionId,
  REMOTE_PROTOCOL_LIMITS,
  sealCompanionAttachment,
  type CompanionOfferAttachmentOperation,
  type CompanionSearchSessionsOperation,
  type CompanionOperation,
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
  it('projects a bounded real Host Session and Workspace surface', async () => {
    const calls: string[] = []
    const dependencies = baseDependencies(hostRpc(async (method) => {
      calls.push(method)
      if (method === 'session.list') return { ok: true, value: { items: [{
        sessionId: 'session-product', updatedAt: 9, running: false, blank: false,
        cwd: '/work', projections: { asOfSeq: 1, values: { title: 'Real session' } },
      }] } }
      if (method === 'workspace.list') return { ok: true, value: { items: [{
        workspaceId: 'workspace-product', path: '/work', title: 'Work',
        sessionIds: ['session-product'], createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      }], archivedSessionIds: [] } }
      throw new Error(`unexpected Host method ${method}`)
    }))
    const operation = op({ type: 'refresh-surface' })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'surface-snapshot', operationId: operation.operationId,
      sessions: [{ sessionId, displayTitle: 'Real session', cwd: '/work' }],
      workspaces: [{ workspaceId: 'workspace-product', sessionIds: [sessionId] }],
    })
    expect(calls).toEqual(['session.list', 'workspace.list'])
  })

  it('projects Host history into the shared conversation carrier', async () => {
    const dependencies = baseDependencies(hostRpc(async (method) => {
      expect(method).toBe('session.history')
      return { ok: true, value: {
        events: [
          { event: { type: 'user/message', seq: 1, time: 10, data: {
            id: 'message-user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
          } } },
          { event: { type: 'assistant/message', seq: 2, time: 20, data: {
            turn: 1, step: 1, message: {
              id: 'message-assistant', role: 'assistant', content: [{ type: 'text', text: 'world' }],
              source: { kind: 'assistant' },
            },
          } } },
        ],
        hasMore: false,
      } }
    }))
    const operation = op({ type: 'load-history', sessionId, maxMessages: 20 })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'conversation-snapshot', operationId: operation.operationId, sessionId,
      conversation: {
        nodes: [
          { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hello' }] },
          { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'world' }] },
        ],
        hasMore: false,
      },
    })
  })

  it('submits and cancels through exact Host methods with correlated receipts', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const dependencies = baseDependencies(hostRpc(async (method, payload) => {
      calls.push([method, payload])
      return { ok: true, value: { accepted: true } }
    }))
    const submit = op({ type: 'submit-prompt', sessionId, text: 'continue' })
    const cancel = op({ type: 'cancel-session', sessionId })
    await expect(handleCompanionProductOperation(submit, dependencies)).resolves.toMatchObject({
      type: 'confirmed', operationId: submit.operationId,
    })
    await expect(handleCompanionProductOperation(cancel, dependencies)).resolves.toMatchObject({
      type: 'confirmed', operationId: cancel.operationId,
    })
    expect(calls).toEqual([
      ['session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'continue' }] }],
      ['session.cancel', { sessionId }],
    ])
  })

  it('settles pairing-private Approval and Ask User requests through Host respond', async () => {
    const respond = vi.fn<NonNullable<DesktopHostRpc['respond']>>(async () => ({ accepted: true }))
    const host = hostRpc(async () => { throw new Error('settlement must not use an arbitrary Host method') }, respond)
    const dependencies = baseDependencies(host)
    const interactionId = parseCompanionInteractionId('interaction-product')
    dependencies.resolveInteraction = () => ({
      rpcId: 'host-request-private', kind: 'approval', sessionId,
      approvalId: 'approval-product',
    })
    const operation = op({
      type: 'settle-interaction', sessionId, interactionId,
      settlement: { kind: 'approval', outcome: 'allowed-once' },
    })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toEqual({
      type: 'interaction-receipt', operationId: operation.operationId, accepted: true,
    })
    expect(respond).toHaveBeenCalledWith('host-request-private', {
      ok: true,
      value: { sessionId, approvalId: 'approval-product', outcome: 'allowed-once' },
    })
  })

  it('returns exact historical image bytes as ordered chunks', async () => {
    const bytes = Uint8Array.of(0, 1, 2, 255)
    const dependencies = baseDependencies(hostRpc(async (method) => {
      expect(method).toBe('session.attachment')
      return { ok: true, value: {
        attachment: { id: 'image-product', mediaType: 'image/png', bytes: bytes.byteLength, sha256: '0'.repeat(64) },
        data: Buffer.from(bytes).toString('base64'),
      } }
    }))
    const operation = op({ type: 'read-image', sessionId, attachmentId: 'image-product' })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'image-chunk', operationId: operation.operationId, index: 0, count: 1,
      mediaType: 'image/png', data: 'AAEC_w',
    })
  })

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
      if (request.url === '/api/events.mux') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end()
        return
      }
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

function hostRpc(call: DesktopHostRpc['call'], respond?: DesktopHostRpc['respond']): DesktopHostRpc {
  return { call, ...(respond === undefined ? {} : { respond }) }
}

function baseDependencies(host: DesktopHostRpc) {
  return {
    host,
    pairingId,
    attachmentKey,
    now: () => 1_000,
    downloadAttachment: async () => { throw new Error('search must not download attachments') },
    submitAttachment: async () => { throw new Error('search must not submit attachments') },
    generation: 1,
    desktopRevision: 1,
    desktopName: 'Authenticated Desktop',
    resolveInteraction: () => undefined,
    pendingInteractions: () => [],
  }
}

function op<T extends Omit<CompanionOperation, 'operationId'>>(operation: T): T & { operationId: ReturnType<typeof parseCompanionOperationId> } {
  return { ...operation, operationId: parseCompanionOperationId(`operation-${operation.type}`) }
}
