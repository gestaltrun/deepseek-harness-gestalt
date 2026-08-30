import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import FileMemberQuestionReceiver, {
  type MemberQuestionReceiverConfig,
  type MemberQuestionReceiverTimer,
  type MemberQuestionTerminalAuthority,
} from '../src/index.ts'
import * as ReceiverInvariant from '../src/invariant.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function operation(questionId: string, originSessionId = 'origin-edge', expiresAt = 5_000) {
  return {
    type: 'member-question' as const,
    operationId: parseCompanionOperationId(`operation-${questionId}`),
    questionId: parseMemberQuestionId(questionId),
    projectId: parseMemberQuestionProjectId('project-edge'),
    originSessionId: parseCompanionSessionId(originSessionId),
    expiresAt,
    origin: {
      projectName: 'Edge',
      originSessionTitle: originSessionId,
      askerAccountId: 'asker',
      askerRole: 'member' as const,
      askerDisplayName: 'Ask',
      askerAvatarUrl: 'https://example.test/ask.png',
    },
    background: 'Exercise receiver failures.',
    questions: [{ id: 'q', question: 'Continue?' }],
    references: [],
  }
}

async function setup(overrides: Partial<MemberQuestionReceiverConfig> = {}) {
  const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-edge-'))
  roots.push(storagePath)
  const context = new Context()
  contexts.push(context)
  await context.plugin(FileMemberQuestionReceiver, {
    storagePath,
    environment: 'development',
    maxRecords: 8,
    terminalRetryMs: 5,
    clock: () => 1_000,
    ...overrides,
  })
  return context.memberQuestionReceiver as FileMemberQuestionReceiver
}

const account = 'receiver-edge' as PlatformAccountId

class Authority implements MemberQuestionTerminalAuthority {
  readonly values = new Map<string, Parameters<MemberQuestionTerminalAuthority['claim']>[0]>()

  async claim(candidate: Parameters<MemberQuestionTerminalAuthority['claim']>[0]) {
    const prior = this.values.get(candidate.questionId)
    if (prior !== undefined) return { claimed: false, terminal: prior }
    this.values.set(candidate.questionId, candidate)
    return { claimed: true, terminal: candidate }
  }
}

class Timer implements MemberQuestionReceiverTimer {
  callback: (() => void) | undefined
  delay: number | undefined

  set(callback: () => void, delay: number): unknown {
    this.callback = callback
    this.delay = delay
    return callback
  }

  clear(): void {
    this.callback = undefined
  }

  fire(): void {
    const callback = this.callback
    if (callback === undefined) throw new Error('missing timer')
    this.callback = undefined
    callback()
  }
}

describe('member-question receiver edge contracts', () => {
  it('rejects conflicting replay, capacity exhaustion, and an expired arrival without terminal authority', async () => {
    const receiver = await setup({ maxRecords: 1 })
    const first = operation('question-one')
    await receiver.ingest({ authority: { accountId: account }, operation: first })
    await expect(receiver.ingest({
      authority: { accountId: 'different' as PlatformAccountId },
      operation: first,
    })).rejects.toThrow('different authority or content')
    await expect(receiver.ingest({ authority: { accountId: account }, operation: operation('question-two', 'other') }))
      .rejects.toThrow('maxRecords 1 is exhausted')

    const expired = await setup({ clock: () => 6_000 })
    await expect(expired.ingest({ authority: { accountId: account }, operation: operation('expired-arrival') }))
      .rejects.toThrow('terminalAuthority is required to persist an expired arrival')
    const authority = new Authority()
    const accepted = await setup({ clock: () => 6_000, terminalAuthority: authority })
    await accepted.ingest({ authority: { accountId: account }, operation: operation('expired-authoritative') })
    expect((await accepted.snapshot()).terminal[0]?.terminal.outcome).toBe('expired')
  })

  it('fails loud for unknown or mismatched settlement and replays an authoritative terminal idempotently', async () => {
    const receiver = await setup()
    await expect(receiver.settle(parseMemberQuestionId('unknown'), {
      kind: 'authoritative',
      claim: {
        claimed: true,
        terminal: {
          type: 'member-question-settled',
          operationId: parseCompanionOperationId('unknown-operation'),
          questionId: parseMemberQuestionId('unknown'),
          outcome: 'withdrawn',
          settledAt: 1,
        },
      },
    })).rejects.toThrow('unknown question')
    const question = operation('settle-edge')
    await receiver.ingest({ authority: { accountId: account }, operation: question })
    await expect(receiver.settle(question.questionId, {
      kind: 'authoritative',
      claim: {
        claimed: false,
        terminal: {
          type: 'member-question-settled',
          operationId: question.operationId,
          questionId: parseMemberQuestionId('different-question'),
          outcome: 'withdrawn',
          settledAt: 2,
        },
      },
    })).rejects.toThrow('different question or operation')
    await expect(receiver.settle(question.questionId, {
      kind: 'authoritative',
      claim: {
        claimed: false,
        terminal: {
          type: 'member-question-settled',
          operationId: parseCompanionOperationId('different-operation'),
          questionId: question.questionId,
          outcome: 'withdrawn',
          settledAt: 2,
        },
      },
    })).rejects.toThrow('different question or operation')
    const terminal = {
      type: 'member-question-settled' as const,
      operationId: question.operationId,
      questionId: question.questionId,
      outcome: 'withdrawn' as const,
      settledAt: 3,
    }
    await expect(receiver.settle(question.questionId, {
      kind: 'authoritative',
      claim: { claimed: false, terminal },
    })).resolves.toEqual(terminal)
    await expect(receiver.settle(question.questionId, {
      kind: 'authoritative',
      claim: { claimed: true, terminal: { ...terminal, outcome: 'superseded' } },
    })).resolves.toEqual(terminal)
  })

  it('rejects decline without authority and converts a late decline to authoritative expiry', async () => {
    const noAuthority = await setup()
    const question = operation('decline-no-authority')
    await noAuthority.ingest({ authority: { accountId: account }, operation: question })
    await expect(noAuthority.settle(question.questionId, {
      kind: 'declined',
      settledByInstallationId: 'installation' as never,
      settledByDeviceName: 'Mac',
      settledAt: 1_100,
    })).rejects.toThrow('terminalAuthority is required to decline')

    let now = 1_000
    const authority = new Authority()
    const late = await setup({ clock: () => now, terminalAuthority: authority })
    const futureAtArrival = operation('late-decline', 'origin-late', 7_000)
    await late.ingest({ authority: { accountId: account }, operation: futureAtArrival })
    now = 8_000
    await expect(late.settle(futureAtArrival.questionId, {
      kind: 'declined',
      settledByInstallationId: 'installation' as never,
      settledByDeviceName: 'Mac',
      settledAt: now,
    })).resolves.toMatchObject({ outcome: 'expired' })
  })

  it('rejects unknown, stale, unconfigured, and conflicting human-turn admission', async () => {
    const receiver = await setup()
    await expect(receiver.admitHumanTurn({
      receivingSessionId: 'receiving-missing' as never,
      revision: 0,
      rpcId: 'rpc-missing' as never,
      content: [{ type: 'text', text: 'x' }],
      mode: 'queue',
    })).rejects.toThrow('unknown receiving Session')
    const arrived = await receiver.ingest({ authority: { accountId: account }, operation: operation('admission-edge') })
    await expect(receiver.admitHumanTurn({
      receivingSessionId: arrived.receivingSessionId,
      revision: 0,
      rpcId: 'rpc-stale' as never,
      content: [{ type: 'text', text: 'x' }],
      mode: 'queue',
    })).rejects.toThrow('stale receiving Session revision')
    const reserved = {
      receivingSessionId: arrived.receivingSessionId,
      revision: arrived.revision,
      rpcId: 'rpc-no-admitter' as never,
      content: [{ type: 'text' as const, text: 'x' }],
      mode: 'queue' as const,
    }
    await expect(receiver.admitHumanTurn(reserved)).rejects.toThrow('admitter is required')
    await expect(receiver.admitHumanTurn({ ...reserved, mode: 'steer' }))
      .rejects.toThrow('different content or mode')
  })

  it('retries authoritative timer expiry after publication failure and selects the earliest of two routes', async () => {
    let now = 1_000
    let failures = 1
    const timer = new Timer()
    const delegate = new Authority()
    const authority: MemberQuestionTerminalAuthority = {
      async claim(candidate) {
        if (failures > 0) {
          failures -= 1
          throw new Error('offline')
        }
        return delegate.claim(candidate)
      },
    }
    const receiver = await setup({ clock: () => now, timer, terminalAuthority: authority })
    await receiver.ingest({ authority: { accountId: account }, operation: operation('later', 'origin-later', 3_000) })
    await receiver.ingest({ authority: { accountId: account }, operation: operation('earlier', 'origin-earlier', 2_000) })
    expect(timer.delay).toBe(1_000)
    now = 2_000
    timer.fire()
    await vi.waitFor(() => { expect(timer.delay).toBe(5) })
    timer.fire()
    await vi.waitFor(async () => {
      expect((await receiver.snapshot()).terminal.map(row => row.questionId)).toContain('earlier')
    })
  })

  it('fails same-route replacement without terminal authority and commits admissions while unrelated rows exist', async () => {
    const noAuthority = await setup()
    await noAuthority.ingest({ authority: { accountId: account }, operation: operation('no-authority-first') })
    await expect(noAuthority.ingest({ authority: { accountId: account }, operation: operation('no-authority-second') }))
      .rejects.toThrow('terminalAuthority is required to settle a pending question')

    const admitter = vi.fn(async () => ({ accepted: true as const }))
    const receiver = await setup({ admitter })
    const first = await receiver.ingest({ authority: { accountId: account }, operation: operation('admit-first', 'origin-first') })
    const second = await receiver.ingest({ authority: { accountId: account }, operation: operation('admit-second', 'origin-second') })
    await receiver.admitHumanTurn({
      receivingSessionId: first.receivingSessionId,
      revision: first.revision,
      rpcId: 'rpc-first' as never,
      content: [{ type: 'text', text: 'first' }],
      mode: 'queue',
    })
    await receiver.admitHumanTurn({
      receivingSessionId: second.receivingSessionId,
      revision: second.revision,
      rpcId: 'rpc-second' as never,
      content: [{ type: 'text', text: 'second' }],
      mode: 'steer',
    })
    expect(admitter).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale timer callback after disposal', async () => {
    const timer = new Timer()
    const receiver = await setup({ timer, terminalAuthority: new Authority() })
    await receiver.ingest({ authority: { accountId: account }, operation: operation('dispose-timer') })
    const stale = timer.callback!
    await contexts.pop()!.fiber.dispose()
    stale()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(timer.callback).toBeUndefined()
  })

  it('validates every programmatic config face loudly', () => {
    const base = {
      storagePath: '/tmp/member-question-receiver-config-test',
      environment: 'development' as const,
      maxRecords: 1,
      terminalRetryMs: 1,
    }
    const cases: unknown[] = [
      { ...base, storagePath: '' },
      { ...base, environment: 'staging' },
      { ...base, maxRecords: 0 },
      { ...base, terminalRetryMs: 0 },
      { ...base, terminalAuthority: {} },
      { ...base, clock: true },
      { ...base, admitter: true },
      { ...base, timer: {} },
      { ...base, timer: { set() {} } },
      { ...base, stateWriter: true },
    ]
    for (const config of cases) {
      const context = new Context()
      expect(() => new FileMemberQuestionReceiver(context, config as never)).toThrow('config.')
      void context.fiber.dispose()
    }
  })

  it('reports a non-monotonic committed revision through its invariant companion', async () => {
    const context = new Context()
    await context.plugin(InvariantRegistry)
    await context.plugin(ReceiverInvariant)
    const questionId = parseMemberQuestionId('invariant-question')
    context.emit('member-question-receiver/changed', { revision: 2, questionId, state: 'pending' })
    expect(() => {
      context.emit('member-question-receiver/changed', { revision: 2, questionId, state: 'withdrawn' })
    }).toThrow('receiver ledger revision moved from 2 to 2')
    await context.fiber.dispose()
  })
})
