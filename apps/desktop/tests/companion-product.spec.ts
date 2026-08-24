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
  DesktopCompanionSurfaceDiscovery,
  DesktopCompanionProductOwner,
  handleCompanionProductOperation,
} from '../src/companion-product.ts'
import type { DesktopHostRpc, DesktopHostRpcResult } from '../src/host-rpc.ts'

const pairingId = parsePersonalPairingId('pairing-product')
const attachmentKey = crypto.getRandomValues(new Uint8Array(32))
const sessionId = parseCompanionSessionId('session-product')
const closeServers: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(closeServers.splice(0).map(close => close()))
})

describe('Desktop Companion product operations', () => {
  it('leases Host event streams only while authenticated live connections exist', async () => {
    const sockets: TestHostWebSocket[] = []
    class TestHostWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      readyState = TestHostWebSocket.CONNECTING
      readonly close = vi.fn(() => {
        this.readyState = 3
        this.dispatchEvent(new Event('close'))
      })
      constructor(readonly url: URL) {
        super()
        sockets.push(this)
      }
    }
    vi.stubGlobal('WebSocket', TestHostWebSocket)
    const owner = new DesktopCompanionProductOwner({
      timeoutMs: 100, responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    })
    const uninstall = owner.installHost('http://127.0.0.1:43123')
    expect(sockets).toHaveLength(0)
    const first = owner.connectLiveProjection(pairingId, () => {}, () => {})
    const second = owner.connectLiveProjection(pairingId, () => {}, () => {})
    expect(sockets).toHaveLength(2)

    first()
    expect(sockets.every(socket => socket.close.mock.calls.length === 0)).toBe(true)
    second()
    expect(sockets.every(socket => socket.close.mock.calls.length === 1)).toBe(true)

    const replacement = owner.connectLiveProjection(pairingId, () => {}, () => {})
    expect(sockets).toHaveLength(4)
    replacement()
    uninstall()
    await Promise.resolve()
  })

  it('projects a bounded real Host Session and Workspace surface', async () => {
    const calls: string[] = []
    const dependencies = baseDependencies(hostRpc(async (method) => {
      calls.push(method)
      if (method === 'session.list') return { ok: true, value: { items: [{
        sessionId: 'session-product', updatedAt: 9, running: false, blank: false,
        cwd: '/work', projections: { asOfSeq: 1, values: { title: 'Real session' } },
      }, {
        sessionId: 'session-archived', updatedAt: 10, running: false, blank: false,
      }] } }
      if (method === 'workspace.list') return { ok: true, value: { items: [{
        workspaceId: 'workspace-product', path: '/work', title: 'Work',
        sessionIds: ['session-product'], createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      }], archivedSessionIds: ['session-archived'] } }
      throw new Error(`unexpected Host method ${method}`)
    }))
    const operation = op({ type: 'refresh-surface', offset: 0 })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'surface-snapshot', operationId: operation.operationId,
      offset: 0,
      sessions: [{ sessionId, displayTitle: 'Real session', cwd: '/work' }],
      workspaces: [{ workspaceId: 'workspace-product', sessionIds: [sessionId] }],
    })
    expect(calls).toEqual(['session.list', 'workspace.list'])
  })

  it('projects a later Session page with exact hasMore and Workspace membership', async () => {
    let items = Array.from({ length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1 }, (_, index) => ({
      sessionId: `session-${String(index)}`,
      updatedAt: index,
      running: false,
      blank: false,
    }))
    let sessionListCalls = 0
    const dependencies = baseDependencies(hostRpc(async (method) => {
      if (method === 'session.list') {
        sessionListCalls += 1
        return { ok: true, value: { items } }
      }
      if (method === 'workspace.list') return { ok: true, value: {
        items: items.map((item, index) => ({
          workspaceId: `workspace-${String(index)}`, path: `/work/${String(index)}`, title: `Work ${String(index)}`,
          sessionIds: [item.sessionId],
          createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
        })),
        archivedSessionIds: [],
      } }
      throw new Error(`unexpected Host method ${method}`)
    }))
    const discovery = new DesktopCompanionSurfaceDiscovery()
    await expect(discovery.refresh(op({ type: 'refresh-surface', offset: 0 }), dependencies)).resolves.toMatchObject({
      offset: 0,
      hasMore: true,
    })
    items = [{ sessionId: 'session-new', updatedAt: 100, running: false, blank: false }, ...items]
    const operation = {
      ...op({ type: 'refresh-surface', offset: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows }),
      operationId: parseCompanionOperationId('operation-refresh-surface-page-two'),
    }

    await expect(discovery.refresh(operation, {
      ...dependencies,
      desktopRevision: dependencies.desktopRevision + 2,
    })).resolves.toMatchObject({
      type: 'surface-snapshot',
      offset: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows,
      hasMore: false,
      sessions: [{ sessionId: `session-${String(REMOTE_PROTOCOL_LIMITS.surfaceSessionRows)}` }],
      workspaces: [{
        workspaceId: `workspace-${String(REMOTE_PROTOCOL_LIMITS.surfaceSessionRows)}`,
        sessionIds: [`session-${String(REMOTE_PROTOCOL_LIMITS.surfaceSessionRows)}`],
      }],
    })
    expect(sessionListCalls).toBe(1)
  })

  it('rejects an offset-zero snapshot that returns after Host replacement', async () => {
    const oldSessions = deferred<DesktopHostRpcResult>()
    const oldWorkspaces = deferred<DesktopHostRpcResult>()
    const discovery = new DesktopCompanionSurfaceDiscovery()
    const oldDependencies = baseDependencies(hostRpc(async method => await (
      method === 'session.list' ? oldSessions.promise : oldWorkspaces.promise
    )))
    const old = discovery.refresh(op({ type: 'refresh-surface', offset: 0 }), oldDependencies)

    discovery.clear()
    const items = Array.from({ length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1 }, (_, index) => ({
      sessionId: `replacement-${String(index)}`, updatedAt: index, running: false, blank: false,
    }))
    const replacementDependencies = baseDependencies(hostRpc(async method => method === 'session.list'
      ? { ok: true, value: { items } }
      : { ok: true, value: { items: [], archivedSessionIds: [] } }))
    await discovery.refresh({
      ...op({ type: 'refresh-surface', offset: 0 }),
      operationId: parseCompanionOperationId('replacement-page-zero'),
    }, replacementDependencies)
    oldSessions.resolve({ ok: true, value: { items: [{
      sessionId: 'old-host-session', updatedAt: 1, running: false, blank: false,
    }] } })
    oldWorkspaces.resolve({ ok: true, value: { items: [], archivedSessionIds: [] } })

    await expect(old).resolves.toMatchObject({
      type: 'operation-failed',
      failure: { code: 'HOST_WIRE_INVALID' },
    })
    await expect(discovery.refresh({
      ...op({ type: 'refresh-surface', offset: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows }),
      operationId: parseCompanionOperationId('replacement-page-one'),
    }, replacementDependencies)).resolves.toMatchObject({
      type: 'surface-snapshot',
      sessions: [{ sessionId: `replacement-${String(REMOTE_PROTOCOL_LIMITS.surfaceSessionRows)}` }],
    })
  })

  it('projects Host history into the shared conversation carrier', async () => {
    const dependencies = baseDependencies(hostRpc(async (method, payload) => {
      if (method === 'session.list') return { ok: true, value: { items: [{
        sessionId: 'session-product', updatedAt: 30, running: true, blank: false,
      }] } }
      expect(method).toBe('session.history')
      expect(payload).toEqual({ sessionId, beforeSeq: 10, maxMessages: 20 })
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
          { event: { type: 'user/message', seq: 3, time: 25, data: {
            id: 'message-steering', content: [{ type: 'text', text: 'redirect' }],
            source: { kind: 'steering' },
          } } },
          { event: { type: 'turn/end', seq: 4, time: 30, data: {
            turn: 1, reason: { kind: 'error', error: { message: 'model failed', code: 'MODEL_FAILED' } },
          } } },
        ],
        hasMore: false,
      } }
    }))
    const operation = op({ type: 'load-history', sessionId, beforeSeq: 10, maxMessages: 20 })
    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'conversation-snapshot', operationId: operation.operationId, sessionId, beforeSeq: 10,
      conversation: {
        nodes: [
          { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hello' }] },
          { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'world' }] },
          { kind: 'steering', seq: 3, content: [{ type: 'text', text: 'redirect' }] },
          { kind: 'turn-error', seq: 4, message: 'model failed', code: 'MODEL_FAILED' },
        ],
        running: true,
        hasMore: false,
      },
    })
  })

  it('loads an authoritative search hit beyond the bounded surface baseline', async () => {
    const target = parseCompanionSessionId('session-beyond-baseline')
    const items = Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.surfaceSessionRows },
      (_, index) => ({
        sessionId: `session-visible-${String(index)}`,
        updatedAt: index,
        running: false,
        blank: false,
      }),
    )
    items.push({ sessionId: target, updatedAt: 100, running: true, blank: false })
    const dependencies = baseDependencies(hostRpc(async (method) => {
      if (method === 'session.list') return { ok: true, value: { items } }
      expect(method).toBe('session.history')
      return { ok: true, value: { events: [], hasMore: false } }
    }))
    const operation = op({ type: 'load-history', sessionId: target, maxMessages: 20 })

    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'conversation-snapshot',
      sessionId: target,
      conversation: { running: true },
    })
  })

  it('projects model retries and suppresses the retry-owned terminal turn error', async () => {
    const dependencies = baseDependencies(hostRpc(async (method) => {
      if (method === 'session.list') return { ok: true, value: { items: [{
        sessionId: 'session-product', updatedAt: 50, running: false, blank: false,
      }] } }
      expect(method).toBe('session.history')
      return { ok: true, value: {
        events: [
          { event: { type: 'step/start', seq: 1, time: 10, data: { turn: 1, step: 1 } } },
          { event: { type: 'turn/end', seq: 2, time: 20, data: {
            turn: 1, reason: { kind: 'error', error: { message: 'temporary', code: 'RATE_LIMIT' } },
          } } },
          { event: { type: 'llm/retry', seq: 3, time: 30, data: {
            retryId: 'retry-product', turn: 1, step: 1, provider: 'deepseek', mode: 'normal',
            policyKey: 'normal', retry: 1, maxRetries: 2, delayMs: 500,
            failure: { message: 'temporary', code: 'RATE_LIMIT' },
          } } },
          { event: { type: 'llm/retry-started', seq: 4, time: 40, data: {
            retryId: 'retry-product', turn: 1, step: 1, retry: 1,
          } } },
        ],
        hasMore: false,
      } }
    }))
    const operation = op({ type: 'load-history', sessionId, maxMessages: 20 })

    await expect(handleCompanionProductOperation(operation, dependencies)).resolves.toMatchObject({
      type: 'conversation-snapshot',
      conversation: {
        nodes: [{
          kind: 'model-retry', seq: 3, retryId: 'retry-product', retryState: 'started',
          failure: { message: 'temporary', code: 'RATE_LIMIT' },
        }],
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

  it('creates Workspace-owned and Ungrouped Sessions through the exact Host request', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const dependencies = baseDependencies(hostRpc(async (method, payload) => {
      calls.push([method, payload])
      return { ok: true, value: { sessionId: `session-created-${String(calls.length)}` } }
    }))
    const workspace = op({ type: 'create-session', workspaceId: 'workspace-product' as never })
    const ungrouped = op({ type: 'create-session' })

    await expect(handleCompanionProductOperation(workspace, dependencies)).resolves.toMatchObject({
      type: 'confirmed', operationId: workspace.operationId,
    })
    await expect(handleCompanionProductOperation(ungrouped, dependencies)).resolves.toMatchObject({
      type: 'confirmed', operationId: ungrouped.operationId,
    })
    expect(calls).toEqual([
      ['session.create', { workspaceId: 'workspace-product' }],
      ['session.create', {}],
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
      if (request.url === '/api/events.mux' || request.url === '/api/events.host') {
        response.writeHead(426)
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
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- the host test face cannot resolve the DOM CryptoKey return type
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
