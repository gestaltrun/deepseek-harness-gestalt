/** Host receiver snapshot -> outward SessionRuntime projection. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  HostFrame, MemberQuestionReceiverSnapshot, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFace } from '../src/client/contract/session.ts'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import type { PendingWait } from '../src/client/sessions/pending.ts'
import { err, FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

const operation = {
  type: 'member-question' as const,
  operationId: 'operation-1' as never,
  questionId: 'question-1' as never,
  projectId: 'project-1' as never,
  originSessionId: 'origin-session-1' as never,
  expiresAt: 10_000,
  origin: {
    projectName: 'Atlas',
    originSessionTitle: 'Release decision',
    askerAccountId: 'account-alice',
    askerRole: 'owner' as const,
    askerDisplayName: 'Alice',
    askerAvatarUrl: 'https://example.com/alice.png',
  },
  background: 'Choose the launch channel.',
  questions: [{ id: 'channel', question: 'Which channel?', options: [{ label: 'Canary' }, { label: 'Stable' }] }],
  references: [{ path: 'docs/architecture.md', reason: 'Rollout constraints' }],
}

function snapshot(
  revision: number,
  state: 'pending' | 'answered' | 'declined' | 'expired' | 'withdrawn' | 'superseded',
  settledByInstallationId = 'installation-a',
): MemberQuestionReceiverSnapshot {
  const base = {
    questionId: operation.questionId,
    receivingSessionId: 'receiving-host-1' as never,
    receivingAccountId: 'account-receiver' as never,
    revision,
    arrivedAt: 100,
  }
  if (state === 'pending') return { revision, pending: [{ ...base, operation }], terminal: [] }
  const terminal = state === 'answered'
    ? {
      type: 'member-question-settled' as const,
      operationId: operation.operationId,
      questionId: operation.questionId,
      outcome: state,
      settledByInstallationId: settledByInstallationId as never,
      settledByDeviceName: settledByInstallationId === 'installation-a' ? 'Desk A' : 'Desk B',
      settledAt: 500,
      answers: [{ id: 'channel', selected: ['Canary'] }],
    }
    : state === 'declined'
      ? {
        type: 'member-question-settled' as const,
        operationId: operation.operationId,
        questionId: operation.questionId,
        outcome: state,
        settledByInstallationId: settledByInstallationId as never,
        settledByDeviceName: 'Desk A',
        settledAt: 500,
      }
      : {
        type: 'member-question-settled' as const,
        operationId: operation.operationId,
        questionId: operation.questionId,
        outcome: state,
        settledAt: 500,
      }
  return { revision, pending: [], terminal: [{ ...base, terminal, brief: operation }] }
}

function envelope(snapshotValue: MemberQuestionReceiverSnapshot, currentInstallationId?: string) {
  return {
    rpcId: `frame-${String(snapshotValue.revision)}` as never,
    payload: {
      type: 'host/member-question-snapshot',
      snapshot: snapshotValue,
      ...(currentInstallationId === undefined ? {} : { currentInstallationId: currentInstallationId as never }),
    } satisfies HostFrame,
  }
}

function bench(currentInstallationId?: string) {
  const ctx = new Context()
  const api = new FakeApiClient()
  const runtime = new SessionRuntime(ctx, api, fakeRemote(), undefined,
    currentInstallationId === undefined ? {} : { currentInstallationId })
  return { api, runtime }
}

function face(runtime: SessionRuntime): SessionFace {
  return runtime.currentProvideInfo.getSnapshot().hooks['session'] as SessionFace
}

describe('Host-authoritative receiving projection', () => {
  it('uses the Host receiving identity and routes a pre-materialization prompt through admission', async () => {
    const { api, runtime } = bench()
    runtime.handleHostEnvelope(envelope(snapshot(1, 'pending')))
    await Promise.resolve()
    const receivingId = 'receiving-host-1' as SessionId
    expect(runtime.list.getSnapshot().byId[receivingId]).toMatchObject({
      title: 'Atlas — Release decision',
      pendingInteraction: 'question',
    })
    runtime.open(receivingId)
    const wait = face(runtime).getSnapshot().pending[0] as PendingWait<'question'>
    expect(wait.payload.questions[0]?.intent).toMatchObject({
      kind: 'member-question',
      questionId: 'question-1',
    })
    expect(face(runtime).getSnapshot().composerPhase).toBe('active')
    await expect(face(runtime).prompt([{ type: 'text', text: 'Help me decide.' }], 'queue'))
      .resolves.toMatchObject({ ok: true })
    expect(api.callsOf('memberQuestion.admitHumanTurn')).toEqual([{
      receivingSessionId: 'receiving-host-1',
      revision: 1,
      content: [{ type: 'text', text: 'Help me decide.' }],
      mode: 'queue',
    }])
    expect(api.callsOf('session.create')).toEqual([])
    expect(api.callsOf('session.history')).toEqual([])
    expect(api.callsOf('session.prompt')).toEqual([])
    expect(runtime.modelRoute(receivingId)).toBeUndefined()
  })

  it('keeps a Host-listed receiving Session visible under its origin title', async () => {
    const { runtime } = bench()
    runtime.handleHostEnvelope({
      rpcId: 'host-added' as never,
      payload: {
        type: 'host/session-added',
        sessionId: 'receiving-host-1' as never,
        blank: true,
      },
    })
    runtime.handleHostEnvelope(envelope({
      revision: 1,
      pending: [{
        ...snapshot(1, 'pending').pending[0]!,
        hostSessionId: 'receiving-host-1' as never,
      }],
      terminal: [],
    }))
    await Promise.resolve()
    expect(runtime.list.getSnapshot().byId['receiving-host-1' as SessionId]).toMatchObject({
      title: 'Atlas — Release decision',
      blank: false,
      pendingInteraction: 'question',
    })
  })

  it('restores a reserved admission rpcId from the Host snapshot after Client restart', async () => {
    const { api, runtime } = bench()
    const pending = snapshot(4, 'pending').pending[0]!
    runtime.handleHostEnvelope(envelope({
      revision: 4,
      pending: [{
        ...pending,
        hostSessionId: pending.receivingSessionId as never,
        reservedAdmission: { rpcId: 'reserved-human-turn' as never, mode: 'queue' },
      }],
      terminal: [],
    }))
    runtime.open('receiving-host-1' as SessionId)
    await expect(face(runtime).prompt([{ type: 'text', text: 'Retry retained text.' }], 'queue'))
      .resolves.toMatchObject({ ok: true })
    expect(api.memberQuestionAdmissionRpcIds).toEqual(['reserved-human-turn'])
  })

  it('clears a failed admission error when the stable human action succeeds on retry', async () => {
    const { api, runtime } = bench()
    runtime.handleHostEnvelope(envelope(snapshot(1, 'pending')))
    runtime.open('receiving-host-1' as SessionId)
    api.onMemberQuestionAdmit = () => Promise.resolve(err({
      code: 'internal', message: 'temporary admission failure', details: {},
    }))
    const receiving = face(runtime)
    await receiving.prompt([{ type: 'text', text: 'Retry this action.' }], 'queue')
    expect(receiving.getSnapshot().promptError).toMatchObject({ error: { message: 'temporary admission failure' } })

    api.onMemberQuestionAdmit = payload => Promise.resolve(ok({
      accepted: true, sessionId: payload.receivingSessionId,
    }))
    await receiving.prompt([{ type: 'text', text: 'Retry this action.' }], 'queue')
    expect(receiving.getSnapshot().promptError).toBeNull()
    expect(new Set(api.memberQuestionAdmissionRpcIds).size).toBe(1)
  })

  it('routes shared presentation answers and cancellation through Host settle RPC', async () => {
    const { api, runtime } = bench()
    runtime.handleHostEnvelope(envelope(snapshot(1, 'pending')))
    runtime.open('receiving-host-1' as SessionId)
    const answered = face(runtime).getSnapshot().pending[0]!
    await expect(answered.respond({
      ok: true,
      value: {
        sessionId: 'origin-session-1',
        answer: { answers: [{ id: 'channel', selected: ['Canary'] }] },
      },
    })).resolves.toEqual({ accepted: true })
    expect(api.callsOf('memberQuestion.settle')).toEqual([{
      receivingSessionId: 'receiving-host-1',
      revision: 1,
      questionId: 'question-1',
      response: { kind: 'answered', answers: [{ id: 'channel', selected: ['Canary'] }] },
    }])

    runtime.handleHostEnvelope(envelope(snapshot(2, 'pending')))
    const declined = face(runtime).getSnapshot().pending[0]!
    await expect(declined.respond({
      ok: false,
      error: { code: 'cancelled', message: 'decline', details: {} },
    })).resolves.toEqual({ accepted: true })
    expect(api.callsOf('memberQuestion.settle')[1]).toMatchObject({ response: { kind: 'declined' } })
  })

  it('keeps pending state over disconnect and converges terminal state from the Host feed', async () => {
    const { runtime } = bench()
    runtime.handleHostEnvelope(envelope(snapshot(1, 'pending')))
    runtime.open('receiving-host-1' as SessionId)
    const first = face(runtime).getSnapshot().pending[0]!
    runtime.handleDisconnected()
    expect(face(runtime).getSnapshot().pending[0]).toBe(first)
    runtime.handleHostEnvelope(envelope(snapshot(2, 'expired')))
    const projected = face(runtime).getSnapshot()
    expect(projected.pending).toEqual([])
    expect(projected.memberQuestionRecords).toMatchObject([{ state: 'expired', terminalAt: 500 }])
    expect(runtime.list.getSnapshot().byId['receiving-host-1' as SessionId]).toBeDefined()
  })

  it('takes supersede and withdrawal only from higher Host revisions', () => {
    const { runtime } = bench()
    runtime.handleHostEnvelope(envelope(snapshot(3, 'superseded')))
    runtime.open('receiving-host-1' as SessionId)
    expect(face(runtime).getSnapshot().memberQuestionRecords?.[0]?.state).toBe('superseded')
    runtime.handleHostEnvelope(envelope(snapshot(2, 'withdrawn')))
    expect(face(runtime).getSnapshot().memberQuestionRecords?.[0]?.state).toBe('superseded')
    runtime.handleHostEnvelope(envelope(snapshot(4, 'withdrawn')))
    expect(face(runtime).getSnapshot().memberQuestionRecords?.[0]?.state).toBe('withdrawn')
  })

  it('derives answered-elsewhere independently for two Client Installation contexts', () => {
    const first = bench(undefined).runtime
    const second = bench(undefined).runtime
    first.handleHostEnvelope(envelope(snapshot(2, 'answered', 'installation-a'), 'installation-a'))
    second.handleHostEnvelope(envelope(snapshot(2, 'answered', 'installation-a'), 'installation-b'))
    first.open('receiving-host-1' as SessionId)
    second.open('receiving-host-1' as SessionId)
    expect(face(first).getSnapshot().memberQuestionRecords).toEqual([])
    expect(face(second).getSnapshot().memberQuestionRecords).toMatchObject([{
      state: 'answered-elsewhere', settledByDeviceName: 'Desk A', terminalAt: 500,
    }])
  })
})
