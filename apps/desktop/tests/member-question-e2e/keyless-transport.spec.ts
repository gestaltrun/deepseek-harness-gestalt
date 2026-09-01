import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileMemberQuestionReceiver from '@deepseek-ai/dsh-member-question-receiver'
import CompanionMemberQuestionSender from '@deepseek-ai/dsh-member-question-sender'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseCompanionSessionId,
  parseMemberQuestionProjectId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import { startKeylessMemberQuestionBroker, type KeylessMemberQuestionBroker } from './keyless-broker.ts'
import { KeylessMemberQuestionEndpoint } from './keyless-transport.ts'

const contexts: Context[] = []
const endpoints: KeylessMemberQuestionEndpoint[] = []
const roots: string[] = []
const servers: Server[] = []
let broker: KeylessMemberQuestionBroker | undefined

afterEach(async () => {
  for (const endpoint of endpoints.splice(0).reverse()) await endpoint.stop()
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  await broker?.close()
  broker = undefined
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('keyless member-question encrypted listener', () => {
  it('fans one chunked question to two receiving Installations and retains the first answer', async () => {
    broker = await startKeylessMemberQuestionBroker()
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
    const a = endpoint('account-a', 'installation-a1', key)
    const b1 = endpoint('account-b', 'installation-b1', key)
    const b2 = endpoint('account-b', 'installation-b2', key)
    const aCtx = new Context()
    const b1Ctx = new Context()
    const b2Ctx = new Context()
    contexts.push(aCtx, b1Ctx, b2Ctx)
    await aCtx.plugin(CompanionMemberQuestionSender, {
      delivery: a.delivery,
      presenceLookup: a.presenceLookup,
      ttlMs: 10_000,
    })
    const b1Receiver = await receiver(b1Ctx, b1)
    const b2Receiver = await receiver(b2Ctx, b2)
    await a.start({ sender: aCtx.memberQuestionSender })
    await b1.start({ receiver: b1Receiver })
    await b2.start({ receiver: b2Receiver })

    const markdown = new TextEncoder().encode('# Rollout\nKeep the current owner.\n')
    const html = new TextEncoder().encode('<p>Use the guarded path.</p>')
    const binary = Uint8Array.from(
      { length: REMOTE_PROTOCOL_LIMITS.documentTransferChunkBytes * 2 + 7 },
      (_, index) => index % 251,
    )
    const pending = aCtx.memberQuestionSender.send({
      toProjectMember: 'account-b',
      projectId: parseMemberQuestionProjectId('project-atlas'),
      background: 'Choose the deployment path after reviewing all three materials.',
      questions: [{
        id: 'route',
        question: 'Which path should we use?',
        options: [{ label: 'guarded' }, { label: 'direct' }],
      }],
      references: [
        { path: 'rollout.md', reason: 'Markdown plan' },
        { path: 'preview.html', reason: 'Restricted preview' },
        { path: 'payload.bin', reason: 'Arbitrary chunked bytes' },
      ],
      documents: [
        { path: 'rollout.md', bytes: markdown },
        { path: 'preview.html', bytes: html },
        { path: 'payload.bin', bytes: binary },
      ],
      origin: {
        projectName: 'Atlas',
        originSessionTitle: 'Ship guarded rollout',
        askerAccountId: 'account-a',
        askerRole: 'owner',
        askerDisplayName: 'Ada',
        askerAvatarUrl: 'https://avatars.example/ada.png',
      },
      originSessionId: parseCompanionSessionId('session-a1'),
    })

    await expect.poll(async () => (await b1Receiver.snapshot()).pending.length).toBe(1)
    await expect.poll(async () => (await b2Receiver.snapshot()).pending.length).toBe(1)
    const b1Pending = (await b1Receiver.snapshot()).pending[0]
    const b2Pending = (await b2Receiver.snapshot()).pending[0]
    expect(b1Pending?.questionId).toBe(b2Pending?.questionId)
    expect(b1Pending?.operation.references).toEqual([
      { path: 'rollout.md', reason: 'Markdown plan', content: new TextDecoder().decode(markdown) },
      { path: 'preview.html', reason: 'Restricted preview', content: new TextDecoder().decode(html) },
      { path: 'payload.bin', reason: 'Arbitrary chunked bytes' },
    ])

    await b1Receiver.settle(b1Pending!.questionId, {
      kind: 'answered',
      answers: [{ id: 'route', selected: ['guarded'] }],
      settledByInstallationId: parseInstallationId('installation-b1'),
      settledByDeviceName: 'Receiver B1',
      settledAt: 1_788_089_400_000,
    })
    await expect(pending).resolves.toMatchObject({
      outcome: 'answered',
      answers: [{ id: 'route', selected: ['guarded'] }],
    })
    await expect.poll(async () => (await b2Receiver.snapshot()).terminal.length).toBe(1)
    expect((await b2Receiver.snapshot()).terminal[0]?.terminal).toMatchObject({
      outcome: 'answered',
      settledByInstallationId: 'installation-b1',
      settledByDeviceName: 'Receiver B1',
    })

    const audit = JSON.stringify(broker.audit)
    for (const plaintext of [
      'Choose the deployment path', '# Rollout', '<p>Use the guarded path.</p>', 'guarded',
    ]) expect(audit).not.toContain(plaintext)
    expect(broker.audit.map(entry => entry.operation)).toContain('deliver')
    expect(broker.audit.map(entry => entry.operation)).toContain('terminal')
  })

  it('fails offline without queuing a question', async () => {
    broker = await startKeylessMemberQuestionBroker()
    const key = new Uint8Array(32).fill(7)
    const a = endpoint('account-a', 'installation-a1', key)
    const aCtx = new Context()
    contexts.push(aCtx)
    await aCtx.plugin(CompanionMemberQuestionSender, {
      delivery: a.delivery,
      presenceLookup: a.presenceLookup,
    })
    await a.start({ sender: aCtx.memberQuestionSender })

    await expect(aCtx.memberQuestionSender.send({
      toProjectMember: 'account-b',
      projectId: parseMemberQuestionProjectId('project-atlas'),
      background: 'This ask must not be queued.',
      questions: [{ id: 'q', question: 'Ship?' }],
      references: [],
      origin: {
        projectName: 'Atlas', originSessionTitle: 'Offline check', askerAccountId: 'account-a',
        askerRole: 'owner', askerDisplayName: 'Ada', askerAvatarUrl: 'https://avatars.example/ada.png',
      },
      originSessionId: parseCompanionSessionId('session-offline'),
    })).rejects.toMatchObject({ code: 'MEMBER_OFFLINE' })
    expect(broker.audit.some(entry => entry.operation === 'deliver')).toBe(false)
  })

  it('propagates expiry, withdrawal, and supersession through the listener', async () => {
    broker = await startKeylessMemberQuestionBroker()
    const key = new Uint8Array(32).fill(11)
    const a = endpoint('account-a', 'installation-a1', key)
    const b = endpoint('account-b', 'installation-b1', key)
    const aCtx = new Context()
    const bCtx = new Context()
    contexts.push(aCtx, bCtx)
    await aCtx.plugin(CompanionMemberQuestionSender, {
      delivery: a.delivery,
      presenceLookup: a.presenceLookup,
      ttlMs: 100,
    })
    const bReceiver = await receiver(bCtx, b)
    await a.start({ sender: aCtx.memberQuestionSender })
    await b.start({ receiver: bReceiver })

    const expired = aCtx.memberQuestionSender.send(questionPayload('session-expired', 'Expires'))
    await expect(expired).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' })
    await expect.poll(async () => (await bReceiver.snapshot()).terminal
      .some(row => row.terminal.outcome === 'expired')).toBe(true)

    const abort = new AbortController()
    const withdrawn = aCtx.memberQuestionSender.send(
      questionPayload('session-withdrawn', 'Withdrawn'),
      { signal: abort.signal },
    )
    await expect.poll(async () => (await bReceiver.snapshot()).pending
      .some(row => row.operation.originSessionId === 'session-withdrawn')).toBe(true)
    abort.abort()
    await expect(withdrawn).rejects.toMatchObject({ code: 'QUESTION_WITHDRAWN' })
    await expect.poll(async () => (await bReceiver.snapshot()).terminal
      .some(row => row.brief.originSessionId === 'session-withdrawn'
        && row.terminal.outcome === 'withdrawn')).toBe(true)

    const first = aCtx.memberQuestionSender.send(questionPayload('session-superseded', 'First'))
    await expect.poll(async () => (await bReceiver.snapshot()).pending
      .some(row => row.operation.originSessionId === 'session-superseded')).toBe(true)
    const second = aCtx.memberQuestionSender.send(questionPayload('session-superseded', 'Second'))
    await expect(first).rejects.toMatchObject({ code: 'QUESTION_SUPERSEDED' })
    await expect.poll(async () => (await bReceiver.snapshot()).terminal
      .some(row => row.brief.background === 'First'
        && row.terminal.outcome === 'superseded')).toBe(true)
    await expect.poll(async () => (await bReceiver.snapshot()).pending
      .some(row => row.operation.background === 'Second')).toBe(true)
    const secondQuestion = (await bReceiver.snapshot()).pending.find(row => row.operation.background === 'Second')
    expect(secondQuestion).toBeDefined()
    await bReceiver.settle(secondQuestion!.questionId, {
      kind: 'declined',
      settledByInstallationId: parseInstallationId('installation-b1'),
      settledByDeviceName: 'Receiver B1',
      settledAt: Date.now(),
    })
    await expect(second).resolves.toMatchObject({ outcome: 'declined' })
  })

  it('quiesces polling when presence removal fails during shutdown', async () => {
    let eventPolls = 0
    let presenceRemovals = 0
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        response.end('{"online":true}')
        return
      }
      if (request.method === 'DELETE') {
        presenceRemovals += 1
        response.writeHead(503)
        response.end('{"error":"unavailable"}')
        return
      }
      eventPolls += 1
      response.end('{"events":[],"cursor":0}')
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test listener exposed no TCP address')
    const client = new KeylessMemberQuestionEndpoint({
      origin: `http://127.0.0.1:${String(address.port)}`,
      accountId: parsePlatformAccountId('account-a'),
      installationId: parseInstallationId('installation-a1'),
      key: new Uint8Array(32).fill(17),
      heartbeatMs: 10,
      pollMs: 5,
    })
    endpoints.push(client)
    await client.start()
    await expect.poll(() => eventPolls).toBeGreaterThan(0)

    await expect(client.stop()).rejects.toThrow('keyless presence removal failed with HTTP 503')
    expect(presenceRemovals).toBe(1)
    const stoppedPolls = eventPolls
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(eventPolls).toBe(stoppedPolls)
    await expect(client.stop()).resolves.toBeUndefined()
    endpoints.pop()
  })

  it('bounds a stalled presence removal before joining the polling loop', async () => {
    let eventPolls = 0
    const server = createServer((request, response) => {
      if (request.method === 'DELETE') return
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        response.end('{"online":true}')
        return
      }
      eventPolls += 1
      response.end('{"events":[],"cursor":0}')
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test listener exposed no TCP address')
    const client = new KeylessMemberQuestionEndpoint({
      origin: `http://127.0.0.1:${String(address.port)}`,
      accountId: parsePlatformAccountId('account-a'),
      installationId: parseInstallationId('installation-a1'),
      key: new Uint8Array(32).fill(23),
      heartbeatMs: 10,
      pollMs: 5,
      shutdownMs: 20,
    })
    endpoints.push(client)
    await client.start()
    await expect.poll(() => eventPolls).toBeGreaterThan(0)

    const startedAt = Date.now()
    await expect(client.stop()).rejects.toThrow()
    expect(Date.now() - startedAt).toBeLessThan(500)
    const stoppedPolls = eventPolls
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(eventPolls).toBe(stoppedPolls)
    await expect(client.stop()).resolves.toBeUndefined()
    endpoints.pop()
  })
})

function questionPayload(originSessionId: string, background: string) {
  return {
    toProjectMember: 'account-b',
    projectId: parseMemberQuestionProjectId('project-atlas'),
    background,
    questions: [{ id: 'q', question: 'Ship?' }],
    references: [],
    origin: {
      projectName: 'Atlas', originSessionTitle: background, askerAccountId: 'account-a',
      askerRole: 'owner' as const, askerDisplayName: 'Ada', askerAvatarUrl: 'https://avatars.example/ada.png',
    },
    originSessionId: parseCompanionSessionId(originSessionId),
  }
}

function endpoint(accountId: string, installationId: string, key: Uint8Array): KeylessMemberQuestionEndpoint {
  if (broker === undefined) throw new Error('broker is not running')
  const created = new KeylessMemberQuestionEndpoint({
    origin: broker.origin,
    accountId: parsePlatformAccountId(accountId),
    installationId: parseInstallationId(installationId),
    key,
    heartbeatMs: 200,
    pollMs: 5,
  })
  endpoints.push(created)
  return created
}

async function receiver(
  context: Context,
  endpointClient: KeylessMemberQuestionEndpoint,
): Promise<FileMemberQuestionReceiver> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keyless-member-question-receiver-'))
  roots.push(root)
  await context.plugin(FileMemberQuestionReceiver, {
    storagePath: root,
    environment: 'development',
    maxRecords: 16,
    terminalRetryMs: 10,
    terminalAuthority: endpointClient.terminalAuthority,
  })
  return context.memberQuestionReceiver as FileMemberQuestionReceiver
}
