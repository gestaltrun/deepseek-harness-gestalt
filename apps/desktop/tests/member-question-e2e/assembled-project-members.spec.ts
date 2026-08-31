import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileMemberQuestionReceiver from '@deepseek-ai/dsh-member-question-receiver'
import CompanionMemberQuestionSender from '@deepseek-ai/dsh-member-question-sender'
import { parseCompanionSessionId, parseMemberQuestionProjectId } from '@deepseek-ai/dsh-remote-protocol'
import { startKeylessMemberQuestionBroker } from './keyless-broker.ts'
import { KeylessMemberQuestionEndpoint } from './keyless-transport.ts'
import { startLocalKeylessPlatform, type KeylessPlatformSession } from './local-platform.ts'

describe('assembled keyless Project Members acceptance', () => {
  it('walks real Account, membership, presence, encrypted ask, and offline failure listeners', { timeout: 30_000 }, async () => {
    const platform = await startLocalKeylessPlatform([
      { providerSubject: 101, login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
      { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
      { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
    ], { heartbeatMs: 25, ttlMs: 100 })
    const broker = await startKeylessMemberQuestionBroker()
    const roots: string[] = []
    const contexts = [new Context(), new Context(), new Context()]
    const [aCtx, b1Ctx, b2Ctx] = contexts as [Context, Context, Context]
    const key = new Uint8Array(32).fill(19)
    let endpoints: KeylessMemberQuestionEndpoint[] = []
    let startedEndpoints: KeylessMemberQuestionEndpoint[] = []
    try {
      const a1 = await platform.signIn('installation-a1')
      const b1 = await platform.signIn('installation-b1')
      const b2 = await platform.signIn('installation-b2')
      expect(b1.accountId).toBe(b2.accountId)
      expect(a1.accountId).not.toBe(b1.accountId)
      endpoints = [
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: String(a1.accountId), installationId: 'installation-a1', key,
          heartbeatMs: 25, pollMs: 5,
        }),
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: String(b1.accountId), installationId: 'installation-b1', key,
          heartbeatMs: 25, pollMs: 5,
        }),
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: String(b2.accountId), installationId: 'installation-b2', key,
          heartbeatMs: 25, pollMs: 5,
        }),
      ]

      const created = await platform.post('/v1/projects', {
        name: 'Atlas', remoteUrl: 'https://github.com/gestaltrun/atlas',
      }, a1)
      expect(created.status).toBe(201)
      const project = await created.json() as { id: string }
      const invited = await platform.post('/v1/projects/invitations', {
        projectId: project.id, githubLogin: b1.githubLogin,
      }, a1)
      expect(invited.status).toBe(201)
      const invitation = await invited.json() as { id: string }
      expect(await pendingCount(platform, b1)).toBe(1)

      const incompleteAcceptance = await platform.post(
        `/v1/projects/invitations/${invitation.id}/decision`,
        { decision: 'accept-with-link' },
        b1,
      )
      expect(incompleteAcceptance.status).toBe(400)
      expect(await pendingCount(platform, b1)).toBe(1)

      const a = endpoints[0]!
      const receiverB1 = await receiver(b1Ctx, endpoints[1]!, roots)
      const receiverB2 = await receiver(b2Ctx, endpoints[2]!, roots)
      await receiverB1.bind(b1.accountId, project.id as never, 'workspace-b1' as never)
      await receiverB2.bind(b2.accountId, project.id as never, 'workspace-b2' as never)
      const accepted = await platform.post(
        `/v1/projects/invitations/${invitation.id}/decision`,
        {
          decision: 'accept-with-link',
          link: { workspaceName: 'Grace local', normalizedRemoteUrl: 'https://github.com/gestaltrun/atlas' },
        },
        b1,
      )
      expect(accepted.status).toBe(200)
      expect(await pendingCount(platform, b1)).toBe(0)

      expect(await rosterPresence(platform, project.id, a1)).toEqual([
        [String(a1.accountId), 'offline'],
        [String(b1.accountId), 'offline'],
      ])
      expect((await platform.heartbeat(a1)).status).toBe(204)
      expect((await platform.heartbeat(b1)).status).toBe(204)
      expect((await platform.heartbeat(b2)).status).toBe(204)
      expect(await rosterPresence(platform, project.id, a1)).toEqual([
        [String(a1.accountId), 'online'],
        [String(b1.accountId), 'online'],
      ])

      await aCtx.plugin(CompanionMemberQuestionSender, {
        delivery: a.delivery,
        presenceLookup: async ({ projectId, peerAccountId }) => {
          const roster = await platform.get(`/v1/projects/${projectId}/members`, a1)
          if (!roster.ok) throw new Error(`roster failed with HTTP ${String(roster.status)}`)
          const view = await roster.json() as { members: Array<{ accountId: string; presence: 'online' | 'offline' }> }
          return view.members.find(member => member.accountId === peerAccountId)?.presence ?? 'offline'
        },
        ttlMs: 5_000,
      })
      await a.start({ sender: aCtx.memberQuestionSender })
      await endpoints[1]!.start({ receiver: receiverB1 })
      await endpoints[2]!.start({ receiver: receiverB2 })
      startedEndpoints = [...endpoints]

      const send = aCtx.memberQuestionSender.send({
        toProjectMember: String(b1.accountId),
        projectId: parseMemberQuestionProjectId(project.id),
        background: 'Review the linked project materials before choosing the rollout.',
        questions: [{ id: 'rollout', question: 'Approve guarded rollout?', options: [{ label: 'approve' }] }],
        references: [{ path: 'decision.md', reason: 'Current decision' }],
        documents: [{ path: 'decision.md', bytes: new TextEncoder().encode('# Guarded rollout\n') }],
        origin: {
          projectName: 'Atlas', originSessionTitle: 'Guarded rollout', askerAccountId: String(a1.accountId),
          askerRole: 'owner', askerDisplayName: 'ada', askerAvatarUrl: 'https://avatars.example/ada.png',
        },
        originSessionId: parseCompanionSessionId('session-a1-assembled'),
      })
      await expect.poll(async () => (await receiverB1.snapshot()).pending.length).toBe(1)
      await expect.poll(async () => (await receiverB2.snapshot()).pending.length).toBe(1)
      const question = (await receiverB1.snapshot()).pending[0]
      await receiverB1.settle(question!.questionId, {
        kind: 'answered',
        answers: [{ id: 'rollout', selected: ['approve'] }],
        settledByInstallationId: 'installation-b1' as never,
        settledByDeviceName: 'Grace B1',
        settledAt: Date.now(),
      })
      await expect(send).resolves.toMatchObject({ outcome: 'answered' })
      await expect.poll(async () => (await receiverB2.snapshot()).terminal.length).toBe(1)
      expect((await receiverB2.snapshot()).terminal[0]?.terminal).toMatchObject({
        settledByInstallationId: 'installation-b1', settledByDeviceName: 'Grace B1',
      })

      const terminalPayload = (originSessionId: string, background: string) => ({
        toProjectMember: String(b1.accountId),
        projectId: parseMemberQuestionProjectId(project.id),
        background,
        questions: [{ id: 'terminal', question: 'Which terminal wins?' }],
        references: [],
        documents: [],
        origin: {
          projectName: 'Atlas', originSessionTitle: background, askerAccountId: String(a1.accountId),
          askerRole: 'owner' as const, askerDisplayName: 'ada', askerAvatarUrl: 'https://avatars.example/ada.png',
        },
        originSessionId: parseCompanionSessionId(originSessionId),
      })
      const expired = aCtx.memberQuestionSender.send(terminalPayload('session-a1-expired', 'Expire assembled ask'))
      await expect(expired).rejects.toMatchObject({ code: 'QUESTION_EXPIRED' })
      await expect.poll(async () => (await receiverB2.snapshot()).terminal.some(row => (
        row.brief.originSessionId === 'session-a1-expired' && row.terminal.outcome === 'expired'
      ))).toBe(true)

      expect((await platform.heartbeat(b1)).status).toBe(204)
      expect((await platform.heartbeat(b2)).status).toBe(204)
      const abort = new AbortController()
      const withdrawn = aCtx.memberQuestionSender.send(
        terminalPayload('session-a1-withdrawn', 'Withdraw assembled ask'),
        { signal: abort.signal },
      )
      await expect.poll(async () => (await receiverB1.snapshot()).pending.some(row => (
        row.operation.originSessionId === 'session-a1-withdrawn'
      ))).toBe(true)
      abort.abort()
      await expect(withdrawn).rejects.toMatchObject({ code: 'QUESTION_WITHDRAWN' })
      await expect.poll(async () => (await receiverB2.snapshot()).terminal.some(row => (
        row.brief.originSessionId === 'session-a1-withdrawn' && row.terminal.outcome === 'withdrawn'
      ))).toBe(true)

      expect((await platform.heartbeat(b1)).status).toBe(204)
      expect((await platform.heartbeat(b2)).status).toBe(204)
      const superseded = aCtx.memberQuestionSender.send(
        terminalPayload('session-a1-superseded', 'Original assembled ask'),
      )
      await expect.poll(async () => (await receiverB1.snapshot()).pending.some(row => (
        row.operation.background === 'Original assembled ask'
      ))).toBe(true)
      expect((await platform.heartbeat(b1)).status).toBe(204)
      expect((await platform.heartbeat(b2)).status).toBe(204)
      const replacement = aCtx.memberQuestionSender.send(
        terminalPayload('session-a1-superseded', 'Replacement assembled ask'),
      )
      await expect(superseded).rejects.toMatchObject({ code: 'QUESTION_SUPERSEDED' })
      await expect.poll(async () => (await receiverB1.snapshot()).pending.some(row => (
        row.operation.background === 'Replacement assembled ask'
      ))).toBe(true)
      const replacementQuestion = (await receiverB1.snapshot()).pending.find(row => (
        row.operation.background === 'Replacement assembled ask'
      ))
      expect(replacementQuestion).toBeDefined()
      await receiverB1.settle(replacementQuestion!.questionId, {
        kind: 'declined',
        settledByInstallationId: 'installation-b1' as never,
        settledByDeviceName: 'Grace B1',
        settledAt: Date.now(),
      })
      await expect(replacement).resolves.toMatchObject({ outcome: 'declined' })

      await endpoints[2]!.stop()
      await endpoints[1]!.stop()
      startedEndpoints = [endpoints[0]!]
      await new Promise(resolve => setTimeout(resolve, 125))
      expect(await rosterPresence(platform, project.id, a1)).toEqual([
        [String(a1.accountId), 'offline'],
        [String(b1.accountId), 'offline'],
      ])
      const deliveries = broker.audit.filter(entry => entry.operation === 'deliver').length
      await expect(aCtx.memberQuestionSender.send({
        toProjectMember: String(b1.accountId),
        projectId: parseMemberQuestionProjectId(project.id),
        background: 'This offline ask must not queue.',
        questions: [{ id: 'offline', question: 'Queued?' }],
        references: [],
        documents: [],
        origin: {
          projectName: 'Atlas', originSessionTitle: 'Offline', askerAccountId: String(a1.accountId),
          askerRole: 'owner', askerDisplayName: 'ada', askerAvatarUrl: 'https://avatars.example/ada.png',
        },
        originSessionId: parseCompanionSessionId('session-a1-offline'),
      })).rejects.toMatchObject({ code: 'MEMBER_OFFLINE' })
      expect(broker.audit.filter(entry => entry.operation === 'deliver')).toHaveLength(deliveries)
      const forbiddenPlaintext = [
        'Review the linked project materials', '# Guarded rollout', 'Approve guarded rollout?', 'approve',
      ]
      for (const retained of [JSON.stringify(broker.audit), await platform.retainedState()]) {
        for (const marker of forbiddenPlaintext) expect(retained).not.toContain(marker)
      }
    } finally {
      for (const endpoint of startedEndpoints.reverse()) await endpoint.stop()
      for (const context of contexts.reverse()) await context.fiber.dispose()
      for (const root of roots) await rm(root, { recursive: true, force: true })
      await broker.close()
      await platform.close()
    }
  })
})

async function receiver(
  context: Context,
  endpoint: KeylessMemberQuestionEndpoint,
  roots: string[],
): Promise<FileMemberQuestionReceiver> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assembled-project-members-receiver-'))
  roots.push(root)
  await context.plugin(FileMemberQuestionReceiver, {
    storagePath: root, environment: 'development', maxRecords: 16, terminalRetryMs: 10,
    terminalAuthority: endpoint.terminalAuthority,
  })
  return context.memberQuestionReceiver as FileMemberQuestionReceiver
}

async function pendingCount(
  platform: Awaited<ReturnType<typeof startLocalKeylessPlatform>>,
  session: KeylessPlatformSession,
): Promise<number> {
  const response = await platform.get('/v1/projects/invitations/pending', session)
  expect(response.status).toBe(200)
  return (await response.json() as unknown[]).length
}

async function rosterPresence(
  platform: Awaited<ReturnType<typeof startLocalKeylessPlatform>>,
  projectId: string,
  session: KeylessPlatformSession,
): Promise<Array<[string, string]>> {
  const response = await platform.get(`/v1/projects/${projectId}/members`, session)
  expect(response.status).toBe(200)
  const view = await response.json() as { members: Array<{ accountId: string; presence: string }> }
  return view.members.map(member => [member.accountId, member.presence])
}
