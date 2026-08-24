import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { WebSocketDownlinks } from '@deepseek-ai/dsh-client-connection/src/websocket-downlink.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  generateRelayCredential,
  parseCompanionOperationId,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionOperationFailedResult,
  type CompanionSearchSessionsOperation,
  type CompanionSessionSearchResult,
  type CompanionProjection,
  type CompanionResult,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  acceptSnowDesktopReconnect, beginSnowCompanionProtocol, beginSnowMobileReconnect, initializeSnowChannel,
  SnowDesktopEndpointPairingOwner, SnowMobileHandshakeClient,
  type SnowCompanionProtocolChannel,
} from '@deepseek-ai/dsh-noise-channel'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type Session } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as SqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DesktopCompanionProductOwner } from '../src/companion-product.ts'
import type { DesktopCompanionOperationOutput, DesktopCompanionPairingDependencies } from '../src/companion-product.ts'
import {
  DesktopCompanionOperationLedger, FileDesktopCompanionOperationStore,
} from '../src/companion-operation-ledger.ts'
import { CompanionForegroundRuntime } from '../../mobile/src/companion-lifecycle.ts'
import {
  CompanionUncertainOperationSettlement,
  InMemoryCompanionCacheStore,
  parseCompanionDesktopId,
} from '../../mobile/src/companion-cache.ts'
import { MobileCompanionSurface } from '../../mobile/src/companion-surface.ts'
import {
  MobileSnowCompanionConnection, MobileSnowCompanionProductChannel,
} from '../../mobile/src/noise-companion-product.ts'
import { MobileNoiseCompanionReceiver } from '../../mobile/src/noise-companion.ts'
import { runHost400CodecProbe } from './host-400-codec-probe.ts'
import { DesktopSnowRelayChannelOwner } from '../src/remote-relay.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('assembled Desktop Companion Host search', () => {
  it('projects real Session history and runs submit, cancel, and image bytes through Snow into shared Mobile state', async () => {
    const assembled = await startDesktopHost('indexed', 'assembled v3 history')
    for (const method of ['session.list', 'workspace.list'] as const) {
      const response = await fetch(new URL(`/api/${method}`, assembled.url), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `probe-${method}`, method, payload: {} }),
      })
      expect(response.status, await response.text()).toBe(200)
    }
    const owner = productOwner(assembled.url)
    owner.installLedger(await DesktopCompanionOperationLedger.load(
      new FileDesktopCompanionOperationStore(join(assembled.root, 'companion-operations.json')),
    ))
    const channels = await snowProductChannels()
    const disposeLive = owner.connectLiveProjection(
      parsePersonalPairingId(channels.pairingSelector), () => {}, () => {},
    )
    cleanups.push(async () => { disposeLive() })
    const runtime = connectedRuntime()
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: channels.mobile, targetAttachmentId: channels.desktopAttachmentId,
      pairingSelector: channels.pairingSelector, generation: channels.generation,
    })
    const surface = new MobileCompanionSurface(runtime)
    const received: CompanionResult[] = []
    const transportFailures: unknown[] = []
    const receiverRef: { current?: MobileNoiseCompanionReceiver } = {}
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: assembledOperationSettlement('desktop-primary'),
      installation: { authorizeCurrentInstallation: async () => ({
        accessToken: 'assembled-current-installation',
        proof: { jti: 'assembled-proof' as never, issuedAt: 1, signature: 'assembled-signature' },
      }) },
      attachmentKeys: { attachmentKeyMaterial: () => channels.attachmentKey.slice() },
      platformOrigin: 'https://operated-platform.test',
      reportFailure: (error) => { transportFailures.push(error) },
      sendCiphertext: async (_target, ciphertext) => {
        await Promise.resolve()
        const opened = channels.desktop.open(ciphertext)
        if (opened.type !== 'operation') throw new Error('assembled Desktop expected a Companion operation')
        const output = await owner.handle(opened.operation, pairingDependencies(owner, channels))
        for (const item of isResultList(output) ? output : [output]) {
          const receiver = receiverRef.current
          if (receiver === undefined) throw new Error('assembled Mobile receiver is not installed')
          receiver.receive(channels.desktop.seal(isProjection(item)
            ? { type: 'projection', projection: item }
            : { type: 'result', result: item }))
        }
      },
    })
    const connectionChannel = {
      mutations: product,
      content: { loadImage: async (sessionId: string, attachment: never) => await product.loadImage(sessionId, attachment) },
    }
    const receiver = new MobileNoiseCompanionReceiver(
      channels.mobile, channels.generation, runtime,
      () => ({
        acceptValidatedCompanionResult: (result) => {
          received.push(result)
          product.acceptResult(result)
          surface.bindValidatedCompanionResults()?.acceptValidatedCompanionResult(result)
        },
      }),
      () => surface.bindAuthenticatedConnection(connectionChannel),
      (offset) => { surface.trackSurfaceRefresh(product.refreshSurface(offset)) },
    )
    receiverRef.current = receiver
    receiver.receive(channels.desktop.seal({
      type: 'projection',
      projection: {
        type: 'foreground-sync', desktopName: 'Assembled Desktop',
        generation: channels.generation, desktopRevision: 1,
      },
    }))
    await expect.poll(() => surface.getSnapshot().sessions.ids.includes(assembled.sessionId)).toBe(true)
    expect(received.filter(result => result.type === 'operation-failed')).toEqual([])
    surface.loadOlder(assembled.sessionId)
    await expect.poll(() => ({
      ready: (surface.getSnapshot().conversations[assembled.sessionId]?.nodes.length ?? 0) > 0,
      failures: received.filter(result => result.type === 'operation-failed'),
      transportFailures,
    })).toEqual({ ready: true, failures: [], transportFailures: [] })

    await surface.submit(assembled.sessionId, 'submitted through Companion v3')
    await expect.poll(() => assembled.session.events.some(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('submitted through Companion v3'))).toBe(true)
    surface.cancel(assembled.sessionId)
    await expect.poll(() => assembled.cancelled.value).toBe(1)

    const resultCount = received.length
    const image = surface.loadImage(assembled.sessionId, assembled.image)
    await expect.poll(() => received.slice(resultCount).some(result => result.type === 'image-chunk')).toBe(true)
    await expect(image).resolves.toMatch(/^data:image\/png;base64,/u)

    const asked = assembled.ctx.userQuestions.ask({
      agent: assembled.agent,
      questions: [{ id: 'target', question: 'Choose target', options: [{ label: 'Code' }, { label: 'Docs' }] }],
    })
    await expect.poll(() => owner.pendingInteractions(assembled.sessionId as never, channels.attachmentKey)
      .some(pending => pending.kind === 'question')).toBe(true)
    surface.loadOlder(assembled.sessionId)
    await expect.poll(() => surface.getSnapshot().conversations[assembled.sessionId]?.pending
      .some(pending => pending.kind === 'question') ?? false).toBe(true)
    const question = surface.getSnapshot().conversations[assembled.sessionId]?.pending
      .find(pending => pending.kind === 'question')
    if (question === undefined || question.kind !== 'question') throw new Error('assembled Ask User wait was not projected')
    await expect(question.respond({
      ok: true,
      value: { sessionId: assembled.sessionId, answer: { answers: [{ id: 'target', selected: ['Code'] }] } },
    })).resolves.toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'target', selected: ['Code'] }] })

    assembled.session.append('turn/start', { turn: 1 })
    const approval = assembled.ctx.approval.request({
      agent: assembled.agent, toolName: 'bash', reason: 'assembled Companion approval',
    })
    await expect.poll(() => owner.pendingInteractions(assembled.sessionId as never, channels.attachmentKey)
      .some(pending => pending.kind === 'approval')).toBe(true)
    surface.loadOlder(assembled.sessionId)
    await expect.poll(() => surface.getSnapshot().conversations[assembled.sessionId]?.pending
      .some(pending => pending.kind === 'approval') ?? false).toBe(true)
    const approvalWait = surface.getSnapshot().conversations[assembled.sessionId]?.pending
      .find(pending => pending.kind === 'approval')
    if (approvalWait === undefined || approvalWait.kind !== 'approval') throw new Error('assembled Approval wait was not projected')
    await expect(approvalWait.respond({
      ok: true,
      value: {
        sessionId: assembled.sessionId,
        approvalId: approvalWait.payload.approvalId,
        outcome: 'allowed-once',
      },
    })).resolves.toEqual({ accepted: true })
    await expect(approval).resolves.toBe('allowed-once')
  }, 45_000)

  it('pushes committed Host output and hidden Session summaries through the authenticated Snow owner', async () => {
    const assembled = await startDesktopHost('indexed', 'live projection baseline')
    const baselineSessionIds = [assembled.sessionId]
    for (let index = 0; index < REMOTE_PROTOCOL_LIMITS.surfaceSessionRows; index += 1) {
      const sessionId = SessionId(`desktop-paged-session-${String(index)}`)
      assembled.ctx.sessions.create(sessionId, {
        meta: {
          version: SESSION_FORMAT_VERSION, id: sessionId,
          createdAt: index + 2, cwd: assembled.root,
        },
      })
      baselineSessionIds.push(sessionId)
    }
    const owner = productOwner(assembled.url)
    const channels = await snowProductChannels()
    const runtime = connectedRuntime()
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: channels.mobile, targetAttachmentId: channels.desktopAttachmentId,
      pairingSelector: channels.pairingSelector, generation: channels.generation,
    })
    const surface = new MobileCompanionSurface(runtime)
    const operationTypes: string[] = []
    const reconnectFailures: Error[] = []
    let sends = 0
    const relayOwner = new DesktopSnowRelayChannelOwner({ accept: async () => ({
      targetAttachmentId: channels.mobileAttachmentId,
      payload: Uint8Array.of(77),
      negotiation: { finish: () => channels.desktop, cancel: vi.fn() },
      pairingSelector: channels.pairingSelector,
      generation: channels.generation,
    }) }, async (_selector, _target, ciphertext) => {
      sends += 1
      if (sends === 1) return
      setTimeout(() => { receiver.receive(ciphertext) }, 0)
    }, async (operation) => {
      operationTypes.push(operation.type)
      if (operation.type === 'query-operation-status') {
        return await owner.queryOperationStatus(
          parsePersonalPairingId(channels.pairingSelector), operation.operationId,
        )
      }
      return await owner.handle(operation, pairingDependencies(owner, channels))
    }, () => 'Assembled Desktop', 10_000, {
      connect: (selector, changed, disconnect) => owner.connectLiveProjection(
        parsePersonalPairingId(selector), changed, disconnect,
      ),
      project: async (change, _selector, signal) => await owner.projectLiveSession(
        change, channels.attachmentKey, signal,
      ),
      retainsConversation: (change, selector) => owner.retainsLiveConversation(
        parsePersonalPairingId(selector), change,
      ),
      reconnect: (_selector, error) => { reconnectFailures.push(error) },
    })
    const product = new MobileSnowCompanionProductChannel({
      runtime, connection,
      operationSettlement: assembledOperationSettlement('desktop-live'),
      installation: { authorizeCurrentInstallation: async () => ({
        accessToken: 'assembled-current-installation',
        proof: { jti: 'assembled-proof' as never, issuedAt: 1, signature: 'assembled-signature' },
      }) },
      attachmentKeys: { attachmentKeyMaterial: () => channels.attachmentKey.slice() },
      platformOrigin: 'https://operated-platform.test',
      sendCiphertext: async (_target, ciphertext) => {
        await relayOwner.receive(
          ciphertext, channels.mobileAttachmentId, channels.desktopAttachmentId,
          channels.pairingSelector, new AbortController().signal,
        )
      },
      trackHistoryRefresh: (sessionId, submission) => { surface.trackHistoryRefresh(sessionId, submission) },
      trackSurfaceRefresh: (submission) => { surface.trackSurfaceRefresh(submission) },
    })
    const connectionChannel = {
      mutations: product,
      content: { loadImage: async (sessionId: string, attachment: never) => await product.loadImage(sessionId, attachment) },
    }
    const receiver = new MobileNoiseCompanionReceiver(
      channels.mobile, channels.generation, runtime,
      () => ({ acceptValidatedCompanionResult: (result) => {
        product.acceptResult(result)
        surface.bindValidatedCompanionResults()?.acceptValidatedCompanionResult(result)
      } }),
      () => surface.bindAuthenticatedConnection(connectionChannel),
      (offset) => { surface.trackSurfaceRefresh(product.refreshSurface(offset)) },
    )
    relayOwner.updatePeers({
      type: 'ready', transportVersion: 1,
      routeId: parseRelayRouteId('route-assembled-snow'),
      attachmentId: channels.desktopAttachmentId,
      peers: [{
        attachmentId: channels.mobileAttachmentId,
        pairingSelector: channels.pairingSelector,
        generation: channels.generation,
      }],
    }, channels.pairingSelector)
    await relayOwner.receive(
      Uint8Array.of(1), channels.mobileAttachmentId, channels.desktopAttachmentId,
      channels.pairingSelector, new AbortController().signal,
    )
    await relayOwner.receive(
      Uint8Array.of(2), channels.mobileAttachmentId, channels.desktopAttachmentId,
      channels.pairingSelector, new AbortController().signal,
    )
    await expect.poll(() => baselineSessionIds.every(id => surface.getSnapshot().sessions.ids.includes(id))).toBe(true)
    expect(surface.getSnapshot().sessions.ids).toHaveLength(REMOTE_PROTOCOL_LIMITS.surfaceSessionRows + 1)
    const observation = product.observeSession(assembled.sessionId)
    await expect(observation.completion).resolves.toBeUndefined()
    await expect.poll(() => surface.getSnapshot().conversations[assembled.sessionId] !== undefined).toBe(true)
    const historyOperations = operationTypes.filter(type => type === 'load-history').length

    assembled.session.append('turn/start', { turn: 1 })
    assembled.session.append('step/start', { turn: 1, step: 1 })
    assembled.session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
    })
    assembled.session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'LIVE_PUSH_OK' },
    })
    await expect.poll(() => surface.getSnapshot().conversations[assembled.sessionId]?.partial)
      .toMatchObject({ blocks: [{ kind: 'text', text: 'LIVE_PUSH_OK' }] })
    expect(operationTypes.filter(type => type === 'load-history')).toHaveLength(historyOperations)

    const hiddenId = SessionId('desktop-hidden-session')
    const hidden = assembled.ctx.sessions.create(hiddenId, {
      meta: {
        version: SESSION_FORMAT_VERSION, id: hiddenId, createdAt: 2, cwd: assembled.root,
      },
    })
    hidden.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hidden summary change' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect.poll(() => surface.getSnapshot().sessions.ids.includes(hiddenId)).toBe(true)
    expect(surface.getSnapshot().conversations[hiddenId]).toBeUndefined()

    const secondaryRoot = join(assembled.root, 'secondary')
    await mkdir(secondaryRoot)
    const surfaceOperations = operationTypes.filter(type => type === 'refresh-surface').length
    const secondaryWorkspace = await assembled.ctx.workspaceRegistry.create(secondaryRoot, 'Secondary')
    await expect.poll(() => operationTypes.filter(type => type === 'refresh-surface').length)
      .toBeGreaterThan(surfaceOperations)
    expect(surface.getSnapshot().conversations[assembled.sessionId]?.partial)
      .toMatchObject({ blocks: [{ kind: 'text', text: 'LIVE_PUSH_OK' }] })
    const secondaryId = SessionId('desktop-secondary-workspace-session')
    assembled.ctx.sessions.create(secondaryId, {
      meta: {
        version: SESSION_FORMAT_VERSION, id: secondaryId,
        createdAt: 100, cwd: secondaryRoot,
      },
    })
    await secondaryWorkspace.attachSession(secondaryId)
    const primaryWorkspace = await assembled.ctx.workspaceRegistry.create(assembled.root, 'Primary')
    await primaryWorkspace.attachSession(assembled.sessionId)
    await expect.poll(() => surface.getSnapshot().workspaces.map(workspace => workspace.workspaceId))
      .toEqual([primaryWorkspace.id, secondaryWorkspace.id])
    await assembled.ctx.workspaceRegistry.insertBefore(primaryWorkspace.id)
    await expect.poll(() => surface.getSnapshot().workspaces.map(workspace => workspace.workspaceId))
      .toEqual([secondaryWorkspace.id, primaryWorkspace.id])
    await assembled.ctx.workspaceRegistry.delete(secondaryWorkspace.id)
    await expect.poll(() => surface.getSnapshot().workspaces.map(workspace => workspace.workspaceId))
      .toEqual([primaryWorkspace.id])
    await assembled.ctx.workspaceRegistry.archiveSession(assembled.sessionId)
    await expect.poll(() => surface.getSnapshot().sessions.ids.includes(assembled.sessionId)).toBe(false)
    expect(surface.getSnapshot().conversations[assembled.sessionId]).toBeUndefined()
    expect(reconnectFailures).toEqual([])
    relayOwner.invalidate(channels.pairingSelector)
    await relayOwner.drain()
  }, 45_000)

  it('runs shipped Mobile mutations through Snow into the real Desktop Host', async () => {
    const assembled = await startDesktopHost('indexed', 'assembled Snow search needle')
    const owner = productOwner(assembled.url)
    owner.installLedger(await DesktopCompanionOperationLedger.load(
      new FileDesktopCompanionOperationStore(join(assembled.root, 'legacy-product-operations.json')),
    ))
    const channel = await snowProductChannels()
    const runtime = synchronizedRuntime(channel.mobile, channel.desktop, channel.generation)
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: channel.mobile,
      targetAttachmentId: channel.desktopAttachmentId,
      pairingSelector: channel.pairingSelector,
      generation: channel.generation,
    })
    let retainedCiphertext = new Uint8Array()
    const results: unknown[] = []
    const productRef: { current?: MobileSnowCompanionProductChannel } = {}
    const receiver = new MobileNoiseCompanionReceiver(
      channel.mobile, channel.generation, runtime,
      () => ({ acceptValidatedCompanionResult: (result) => {
        results.push(result)
        productRef.current?.acceptResult(result)
      } }),
    )
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      operationSettlement: assembledOperationSettlement('desktop-shipped'),
      installation: { authorizeCurrentInstallation: async () => ({
        accessToken: 'assembled-current-installation',
        proof: { jti: 'assembled-proof' as never, issuedAt: 1, signature: 'assembled-signature' },
      }) },
      attachmentKeys: { attachmentKeyMaterial: () => channel.attachmentKey.slice() },
      platformOrigin: 'https://operated-platform.test',
      sendCiphertext: async (_target, ciphertext) => {
        const opened = channel.desktop.open(ciphertext)
        if (opened.type !== 'operation') throw new Error('assembled Desktop did not open a Companion operation')
        const output = await owner.handle(opened.operation as never, {
          pairingId: 'pairing-assembled-snow' as never,
          attachmentKey: channel.attachmentKey.slice(),
          now: Date.now,
          generation: channel.generation,
          desktopRevision: 1,
          desktopName: 'Assembled Desktop',
          downloadAttachment: async () => retainedCiphertext.slice(),
          submitAttachment: async input => await owner.submitAttachment(input),
          resolveInteraction: interactionId => owner.resolveInteraction(interactionId, channel.attachmentKey),
          pendingInteractions: sessionId => owner.pendingInteractions(sessionId, channel.attachmentKey),
        })
        if (Array.isArray(output) || isProjection(output)) throw new Error('legacy assembled operation returned non-result output')
        receiver.receive(channel.desktop.seal({ type: 'result', result: output as CompanionResult }))
      },
    })
    productRef.current = product
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_input, init) => {
      retainedCiphertext = new Uint8Array(await new Response(init?.body).arrayBuffer())
      return new Response(JSON.stringify({
        capability: 'A'.repeat(43), byteLength: retainedCiphertext.byteLength,
        expiresAt: Date.now() + 60_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    try {
      const search = product.search('assembled Snow search needle')
      await search.completion
      await expect.poll(() => results.some(result => isOperationResult(result, search.operationId))).toBe(true)
      for (const [name, type, bytes] of [
        ['payload.bin', 'application/octet-stream', Uint8Array.of(0, 255, 1, 2)],
        ['pixel.png', 'image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
        ['notes.txt', 'text/plain', new TextEncoder().encode('assembled exact text bytes')],
      ] as const) {
        const transfer = product.attach(assembled.sessionId, new File([bytes], name, { type }))
        await transfer.completion
        await expect.poll(() => results.some(result => isOperationResult(result, transfer.operationId))).toBe(true)
      }
      expect(results.map(result => typeof result === 'object' && result !== null && 'type' in result
        ? result.type
        : 'invalid')).toEqual(['session-search', 'confirmed', 'confirmed', 'confirmed'])
      const admitted = assembled.session.events.filter(event => event.type === 'session/attachment-admitted')
      expect(admitted.map(event => event.type === 'session/attachment-admitted'
        ? [event.data.attachment.name, event.data.attachment.mediaType, event.data.attachment.bytes]
        : [])).toEqual([
        ['payload.bin', 'application/octet-stream', 4],
        ['pixel.png', 'image/png', 8],
        ['notes.txt', 'text/plain', 26],
      ])
    } finally {
      globalThis.fetch = originalFetch
      channel.attachmentKey.fill(0)
      channel.mobile.dispose()
      channel.desktop.dispose()
    }
  }, 45_000)

  it('retains the Snow send nonce when the durable operation fence fails', async () => {
    const channel = await snowProductChannels()
    const runtime = synchronizedRuntime(channel.mobile, channel.desktop, channel.generation)
    const connection = new MobileSnowCompanionConnection()
    connection.connect({
      channel: channel.mobile,
      targetAttachmentId: channel.desktopAttachmentId,
      pairingSelector: channel.pairingSelector,
      generation: channel.generation,
    })
    const store = new InMemoryCompanionCacheStore()
    vi.spyOn(store, 'saveReceipt').mockRejectedValueOnce(new Error('durable fence failed'))
    const opened: Array<'operation'> = []
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      operationSettlement: new CompanionUncertainOperationSettlement(
        store,
        parseCompanionDesktopId('desktop-fence-nonce'),
      ),
      installation: { authorizeCurrentInstallation: async () => ({
        accessToken: 'assembled-current-installation',
        proof: { jti: 'assembled-proof' as never, issuedAt: 1, signature: 'assembled-signature' },
      }) },
      attachmentKeys: { attachmentKeyMaterial: () => channel.attachmentKey.slice() },
      platformOrigin: 'https://operated-platform.test',
      sendCiphertext: async (_target, ciphertext) => {
        const message = channel.desktop.open(ciphertext)
        if (message.type !== 'operation') throw new Error('assembled Desktop expected an operation')
        opened.push(message.type)
      },
    })
    try {
      await expect(product.submit(assembledSessionId(), 'fenced prompt').completion)
        .rejects.toThrow('durable fence failed')
      await expect(product.search('nonce remains synchronized').completion).resolves.toBeUndefined()
      expect(opened).toEqual(['operation'])
    } finally {
      channel.attachmentKey.fill(0)
      channel.mobile.dispose()
      channel.desktop.dispose()
    }
  })

  it('indexes a real Desktop Session and returns authoritative hit and no-hit results', async () => {
    const assembled = await startDesktopHost('indexed', 'desktop assembled SQLite needle')
    const owner = productOwner(assembled.url)

    let hit = await search(owner, 'desktop assembled SQLite needle', 'assembled-hit')
    await expect.poll(async () => {
      hit = await search(owner, 'desktop assembled SQLite needle', 'assembled-hit')
      return hit.type === 'session-search'
        && hit.items.some(item => item.sessionId === assembled.sessionId && item.snippet.includes('SQLite needle'))
    }, { timeout: 15_000 }).toBe(true)
    expect(hit).toMatchObject({
      type: 'session-search',
      hasMore: false,
    })
    await expect(search(owner, 'definitely absent companion phrase', 'assembled-no-hit')).resolves.toEqual({
      type: 'session-search',
      operationId: parseCompanionOperationId('assembled-no-hit'),
      items: [],
      hasMore: false,
    })
  }, 45_000)

  it('encodes a real Host HTTP 400 as one Companion result', async () => {
    await expect(runHost400CodecProbe()).resolves.toBeInstanceOf(Uint8Array)
  })

  it.each(['disabled', 'index-failure'] as const)(
    'projects a real Desktop %s search-provider failure',
    async (scenario) => {
      const assembled = await startDesktopHost(scenario, `desktop ${scenario} needle`)
      const owner = productOwner(assembled.url)

      const failure = await search(owner, `desktop ${scenario} needle`, `assembled-${scenario}`)
      expect(failure).toMatchObject({
        type: 'operation-failed',
        operationId: parseCompanionOperationId(`assembled-${scenario}`),
        failure: {
          kind: 'business',
          code: 'internal',
        },
      })
      if (failure.type !== 'operation-failed') throw new Error('expected search failure')
      expect(failure.failure.message).toContain('session search failed')
    },
    45_000,
  )
})

function assembledOperationSettlement(desktopId: string): CompanionUncertainOperationSettlement {
  return new CompanionUncertainOperationSettlement(
    new InMemoryCompanionCacheStore(),
    parseCompanionDesktopId(desktopId),
  )
}

function assembledSessionId(): SessionId {
  return 'session-fence-nonce' as SessionId
}

async function startDesktopHost(
  scenario: 'indexed' | 'disabled' | 'index-failure',
  message: string,
): Promise<{
  url: string
  root: string
  sessionId: Session['id']
  session: Session
  image: ImageAttachmentRef
  cancelled: { value: number }
  ctx: Context
  agent: Agent
}> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-companion-assembled-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  const sessions = await ctx.plugin(SessionStore)
  cleanups.push(async () => { await sessions.dispose() })
  const persistence = await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.sqlite') })
  cleanups.push(async () => { await persistence.dispose() })
  const agents = await ctx.plugin(AgentRegistry)
  cleanups.push(async () => { await agents.dispose() })
  const questions = await ctx.plugin(UserQuestionService)
  cleanups.push(async () => { await questions.dispose() })
  const systemPrompt = await ctx.plugin(SystemPrompt, { persona: '' })
  cleanups.push(async () => { await systemPrompt.dispose() })
  const approval = await ctx.plugin(ApprovalService)
  cleanups.push(async () => { await approval.dispose() })
  const attachments = await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  cleanups.push(async () => { await attachments.dispose() })
  const storage = await ctx.plugin(Storage)
  cleanups.push(async () => { await storage.dispose() })
  const sqliteStorage = await ctx.plugin(SqliteStorage, { path: join(root, 'domain.sqlite') })
  cleanups.push(async () => { await sqliteStorage.dispose() })
  const storageDomain = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  const workspaces = await ctx.plugin(WorkspaceRegistry)
  cleanups.push(async () => { await workspaces.dispose() })
  const indexPath = scenario === 'index-failure'
    ? join(root, 'index-directory')
    : join(root, 'session-search.sqlite')
  if (scenario === 'index-failure') await mkdir(indexPath)
  const query = await ctx.plugin(SqliteSessionQueryEngine, {
    path: indexPath,
    openAt: scenario === 'disabled' ? 'never' : 'first-search',
  })
  cleanups.push(async () => { await query.dispose() })
  const sessionId = SessionId(`desktop-${scenario}-session`)
  const session = ctx.sessions.create(sessionId, {
    meta: {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: root,
    },
  })
  const cancelled = { value: 0 }
  const agent = {
    id: session.id, session, status: 'running', ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup(messageValue: ReturnType<typeof createUserMessage>) {
      session.append('user/message', messageValue, { surfaceOp: 'append' })
    },
    steer(messageValue: ReturnType<typeof createUserMessage>) {
      session.append('user/message', messageValue, { surfaceOp: 'append' })
    },
    cancel() { cancelled.value += 1 },
  } as unknown as Agent
  ctx.agents.register(agent)
  const image = (await ctx.attachments.saveImages([{
    mediaType: 'image/png',
    data: readFileSync(new URL('../build/icon.png', import.meta.url)),
  }]))[0]
  if (image === undefined) throw new Error('assembled image admission returned no reference')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: message }, { type: 'image', attachment: image }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'assembled-provider', model: 'assembled-model' }),
    cwd: root,
  })
  const url = await startHttpCarrier(toFetchHandler(api), new WebSocketDownlinks(api))
  return { url, root, sessionId, session, image, cancelled, ctx, agent }
}

async function startHttpCarrier(
  handler: { fetch(request: Request): Promise<Response> },
  downlinks: WebSocketDownlinks,
): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const fetchResponse = await handler.fetch(new Request(
        new URL(request.url ?? '/', 'http://desktop-companion.test'),
        {
          method: request.method ?? 'GET',
          headers: Object.fromEntries(
            Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ),
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        },
      ))
      response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers.entries()))
      if (fetchResponse.body === null) {
        response.end()
        return
      }
      const reader = fetchResponse.body.getReader()
      while (true) {
        const readResult: unknown = await reader.read()
        if (!isRecord(readResult) || typeof readResult.done !== 'boolean') {
          throw new Error('assembled Host stream returned an invalid read result')
        }
        if (readResult.done) break
        if (!(readResult.value instanceof Uint8Array)) {
          throw new Error('assembled Host stream returned an invalid byte chunk')
        }
        response.write(Buffer.from(readResult.value))
      }
      response.end()
    })().catch((error: unknown) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://desktop-companion.test').pathname
    if (pathname === '/api/events.mux') downlinks.handleMux(request, socket, head)
    else if (pathname === '/api/events.host') downlinks.handleHost(request, socket, head)
    else socket.destroy()
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  cleanups.push(async () => {
    await downlinks.close()
    server.closeAllConnections()
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected assembled Host TCP address')
  return `http://127.0.0.1:${String(address.port)}`
}

function productOwner(baseUrl: string): DesktopCompanionProductOwner {
  const owner = new DesktopCompanionProductOwner({
    timeoutMs: 10_000,
    responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    attachmentTimeoutMs: 120_000,
  })
  const uninstall = owner.installHost(baseUrl)
  cleanups.push(async () => { uninstall() })
  return owner
}

async function snowProductChannels(): Promise<{
  mobile: SnowCompanionProtocolChannel
  desktop: SnowCompanionProtocolChannel
  attachmentKey: Uint8Array
  pairingSelector: ReturnType<typeof parseRelayPairingSelector>
  desktopAttachmentId: ReturnType<typeof parseRelayAttachmentId>
  mobileAttachmentId: ReturnType<typeof parseRelayAttachmentId>
  generation: number
}> {
  initializeSnowChannel(readFileSync(new URL(
    '../../../packages/platform/noise-channel/pkg/dsh_noise_channel_bg.wasm', import.meta.url,
  )))
  const desktopPairing = new SnowDesktopEndpointPairingOwner()
  const invitation = await desktopPairing.createInvitation(Date.now() + 60_000)
  const mobilePairing = new SnowMobileHandshakeClient()
  const message1 = await mobilePairing.beginEndpointInvitation(invitation.invitationPayload)
  const message2 = await desktopPairing.acceptMessage1(message1)
  await mobilePairing.acceptDesktopHandshake(message2)
  const message3 = mobilePairing.exportFinishMessage()
  await desktopPairing.finishMessage3(message3)
  const attachmentKey = new Uint8Array(32).fill(43)
  const pairingSelector = parseRelayPairingSelector('pairing-assembled-snow')
  const grant = {
    routeId: parseRelayRouteId('route-assembled-snow'), endpoint: 'mobile' as const,
    credential: await generateRelayCredential(), revision: 1, pairingSelector,
  }
  const sealedGrant = await desktopPairing.sealMobileRelayAuthority(grant, attachmentKey)
  await mobilePairing.openRelayAuthority(sealedGrant)
  expect(mobilePairing.exportAttachmentKey()).toEqual(attachmentKey)
  const desktopAttachmentId = parseRelayAttachmentId('desktop-assembled-snow')
  const mobileAttachmentId = parseRelayAttachmentId('mobile-assembled-snow')
  const generation = 1
  const binding = {
    routeId: grant.routeId, pairingSelector, desktopAttachmentId, mobileAttachmentId, generation,
  }
  const initiator = await beginSnowMobileReconnect(mobilePairing.exportReconnectState(), binding)
  const responder = await acceptSnowDesktopReconnect(desktopPairing.exportReconnectState(), binding, initiator.message1)
  const mobileNegotiation = beginSnowCompanionProtocol(initiator.finish(responder.message2), 'mobile')
  const desktopNegotiation = beginSnowCompanionProtocol(responder.channel, 'desktop')
  return {
    mobile: mobileNegotiation.finish(desktopNegotiation.payload),
    desktop: desktopNegotiation.finish(mobileNegotiation.payload),
    attachmentKey, pairingSelector, desktopAttachmentId, mobileAttachmentId, generation,
  }
}

function synchronizedRuntime(
  mobile: SnowCompanionProtocolChannel,
  desktop: SnowCompanionProtocolChannel,
  generation: number,
): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    routeId: parseRelayRouteId('route-assembled-snow'), endpoint: 'mobile',
    credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as never, revision: 1,
  })
  runtime.markConnectionOpen()
  const receiver = new MobileNoiseCompanionReceiver(mobile, generation, runtime)
  receiver.receive(desktop.seal({
    type: 'projection',
    projection: { type: 'foreground-sync', desktopName: 'Assembled Desktop', generation, desktopRevision: 1 },
  }))
  return runtime
}

function connectedRuntime(): CompanionForegroundRuntime {
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    routeId: parseRelayRouteId('route-assembled-snow'), endpoint: 'mobile',
    credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as never, revision: 1,
  })
  runtime.markConnectionOpen()
  return runtime
}

function pairingDependencies(
  owner: DesktopCompanionProductOwner,
  channels: Awaited<ReturnType<typeof snowProductChannels>>,
): DesktopCompanionPairingDependencies {
  const attachmentKey = channels.attachmentKey.slice()
  return {
    pairingId: parsePersonalPairingId(channels.pairingSelector),
    attachmentKey,
    now: Date.now,
    generation: channels.generation,
    desktopRevision: 1,
    desktopName: 'Assembled Desktop',
    downloadAttachment: () => Promise.reject(new Error('v3 surface test does not download upload capabilities')),
    submitAttachment: () => Promise.reject(new Error('v3 surface test does not submit generic files')),
    resolveInteraction: interactionId => owner.resolveInteraction(interactionId, attachmentKey),
    pendingInteractions: sessionId => owner.pendingInteractions(sessionId, attachmentKey),
  }
}

function isProjection(value: CompanionProjection | CompanionResult): value is CompanionProjection {
  return value.type === 'foreground-sync' || value.type === 'transcript-page'
    || value.type === 'surface-snapshot' || value.type === 'conversation-snapshot'
}

function isResultList(value: DesktopCompanionOperationOutput): value is readonly CompanionResult[] {
  return Array.isArray(value)
}

function isOperationResult(value: unknown, operationId: unknown): boolean {
  return typeof value === 'object' && value !== null && 'operationId' in value
    && value.operationId === operationId
}

async function search(
  owner: DesktopCompanionProductOwner,
  query: string,
  operationId: string,
): Promise<CompanionSessionSearchResult | CompanionOperationFailedResult> {
  const operation: CompanionSearchSessionsOperation = {
    type: 'search-sessions',
    operationId: parseCompanionOperationId(operationId),
    query,
  }
  const output = await owner.handle(operation, {
    pairingId: parsePersonalPairingId('desktop-companion-assembled-pairing'),
    attachmentKey: new Uint8Array(32),
    now: Date.now,
    generation: 1,
    desktopRevision: 1,
    desktopName: 'Assembled Desktop',
    downloadAttachment: () => Promise.reject(new Error('search must not download an attachment')),
    submitAttachment: () => Promise.reject(new Error('search must not submit an attachment')),
    resolveInteraction: () => undefined,
    pendingInteractions: () => [],
  })
  if (isResultList(output) || isProjection(output)
    || (output.type !== 'session-search' && output.type !== 'operation-failed')) {
    throw new Error('assembled search returned an invalid output kind')
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
