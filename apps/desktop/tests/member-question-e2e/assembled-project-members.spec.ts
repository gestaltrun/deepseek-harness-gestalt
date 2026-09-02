import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileMemberQuestionReceiver from '@deepseek-ai/dsh-member-question-receiver'
import CompanionMemberQuestionSender from '@deepseek-ai/dsh-member-question-sender'
import { parseInstallationId } from '@deepseek-ai/dsh-platform-account'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { parseCompanionSessionId, parseMemberQuestionProjectId } from '@deepseek-ai/dsh-remote-protocol'
import { startKeylessMemberQuestionBroker } from './keyless-broker.ts'
import { KeylessMemberQuestionEndpoint } from './keyless-transport.ts'
import { startLocalKeylessPlatform, type KeylessPlatformSession } from './local-platform.ts'

describe('assembled keyless Project Members acceptance', () => {
  it('walks real Account, membership, presence, encrypted ask, and offline failure listeners', { timeout: 30_000 }, async () => {
    const roots: string[] = []
    const contexts = [new Context(), new Context(), new Context()]
    const [aCtx, b1Ctx, b2Ctx] = contexts as [Context, Context, Context]
    const key = new Uint8Array(32).fill(19)
    let endpoints: KeylessMemberQuestionEndpoint[] = []
    let startedEndpoints: KeylessMemberQuestionEndpoint[] = []
    let platform: Awaited<ReturnType<typeof startLocalKeylessPlatform>> | undefined
    let broker: Awaited<ReturnType<typeof startKeylessMemberQuestionBroker>> | undefined
    try {
      platform = await startLocalKeylessPlatform([
        { providerSubject: 101, login: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
        { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
        { providerSubject: 202, login: 'grace', avatarUrl: 'https://avatars.example/grace.png' },
      ], { heartbeatMs: 25, ttlMs: 100 })
      broker = await startKeylessMemberQuestionBroker()
      const a1 = await platform.signIn(parseInstallationId('installation-a1'))
      const b1 = await platform.signIn(parseInstallationId('installation-b1'))
      const b2 = await platform.signIn(parseInstallationId('installation-b2'))
      expect(b1.accountId).toBe(b2.accountId)
      expect(a1.accountId).not.toBe(b1.accountId)
      endpoints = [
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: a1.accountId, installationId: parseInstallationId('installation-a1'), key,
          heartbeatMs: 25, pollMs: 5,
        }),
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: b1.accountId, installationId: parseInstallationId('installation-b1'), key,
          heartbeatMs: 25, pollMs: 5,
        }),
        new KeylessMemberQuestionEndpoint({
          origin: broker.origin, accountId: b2.accountId, installationId: parseInstallationId('installation-b2'), key,
          heartbeatMs: 25, pollMs: 5,
        }),
      ]

      const created = await platform.post('/v1/projects', {
        name: 'Atlas', remoteUrl: 'https://github.com/gestaltrun/atlas',
      }, a1)
      expect(created.status).toBe(201)
      const project = await created.json() as { id: string }
      const invited = await platform.post('/v1/projects/invitations', {
        projectId: project.id, githubLogin: b1.githubLogin, grantedRole: 'member',
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
      const projectId = parseMemberQuestionProjectId(project.id)
      await receiverB1.bind(b1.accountId, projectId, WorkspaceId('workspace-b1'))
      await receiverB2.bind(b2.accountId, projectId, WorkspaceId('workspace-b2'))
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

      const membershipPlatform = platform
      await aCtx.plugin(CompanionMemberQuestionSender, {
        delivery: a.delivery,
        presenceLookup: async ({ projectId, peerAccountId }) => {
          const roster = await membershipPlatform.get(`/v1/projects/${projectId}/members`, a1)
          if (!roster.ok) throw new Error(`roster failed with HTTP ${String(roster.status)}`)
          const view = await roster.json() as { members: Array<{ accountId: string; presence: 'online' | 'offline' }> }
          return view.members.find(member => member.accountId === peerAccountId)?.presence ?? 'offline'
        },
        ttlMs: 5_000,
      })
      await a.start({ sender: aCtx.memberQuestionSender })
      startedEndpoints.push(a)
      await endpoints[1]!.start({ receiver: receiverB1 })
      startedEndpoints.push(endpoints[1]!)
      await endpoints[2]!.start({ receiver: receiverB2 })
      startedEndpoints.push(endpoints[2]!)

      const send = aCtx.memberQuestionSender.send({
        toProjectMember: String(b1.accountId),
        projectId: parseMemberQuestionProjectId(project.id),
        background: 'Review the linked project materials before choosing the rollout.',
        questions: [{
          id: 'rollout',
          question: 'Approve guarded rollout?',
          options: [{ label: 'approve' }, { label: 'revise' }],
        }],
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
      const questionB1 = (await receiverB1.snapshot()).pending[0]
      const questionB2 = (await receiverB2.snapshot()).pending[0]
      const settledAt = Date.now()
      const [canonicalB1, canonicalB2] = await Promise.all([
        receiverB1.settle(questionB1!.questionId, {
          kind: 'answered',
          answers: [{ id: 'rollout', selected: ['approve'] }],
          settledByInstallationId: parseInstallationId('installation-b1'),
          settledByDeviceName: 'Grace B1',
          settledAt,
        }),
        receiverB2.settle(questionB2!.questionId, {
          kind: 'answered',
          answers: [{ id: 'rollout', selected: ['revise'] }],
          settledByInstallationId: parseInstallationId('installation-b2'),
          settledByDeviceName: 'Grace B2',
          settledAt,
        }),
      ])
      expect(canonicalB1).toEqual(canonicalB2)
      expect(canonicalB1.outcome).toBe('answered')
      if (canonicalB1.outcome !== 'answered') throw new Error('answer competition produced a system terminal')
      expect(['installation-b1', 'installation-b2']).toContain(canonicalB1.settledByInstallationId)
      const winningSelection = canonicalB1.settledByInstallationId === 'installation-b1'
        ? 'approve'
        : 'revise'
      expect(canonicalB1).toMatchObject({
        outcome: 'answered',
        answers: [{ id: 'rollout', selected: [winningSelection] }],
      })
      await expect(send).resolves.toMatchObject({
        outcome: 'answered',
        answers: [{ id: 'rollout', selected: [winningSelection] }],
      })
      await Promise.all([
        expect.poll(async () => (await receiverB1.snapshot()).terminal.length).toBe(1),
        expect.poll(async () => (await receiverB2.snapshot()).terminal.length).toBe(1),
      ])
      expect((await receiverB1.snapshot()).terminal[0]?.terminal).toEqual(canonicalB1)
      expect((await receiverB2.snapshot()).terminal[0]?.terminal).toEqual(canonicalB1)

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
      expect((await platform.heartbeat(b1)).status).toBe(204)
      expect((await platform.heartbeat(b2)).status).toBe(204)
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
        settledByInstallationId: parseInstallationId('installation-b1'),
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
      const cleanup = [
        ...await Promise.allSettled(startedEndpoints.toReversed().map(endpoint => endpoint.stop())),
        ...await Promise.allSettled(contexts.toReversed().map(context => context.fiber.dispose())),
        ...await Promise.allSettled([
          ...roots.map(root => rm(root, { recursive: true, force: true })),
          ...(broker === undefined ? [] : [broker.close()]),
          ...(platform === undefined ? [] : [platform.close()]),
        ]),
      ]
      const failures: unknown[] = []
      for (const result of cleanup) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'assembled Project Members cleanup failed')
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
