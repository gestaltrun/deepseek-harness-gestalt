// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseCompanionInteractionId,
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayPairingSelector,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import { CompanionForegroundRuntime } from '../src/companion-lifecycle.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { MobileCompanionTrackedSubmission } from '../src/companion-surface.ts'
import {
  MobileSnowCompanionConnection,
  MobileSnowCompanionProductChannel,
} from '../src/noise-companion-product.ts'
import {
  CompanionUncertainOperationSettlement,
  InMemoryCompanionCacheStore,
  parseCompanionDesktopId,
} from '../src/companion-cache.ts'

afterEach(() => { vi.unstubAllGlobals() })

const sid = (value: string): SessionId => value as SessionId

describe('Mobile Snow Companion product channel', () => {
  it('contains invalidation subscriber failures and still notifies every owner', () => {
    const connection = new MobileSnowCompanionConnection()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notified = vi.fn()
    connection.onInvalidated(() => { throw new Error('subscriber failed') })
    connection.onInvalidated(notified)
    const active = {
      channel: { seal: vi.fn() } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-invalidation'),
      pairingSelector: parseRelayPairingSelector('pairing-invalidation'),
      generation: 1,
    }
    connection.connect(active)
    connection.connect({ ...active, generation: 2 })

    expect(notified).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledWith(
      '[mobile-companion] connection invalidation subscriber failures:',
      expect.any(AggregateError),
    )
    reported.mockRestore()
  })

  it('creates Workspace-owned and Ungrouped Sessions and refreshes their presentation', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-create'),
      pairingSelector: parseRelayPairingSelector('pairing-create'),
      generation: 1,
    })
    const trackSurfaceRefresh = vi.fn()
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {}, trackSurfaceRefresh,
    })

    const workspace = product.create({ workspace: 'workspace-product' })
    await vi.waitFor(() => { expect(seal).toHaveBeenCalled() })
    const first = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    expect(first).toMatchObject({ type: 'create-session', workspaceId: 'workspace-product' })
    product.acceptResult({
      type: 'confirmed', operationId: first.operationId as never, committedAt: 1, outcome: 'accepted',
    })
    await expect(workspace.completion).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(trackSurfaceRefresh).toHaveBeenCalledOnce() })

    const ungrouped = product.create({})
    await vi.waitFor(() => {
      expect(seal.mock.calls.filter(call => (
        call[0] as { operation: { type: string } }
      ).operation.type === 'create-session')).toHaveLength(2)
    })
    const second = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    expect(second).toMatchObject({ type: 'create-session' })
    expect(second).not.toHaveProperty('workspaceId')
    product.acceptResult({
      type: 'confirmed', operationId: second.operationId as never, committedAt: 2, outcome: 'accepted',
    })
    await expect(ungrouped.completion).resolves.toBeUndefined()
  })

  it('sends refresh, history, cancel, and settles an Approval with a correlated receipt', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-v3'),
      pairingSelector: parseRelayPairingSelector('pairing-v3'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => {},
    })
    product.refreshSurface()
    product.loadOlder(sid('session-v3'))
    product.cancel(sid('session-v3'))
    const receipt = product.settle({
      kind: 'approval', sessionId: sid('session-v3'), interactionId: parseCompanionInteractionId('interaction-v3'),
      result: { ok: true, value: { sessionId: 'session-v3', approvalId: 'approval-v3', outcome: 'allowed-once' } },
    })
    await vi.waitFor(() => {
      const types = seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type)
      expect(types).toEqual(expect.arrayContaining(['cancel-session', 'settle-interaction']))
    })
    const cancelMessage = seal.mock.calls.find(call => (
      call[0] as { operation: { type: string } }
    ).operation.type === 'cancel-session')?.[0] as { operation: { operationId: string } }
    const settleMessage = seal.mock.calls.find(call => (
      call[0] as { operation: { type: string } }
    ).operation.type === 'settle-interaction')?.[0] as { operation: { operationId: string } }
    product.acceptResult({
      type: 'confirmed', operationId: cancelMessage.operation.operationId as never, committedAt: 1, outcome: 'accepted',
    })
    product.acceptResult({
      type: 'interaction-receipt', operationId: settleMessage.operation.operationId as never, accepted: true,
    })
    await expect(receipt).resolves.toEqual({ accepted: true })
    await vi.waitFor(() => {
      expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type))
        .toEqual([
          'refresh-surface', 'load-history', 'cancel-session', 'settle-interaction',
          'load-history', 'refresh-surface', 'load-history', 'refresh-surface',
        ])
    })
  })

  it('refreshes the authoritative history and surface after a confirmed prompt or cancel', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-refresh'),
      pairingSelector: parseRelayPairingSelector('pairing-refresh'),
      generation: 3,
    })
    const trackHistoryRefresh = vi.fn<(sessionId: SessionId, submission: MobileCompanionTrackedSubmission) => void>()
    const trackSurfaceRefresh = vi.fn<(submission: MobileCompanionTrackedSubmission) => void>()
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
      trackHistoryRefresh,
      trackSurfaceRefresh,
    })
    const submission = product.submit(sid('session-refresh'), 'next prompt')
    await vi.waitFor(() => { expect(seal).toHaveBeenCalled() })
    const submit = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    product.acceptResult({
      type: 'confirmed', operationId: submit.operationId as never, committedAt: 1, outcome: 'accepted',
    })
    await expect(submission.completion).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type))
        .toEqual(['submit-prompt', 'load-history', 'refresh-surface'])
    })
    expect(trackHistoryRefresh).toHaveBeenCalledOnce()
    expect(trackHistoryRefresh.mock.lastCall?.[0]).toBe('session-refresh')
    expect(typeof trackHistoryRefresh.mock.lastCall?.[1].operationId).toBe('string')
    await expect(trackHistoryRefresh.mock.lastCall?.[1].completion).resolves.toBeUndefined()
    expect(trackSurfaceRefresh).toHaveBeenCalledOnce()
    expect(typeof trackSurfaceRefresh.mock.lastCall?.[0].operationId).toBe('string')
    await expect(trackSurfaceRefresh.mock.lastCall?.[0].completion).resolves.toBeUndefined()

    product.cancel(sid('session-refresh'))
    await vi.waitFor(() => {
      expect((seal.mock.lastCall?.[0] as { operation?: { type?: string } }).operation?.type).toBe('cancel-session')
    })
    const cancel = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    product.acceptResult({
      type: 'confirmed', operationId: cancel.operationId as never, committedAt: 2, outcome: 'accepted',
    })
    await vi.waitFor(() => {
      expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type).slice(-3))
        .toEqual(['cancel-session', 'load-history', 'refresh-surface'])
    })
  })

  it('starts both post-confirmation refreshes when one tracker throws and observes its send rejection', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-refresh-callback'),
      pairingSelector: parseRelayPairingSelector('pairing-refresh-callback'),
      generation: 3,
    })
    let sends = 0
    const reportFailure = vi.fn()
    const trackSurfaceRefresh = vi.fn()
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => {
        sends += 1
        if (sends === 2) throw new Error('history refresh send failed')
      },
      reportFailure,
      trackHistoryRefresh: () => { throw new Error('history tracker failed') },
      trackSurfaceRefresh,
    })
    const submission = product.submit(sid('session-callback'), 'continue')
    await vi.waitFor(() => { expect(seal).toHaveBeenCalled() })
    const submit = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation
    product.acceptResult({
      type: 'confirmed', operationId: submit.operationId as never, committedAt: 1, outcome: 'accepted',
    })
    await expect(submission.completion).resolves.toBeUndefined()

    await vi.waitFor(() => {
      expect(trackSurfaceRefresh).toHaveBeenCalledOnce()
      expect(reportFailure.mock.calls.map(([error]) => (error as Error).message)).toEqual([
        'history tracker failed',
        'history refresh send failed',
      ])
    })
    expect(seal.mock.calls.map(call => (call[0] as { operation: { type: string } }).operation.type))
      .toEqual(['submit-prompt', 'load-history', 'refresh-surface'])
  })

  it('rejects prompt completion with the correlated Desktop failure', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-submit-failure'),
      pairingSelector: parseRelayPairingSelector('pairing-submit-failure'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    const submission = product.submit(sid('session-submit-failure'), 'will fail')
    await vi.waitFor(() => { expect(seal).toHaveBeenCalled() })
    product.acceptResult({
      type: 'operation-failed', operationId: submission.operationId,
      failure: { kind: 'business', code: 'prompt-refused', message: 'Desktop rejected the prompt' },
    })
    await expect(submission.completion).rejects.toThrow('Desktop rejected the prompt')
  })

  it('persists an uncertain prompt and reconciles its original result after reconnect', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    const active = {
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-reconcile'),
      pairingSelector: parseRelayPairingSelector('pairing-reconcile'),
      generation: 1,
    }
    connection.connect(active)
    const receipts = settlement()
    const recoveredReceipt = vi.fn()
    let firstSend = true
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection, operationSettlement: receipts,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => {
        if (!firstSend) return
        firstSend = false
        connection.disconnect()
      },
      recoveredReceipt,
    })

    const prompt = product.submit(sid('session-reconcile'), 'continue once')
    await expect(prompt.completion).rejects.toThrow('Companion Snow channel was replaced')
    connection.connect({ ...active, generation: 2 })
    const firstReconciliation = product.reconcileUnknown()
    const secondReconciliation = product.reconcileUnknown()
    await vi.waitFor(() => {
      expect((seal.mock.lastCall?.[0] as { operation?: { type?: string } }).operation?.type)
        .toBe('query-operation-status')
    })
    product.acceptResult({
      type: 'status', operationId: prompt.operationId,
      committed: { type: 'confirmed', operationId: prompt.operationId, committedAt: 5, outcome: 'accepted' },
    })

    await expect(Promise.all([firstReconciliation, secondReconciliation])).resolves.toEqual([
      [expect.objectContaining({ operationId: prompt.operationId, status: 'committed', kind: 'prompt' })],
      [expect.objectContaining({ operationId: prompt.operationId, status: 'committed', kind: 'prompt' })],
    ])
    const statusQueries = seal.mock.calls.filter(([message]) => (
      (message as { operation?: { type?: string } }).operation?.type === 'query-operation-status'
    ))
    expect(statusQueries).toHaveLength(1)
    expect(recoveredReceipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 'committed', operationId: prompt.operationId,
    }))
  })

  it('does not attempt Relay send when the durable unknown fence cannot commit', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: { seal: () => Uint8Array.of(1) } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-fence-failure'),
      pairingSelector: parseRelayPairingSelector('pairing-fence-failure'),
      generation: 1,
    })
    const store = new InMemoryCompanionCacheStore()
    vi.spyOn(store, 'saveReceipt').mockRejectedValueOnce(new Error('durable fence failed'))
    const sendCiphertext = vi.fn(async () => {})
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: new CompanionUncertainOperationSettlement(
        store, parseCompanionDesktopId('desktop-fence-failure'),
      ),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext,
    })
    const prompt = product.submit(sid('session-fence-failure'), 'do not send')

    await expect(prompt.completion).rejects.toThrow('durable fence failed')
    expect(sendCiphertext).not.toHaveBeenCalled()
    expect(await store.loadReceipts(parseCompanionDesktopId('desktop-fence-failure'))).toEqual([
      expect.objectContaining({ operationId: prompt.operationId, status: 'prepared' }),
    ])
  })

  it('commits the unknown fence before Relay send and retains it after an explicit send failure', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: { seal: () => Uint8Array.of(1) } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-fence'),
      pairingSelector: parseRelayPairingSelector('pairing-fence'),
      generation: 1,
    })
    const store = new InMemoryCompanionCacheStore()
    const operationSettlement = new CompanionUncertainOperationSettlement(
      store, parseCompanionDesktopId('desktop-fence'),
    )
    let receiptAtSend: string | undefined
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection, operationSettlement,
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => {
        receiptAtSend = (await store.loadReceipts(parseCompanionDesktopId('desktop-fence')))[0]?.status
        throw new Error('Relay explicitly refused the send')
      },
    })
    const prompt = product.submit(sid('session-fence'), 'send once')

    await expect(prompt.completion).rejects.toThrow('Relay explicitly refused the send')
    expect(receiptAtSend).toBe('unknown')
    expect(await store.loadReceipts(parseCompanionDesktopId('desktop-fence'))).toEqual([
      expect.objectContaining({ operationId: prompt.operationId, status: 'unknown' }),
    ])
    const queryStatus = vi.fn(async () => ({ committed: false as const }))
    await expect(operationSettlement.reconcileUnknown({
      send: async () => { throw new Error('reconciliation must not send') },
      queryStatus,
    })).resolves.toEqual([
      expect.objectContaining({ operationId: prompt.operationId, status: 'not-submitted' }),
    ])
    expect(queryStatus).toHaveBeenCalledExactlyOnceWith(prompt.operationId)
  })

  it('projects an outcome-unknown Host failure and refreshes authoritative history after reconciliation', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-outcome-unknown'),
      pairingSelector: parseRelayPairingSelector('pairing-outcome-unknown'),
      generation: 1,
    })
    const operationId = parseCompanionOperationId('operation-outcome-unknown')
    const sessionId = parseCompanionSessionId('session-outcome-unknown')
    const store = new InMemoryCompanionCacheStore()
    await store.saveReceipt(parseCompanionDesktopId('desktop-outcome-unknown'), {
      operationId, status: 'unknown', kind: 'prompt', sessionId,
    })
    const recoveredReceipt = vi.fn()
    const trackHistoryRefresh = vi.fn()
    const trackSurfaceRefresh = vi.fn()
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: new CompanionUncertainOperationSettlement(
        store, parseCompanionDesktopId('desktop-outcome-unknown'),
      ),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
      recoveredReceipt, trackHistoryRefresh, trackSurfaceRefresh,
    })
    const reconciliation = product.reconcileUnknown()
    await vi.waitFor(() => {
      expect((seal.mock.lastCall?.[0] as { operation?: { type?: string } }).operation?.type)
        .toBe('query-operation-status')
    })
    const failureResult = {
      type: 'operation-failed' as const,
      operationId,
      failure: {
        kind: 'business' as const,
        code: 'companion-outcome-unknown',
        message: 'Desktop Host effect outcome is unknown after operation ledger recovery.',
      },
    }
    product.acceptResult({ type: 'status', operationId, committed: failureResult })

    const receipt = { operationId, status: 'committed', kind: 'prompt', sessionId, original: failureResult }
    await expect(reconciliation).resolves.toEqual([receipt])
    expect(recoveredReceipt).toHaveBeenCalledExactlyOnceWith(receipt)
    await vi.waitFor(() => {
      expect(trackHistoryRefresh).toHaveBeenCalledOnce()
      expect(trackSurfaceRefresh).toHaveBeenCalledOnce()
    })
  })

  it('assembles and verifies exact historical image bytes', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-image'),
      pairingSelector: parseRelayPairingSelector('pairing-image'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    const loaded = product.loadImage(sid('session-image'), {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    })
    const operationId = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation.operationId
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.of(0, 1, 2))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('')
    product.acceptResult({
      type: 'image-chunk', operationId: operationId as never, sessionId: 'session-image' as never,
      attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', index: 0, count: 1, sha256, data: 'AAEC',
    })
    await expect(loaded).resolves.toBe('data:image/png;base64,AAEC')
  })

  it('rejects a correlated image request when Desktop returns an operation failure', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(1))
    connection.connect({
      channel: { seal } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-image-failure'),
      pairingSelector: parseRelayPairingSelector('pairing-image-failure'),
      generation: 3,
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example', sendCiphertext: async () => {},
    })
    const loaded = product.loadImage(sid('session-image'), {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    })
    const operationId = (seal.mock.lastCall?.[0] as { operation: { operationId: string } }).operation.operationId
    product.acceptResult({
      type: 'operation-failed', operationId: operationId as never,
      failure: { kind: 'wire', code: 'HOST_WIRE_INVALID', message: 'Desktop Host response exceeded its byte limit' },
    })
    await expect(loaded).rejects.toThrow('Desktop Host response exceeded its byte limit')
  })

  it('seals search and encrypted attachment operations on the current generation with Installation proof', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const seal = vi.fn((_message: unknown) => Uint8Array.of(7, 8))
    const channel = { seal } as never
    connection.connect({
      channel,
      targetAttachmentId: parseRelayAttachmentId('desktop-current'),
      pairingSelector: parseRelayPairingSelector('pairing-current'),
      generation: 1,
    })
    const sendCiphertext = vi.fn(async () => {})
    const authorizeCurrentInstallation = vi.fn(async () => ({
      accessToken: 'current-access',
      proof: { jti: 'proof-current' as never, issuedAt: 1234, signature: 'signature-current' },
    }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer current-access')
      expect(headers.get('x-gestalt-pairing-selector')).toBe('pairing-current')
      expect(headers.get('x-gestalt-proof-jti')).toBe('proof-current')
      return new Response(JSON.stringify({
        capability: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        byteLength: 31,
        expiresAt: Date.now() + 60_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation },
      attachmentKeys: { attachmentKeyMaterial: () => new Uint8Array(32).fill(3) },
      platformOrigin: 'https://platform.example',
      sendCiphertext,
    })

    const search = product.search('indexed needle')
    await vi.waitFor(() => { expect(sendCiphertext).toHaveBeenCalledOnce() })
    expect(seal).toHaveBeenCalledWith({
      type: 'operation',
      operation: { type: 'search-sessions', operationId: search.operationId, query: 'indexed needle' },
    })
    const attachment = product.attach(sid('session-current'), new File([Uint8Array.of(1, 2, 3)], 'real.bin'))
    await vi.waitFor(() => {
      expect((seal.mock.lastCall?.[0] as { operation?: { type?: string } }).operation?.type).toBe('offer-attachment')
    })
    product.acceptResult({
      type: 'confirmed', operationId: attachment.operationId, committedAt: 1, outcome: 'accepted',
    })
    await attachment.completion
    expect(authorizeCurrentInstallation).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(seal.mock.calls.find(call => (
      call[0] as { operation: { type: string } }
    ).operation.type === 'offer-attachment')?.[0]).toMatchObject({
      type: 'operation',
      operation: {
        type: 'offer-attachment',
        operationId: attachment.operationId,
        sessionId: 'session-current',
        fileName: 'real.bin',
        mediaType: 'application/octet-stream',
      },
    })
    expect(sendCiphertext).toHaveBeenCalledTimes(4)
  })

  it('rejects a send that completes after channel replacement', async () => {
    const runtime = synchronizedRuntime()
    const connection = new MobileSnowCompanionConnection()
    const active = {
      channel: { seal: () => Uint8Array.of(1) } as never,
      targetAttachmentId: parseRelayAttachmentId('desktop-old'),
      pairingSelector: parseRelayPairingSelector('pairing-old'),
      generation: 1,
    }
    connection.connect(active)
    const failure = vi.fn()
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      operationSettlement: settlement(),
      installation: { authorizeCurrentInstallation: vi.fn() },
      attachmentKeys: { attachmentKeyMaterial: () => undefined },
      platformOrigin: 'https://platform.example',
      sendCiphertext: async () => { connection.disconnect() },
      reportFailure: failure,
    })
    const search = product.search('replacement race')
    await expect(search.completion).rejects.toThrow('Companion Snow channel was replaced')
    expect(failure).not.toHaveBeenCalled()
  })
})

function synchronizedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    endpoint: 'mobile',
    routeId: parseRelayRouteId('route-current'),
    credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    revision: 1,
  })
  runtime.markConnectionOpen()
  const resync = runtime.bindValidatedDesktopResync()
  if (resync === undefined || !resync.acceptValidatedDesktopResync({
    type: 'desktop-resync', version: 1, authenticated: true,
  })) throw new Error('test runtime did not synchronize')
  return runtime
}

function settlement(): CompanionUncertainOperationSettlement {
  return new CompanionUncertainOperationSettlement(
    new InMemoryCompanionCacheStore(),
    parseCompanionDesktopId(`desktop-${crypto.randomUUID()}`),
  )
}
