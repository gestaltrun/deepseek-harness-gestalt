import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  generateRelayCredential,
  parseCompanionOperationId,
  parseRelayAttachmentId,
  parseRelayPairingSelector,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
  type CompanionSearchSessionsOperation,
} from '@deepseek-ai/dsh-remote-protocol'
import {
  acceptSnowDesktopReconnect, beginSnowMobileReconnect, initializeSnowChannel,
  SnowCompanionProtocolChannel, SnowDesktopEndpointPairingOwner, SnowMobileHandshakeClient,
} from '@deepseek-ai/dsh-noise-channel'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type Session } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DesktopCompanionProductOwner } from '../src/companion-product.ts'
import { CompanionForegroundRuntime } from '../../mobile/src/companion-lifecycle.ts'
import {
  MobileSnowCompanionConnection, MobileSnowCompanionProductChannel,
} from '../../mobile/src/noise-companion-product.ts'
import { MobileNoiseCompanionReceiver } from '../../mobile/src/noise-companion.ts'
import { runHost400CodecProbe } from './host-400-codec-probe.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('assembled Desktop Companion Host search', () => {
  it('runs shipped Mobile mutations through Snow into the real Desktop Host', async () => {
    const assembled = await startDesktopHost('indexed', 'assembled Snow search needle')
    const owner = productOwner(assembled.url)
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
    const receiver = new MobileNoiseCompanionReceiver(
      channel.mobile, channel.generation, runtime,
      () => ({ acceptValidatedCompanionResult: (result) => { results.push(result) } }),
    )
    const product = new MobileSnowCompanionProductChannel({
      runtime,
      connection,
      installation: { authorizeCurrentInstallation: async () => ({
        accessToken: 'assembled-current-installation',
        proof: { jti: 'assembled-proof' as never, issuedAt: 1, signature: 'assembled-signature' },
      }) },
      attachmentKeys: { attachmentKeyMaterial: () => channel.attachmentKey.slice() },
      platformOrigin: 'https://operated-platform.test',
      sendCiphertext: async (_target, ciphertext) => {
        const opened = channel.desktop.open(ciphertext)
        if (opened.type !== 'operation') throw new Error('assembled Desktop did not open a Companion operation')
        const result = await owner.handle(opened.operation as never, {
          pairingId: 'pairing-assembled-snow' as never,
          attachmentKey: channel.attachmentKey.slice(),
          now: Date.now,
          downloadAttachment: async () => retainedCiphertext.slice(),
          submitAttachment: async input => await owner.submitAttachment(input),
        })
        receiver.receive(channel.desktop.seal({ type: 'result', result }))
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_input, init) => {
      retainedCiphertext = new Uint8Array(await new Response(init?.body).arrayBuffer())
      return new Response(JSON.stringify({
        capability: 'A'.repeat(43), byteLength: retainedCiphertext.byteLength,
        expiresAt: Date.now() + 60_000,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    try {
      const searchId = product.search('assembled Snow search needle')
      await expect.poll(() => results.some(result => isOperationResult(result, searchId))).toBe(true)
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

async function startDesktopHost(
  scenario: 'indexed' | 'disabled' | 'index-failure',
  message: string,
): Promise<{ url: string; sessionId: string; session: Session }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-companion-assembled-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  const sessions = await ctx.plugin(SessionStore)
  cleanups.push(async () => { await sessions.dispose() })
  const agents = await ctx.plugin(AgentRegistry)
  cleanups.push(async () => { await agents.dispose() })
  const questions = await ctx.plugin(UserQuestionService)
  cleanups.push(async () => { await questions.dispose() })
  const attachments = await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  cleanups.push(async () => { await attachments.dispose() })
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
  ctx.agents.register({
    id: session.id, session, status: 'running', ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'keyless', model: 'assembled' }),
    cwd: root,
  })
  const url = await startHttpCarrier(toFetchHandler(api))
  return { url, sessionId, session }
}

async function startHttpCarrier(handler: { fetch(request: Request): Promise<Response> }): Promise<string> {
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
      response.end(Buffer.from(await fetchResponse.arrayBuffer()))
    })().catch((error: unknown) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  cleanups.push(async () => {
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
  owner.installHost(baseUrl)
  return owner
}

async function snowProductChannels(): Promise<{
  mobile: SnowCompanionProtocolChannel
  desktop: SnowCompanionProtocolChannel
  attachmentKey: Uint8Array
  pairingSelector: ReturnType<typeof parseRelayPairingSelector>
  desktopAttachmentId: ReturnType<typeof parseRelayAttachmentId>
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
  return {
    mobile: new SnowCompanionProtocolChannel(initiator.finish(responder.message2)),
    desktop: new SnowCompanionProtocolChannel(responder.channel),
    attachmentKey, pairingSelector, desktopAttachmentId, generation,
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

function isOperationResult(value: unknown, operationId: unknown): boolean {
  return typeof value === 'object' && value !== null && 'operationId' in value
    && value.operationId === operationId
}

async function search(owner: DesktopCompanionProductOwner, query: string, operationId: string) {
  const operation: CompanionSearchSessionsOperation = {
    type: 'search-sessions',
    operationId: parseCompanionOperationId(operationId),
    query,
  }
  return await owner.handle(operation, {
    pairingId: parsePersonalPairingId('desktop-companion-assembled-pairing'),
    attachmentKey: new Uint8Array(32),
    now: Date.now,
    downloadAttachment: () => Promise.reject(new Error('search must not download an attachment')),
    submitAttachment: () => Promise.reject(new Error('search must not submit an attachment')),
  })
}
