import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as MemberQuestionSenderInvariant from '../src/invariant.ts'

const projectId = parseMemberQuestionProjectId('project-atlas')
const originSessionId = parseCompanionSessionId('session-origin')

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(MemberQuestionSenderInvariant)
  return ctx
}

describe('member-question sender invariants', () => {
  it('accepts a paired asked/outcome record', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('mq-ok'))
    session.append('turn/start', { turn: 1 })
    const questionId = parseMemberQuestionId('mqpaired')
    session.append('member-question/asked', {
      questionId,
      toProjectMember: 'account-peer',
      projectId,
      background: 'Need a rollback window.',
      questions: [{ id: 'q-1', question: 'Ship it?' }],
      originSessionId,
    })
    session.append('member-question/outcome', { questionId, outcome: 'answered', answers: [{ id: 'q-1', selected: ['yes'] }] })
  })

  it('rejects an outcome without a matching asked record', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('mq-orphan'))
    expect(() => session.append('member-question/outcome', {
      questionId: parseMemberQuestionId('mqmissing'),
      outcome: 'expired',
    })).toThrow(/no matching member-question\/asked/)
  })

  it('rejects a repeated asked id', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('mq-dup'))
    const questionId = parseMemberQuestionId('mqdup')
    const asked = {
      questionId,
      toProjectMember: 'account-peer',
      projectId,
      background: 'Need a rollback window.',
      questions: [{ id: 'q-1', question: 'Ship it?' }],
      originSessionId,
    }
    session.append('member-question/asked', asked)
    expect(() => session.append('member-question/asked', asked)).toThrow(/repeated open id/)
  })

  it('rebuilds unmatched asked records from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('mq-resume'))
    session.append('turn/start', { turn: 1 })
    const questionId = parseMemberQuestionId('mqresume')
    session.append('member-question/asked', {
      questionId,
      toProjectMember: 'account-peer',
      projectId,
      background: 'Need a rollback window.',
      questions: [{ id: 'q-1', question: 'Ship it?' }],
      originSessionId,
    })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(MemberQuestionSenderInvariant)
    expect(() => session.append('member-question/outcome', { questionId, outcome: 'withdrawn' })).not.toThrow()
  })

  it('rejects an empty questionId and an unknown outcome', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('mq-bad'))
    expect(() => session.append('member-question/asked', {
      questionId: '' as never,
      toProjectMember: 'account-peer',
      projectId,
      background: 'Need a rollback window.',
      questions: [{ id: 'q-1', question: 'Ship it?' }],
      originSessionId,
    })).toThrow(/questionId must be non-empty/)
    const questionId = parseMemberQuestionId('mqbadout')
    session.append('member-question/asked', {
      questionId,
      toProjectMember: 'account-peer',
      projectId,
      background: 'Need a rollback window.',
      questions: [{ id: 'q-1', question: 'Ship it?' }],
      originSessionId,
    })
    expect(() => session.append('member-question/outcome', { questionId, outcome: 'maybe' as never }))
      .toThrow(/unknown outcome/)
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('mq-bare'))
    const questionId = parseMemberQuestionId('mqbare')
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'member-question/asked',
        seq: 1,
        time: 1,
        data: {
          questionId,
          toProjectMember: 'account-peer',
          projectId,
          background: 'Need a rollback window.',
          questions: [{ id: 'q-1', question: 'Ship it?' }],
          originSessionId,
        },
      })
      ctx.emit('session/event', session, {
        type: 'member-question/outcome',
        seq: 2,
        time: 2,
        data: { questionId, outcome: 'declined' },
      })
    }).not.toThrow()
  })
})
