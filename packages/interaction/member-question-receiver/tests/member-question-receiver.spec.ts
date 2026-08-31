import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import FileMemberQuestionReceiver from '../src/index.ts'
import type {
  MemberQuestionHumanTurnAdmitter,
  MemberQuestionReceiverConfig,
  MemberQuestionTerminalAuthority,
  MemberQuestionTerminalClaim,
  MemberQuestionReceiverTimer,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createReceiver(
  storagePath: string,
  overrides: Partial<MemberQuestionReceiverConfig> = {},
): Promise<FileMemberQuestionReceiver> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(FileMemberQuestionReceiver, {
    storagePath,
    environment: 'development',
    maxRecords: 16,
    terminalRetryMs: 10,
    ...overrides,
  })
  return context.memberQuestionReceiver as FileMemberQuestionReceiver
}

function bindReceiverWorkspace(receiver: FileMemberQuestionReceiver): Promise<void> {
  return receiver.bind(
    envelope.authority.accountId,
    envelope.operation.projectId,
    'workspace-receiver' as never,
  )
}

const envelope = {
  authority: { accountId: 'account-receiver' as PlatformAccountId },
  operation: {
    type: 'member-question' as const,
    operationId: parseCompanionOperationId('operation-1'),
    questionId: parseMemberQuestionId('question-1'),
    projectId: parseMemberQuestionProjectId('project-1'),
    originSessionId: parseCompanionSessionId('origin-session-1'),
    expiresAt: 2_000,
    origin: {
      projectName: 'Atlas',
      originSessionTitle: 'Choose storage',
      askerAccountId: 'account-asker',
      askerRole: 'owner' as const,
      askerDisplayName: 'Ada',
      askerAvatarUrl: 'https://example.test/ada.png',
    },
    background: 'Choose the durable owner.',
    questions: [{ id: 'choice', question: 'Which owner?' }],
    references: [{ path: 'docs/architecture.md', reason: 'Current ownership map' }],
  },
}

function envelopeWith(questionId: string, expiresAt: number = 2_000) {
  return {
    ...envelope,
    operation: {
      ...envelope.operation,
      operationId: parseCompanionOperationId(`operation-${questionId}`),
      questionId: parseMemberQuestionId(questionId),
      expiresAt,
    },
  }
}

class MemoryTerminalAuthority implements MemberQuestionTerminalAuthority {
  readonly terminals = new Map<string, MemberQuestionTerminalClaim['terminal']>()

  async claim(candidate: MemberQuestionTerminalClaim['terminal']): Promise<MemberQuestionTerminalClaim> {
    const prior = this.terminals.get(candidate.questionId)
    if (prior !== undefined) return { claimed: false, terminal: prior }
    this.terminals.set(candidate.questionId, candidate)
    return { claimed: true, terminal: candidate }
  }
}

class ManualTimer implements MemberQuestionReceiverTimer {
  readonly callbacks = new Map<object, () => void>()

  set(callback: () => void): unknown {
    const handle = {}
    this.callbacks.set(handle, callback)
    return handle
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as object)
  }

  fire(): void {
    const callback = this.callbacks.values().next().value
    if (callback === undefined) throw new Error('no timer scheduled')
    this.callbacks.clear()
    callback()
  }
}

describe('FileMemberQuestionReceiver', () => {
  it('persists one idempotent authenticated arrival and recovers its opaque receiving Session id', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)

    const first = await createReceiver(storagePath, { clock: () => 1_000 })
    const arrived = await first.ingest(envelope)
    const replayed = await first.ingest(envelope)

    expect(replayed).toEqual(arrived)
    expect(arrived.receivingSessionId).not.toContain('mq-recv')
    expect(await first.snapshot()).toMatchObject({
      revision: 1,
      pending: [{
        questionId: envelope.operation.questionId,
        receivingSessionId: arrived.receivingSessionId,
        receivingAccountId: envelope.authority.accountId,
      }],
      terminal: [],
    })

    await contexts.pop()!.fiber.dispose()
    const reopened = await createReceiver(storagePath, { clock: () => 1_000 })
    expect(await reopened.snapshot()).toMatchObject({
      revision: 1,
      pending: [{
        questionId: envelope.operation.questionId,
        receivingSessionId: arrived.receivingSessionId,
      }],
      terminal: [],
    })
  })

  it('persists and replaces exact Account/Project Workspace bindings across restart', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-binding-'))
    roots.push(storagePath)
    const first = await createReceiver(storagePath, { clock: () => 1_000 })
    await first.bind('account-receiver' as never, 'project-1' as never, 'workspace-old' as never)
    await first.bind('account-receiver' as never, 'project-1' as never, 'workspace-new' as never)
    await expect(first.lookup('account-receiver' as never, 'project-1' as never))
      .resolves.toBe('workspace-new')
    await expect(first.lookup('account-receiver' as never, 'project-missing' as never))
      .resolves.toBeUndefined()
    await expect(first.resolve('account-receiver' as never, 'project-1' as never))
      .resolves.toBe('workspace-new')
    await expect(first.resolve('account-receiver' as never, 'project-missing' as never))
      .rejects.toThrow('no local Workspace binding')

    await contexts.pop()!.fiber.dispose()
    const reopened = await createReceiver(storagePath, { clock: () => 1_000 })
    await expect(reopened.lookup('account-receiver' as never, 'project-1' as never))
      .resolves.toBe('workspace-new')
    await expect(reopened.resolve('account-receiver' as never, 'project-1' as never))
      .resolves.toBe('workspace-new')
  })

  it('admits only one compare-and-bind winner for concurrent recovery', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-binding-cas-'))
    roots.push(storagePath)
    const receiver = await createReceiver(storagePath, { clock: () => 1_000 })
    const results = await Promise.all([
      receiver.bindIfCurrent(
        'account-receiver' as never, 'project-1' as never, undefined, 'workspace-first' as never,
      ),
      receiver.bindIfCurrent(
        'account-receiver' as never, 'project-1' as never, undefined, 'workspace-second' as never,
      ),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = await receiver.lookup('account-receiver' as never, 'project-1' as never)
    expect(['workspace-first', 'workspace-second']).toContain(winner)
    await expect(receiver.bindIfCurrent(
      'account-receiver' as never, 'project-1' as never, 'workspace-stale' as never, 'workspace-third' as never,
    )).resolves.toBe(false)
    const revisionBeforeReplay = (await receiver.snapshot()).revision
    await expect(receiver.bindIfCurrent(
      'account-receiver' as never, 'project-1' as never, winner as never, winner as never,
    )).resolves.toBe(true)
    expect((await receiver.snapshot()).revision).toBe(revisionBeforeReplay)
    await receiver.bind('other-account' as never, 'other-project' as never, 'other-workspace' as never)
    await receiver.bind('account-receiver' as never, 'other-project' as never, 'same-account-workspace' as never)
    await expect(receiver.bindIfCurrent(
      'account-receiver' as never, 'project-1' as never, winner as never, 'workspace-third' as never,
    )).resolves.toBe(true)
    await expect(receiver.lookup('account-receiver' as never, 'project-1' as never)).resolves.toBe('workspace-third')
    await expect(receiver.lookup('other-account' as never, 'other-project' as never)).resolves.toBe('other-workspace')
    await expect(receiver.lookup('account-receiver' as never, 'other-project' as never)).resolves.toBe('same-account-workspace')
  })

  it('expires an overdue predecessor before admitting a newer same-route question, then supersedes a live predecessor', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    let now = 1_000
    const terminalAuthority = new MemoryTerminalAuthority()
    const receiver = await createReceiver(storagePath, {
      clock: () => now,
      terminalAuthority,
    })

    await receiver.ingest(envelopeWith('question-old', 1_500))
    now = 1_600
    await receiver.ingest(envelopeWith('question-current', 2_500))
    expect(await receiver.snapshot()).toMatchObject({
      pending: [{ questionId: 'question-current' }],
      terminal: [{ questionId: 'question-old', terminal: { outcome: 'expired', settledAt: 1_600 } }],
    })

    now = 1_700
    await receiver.ingest(envelopeWith('question-newest', 3_000))
    expect(await receiver.snapshot()).toMatchObject({
      pending: [{ questionId: 'question-newest' }],
      terminal: [
        { questionId: 'question-old', terminal: { outcome: 'expired' } },
        { questionId: 'question-current', terminal: { outcome: 'superseded', settledAt: 1_700 } },
      ],
    })
  })

  it('advances only the reused route Session while preserving unrelated routes', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const receiver = await createReceiver(storagePath, {
      clock: () => 1_000,
      terminalAuthority: new MemoryTerminalAuthority(),
    })
    await receiver.ingest(envelopeWith('route-a', 3_000))
    await receiver.ingest({
      ...envelopeWith('route-b', 3_000),
      authority: { accountId: 'account:other' as PlatformAccountId },
    })
    await receiver.ingest(envelopeWith('route-a-next', 3_000))
    const snapshot = await receiver.snapshot()
    expect(snapshot.pending.map(row => row.questionId).sort()).toEqual(['route-a-next', 'route-b'])
  })

  it('keeps decline distinct from withdrawal and applies a losing claim from the authoritative Installation', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const terminalAuthority = new MemoryTerminalAuthority()
    const receiver = await createReceiver(storagePath, {
      clock: () => 1_000,
      terminalAuthority,
    })

    const declined = envelopeWith('question-declined', 3_000)
    await receiver.ingest(declined)
    await receiver.settle(declined.operation.questionId, {
      kind: 'declined',
      settledByInstallationId: 'installation-local' as never,
      settledByDeviceName: 'Local Mac',
      settledAt: 1_100,
    })
    expect((await receiver.snapshot()).terminal[0]?.terminal).toMatchObject({
      outcome: 'declined',
      settledByDeviceName: 'Local Mac',
    })

    const elsewhere = envelopeWith('question-elsewhere', 3_000)
    await receiver.ingest(elsewhere)
    terminalAuthority.terminals.set(elsewhere.operation.questionId, {
      type: 'member-question-settled',
      operationId: elsewhere.operation.operationId,
      questionId: elsewhere.operation.questionId,
      outcome: 'answered',
      answers: [{ id: 'choice', selected: ['Host'] }],
      settledByInstallationId: 'installation-remote' as never,
      settledByDeviceName: 'Remote Mac',
      settledAt: 1_150,
    })
    const canonical = await receiver.settle(elsewhere.operation.questionId, {
      kind: 'declined',
      settledByInstallationId: 'installation-local' as never,
      settledByDeviceName: 'Local Mac',
      settledAt: 1_200,
    })
    expect(canonical).toMatchObject({ outcome: 'answered', settledByDeviceName: 'Remote Mac' })

    await contexts.pop()!.fiber.dispose()
    const reopened = await createReceiver(storagePath, {
      clock: () => 1_300,
      terminalAuthority,
    })
    expect((await reopened.snapshot()).terminal.map(row => row.terminal.outcome)).toEqual([
      'declined',
      'answered',
    ])
  })

  it('reserves one human turn durably, retries the high-level admission, and commits it exactly once by rpcId', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const effects = new Set<string>()
    const attemptedContent: unknown[] = []
    let attempts = 0
    const admitter: MemberQuestionHumanTurnAdmitter = async (request) => {
      attempts += 1
      attemptedContent.push(request.content)
      if (attempts === 1) throw new Error('materialization interrupted')
      effects.add(request.rpcId)
      return { accepted: true }
    }
    const receiver = await createReceiver(storagePath, {
      clock: () => 1_000,
      admitter,
    })
    const arrived = await receiver.ingest(envelopeWith('question-admit', 3_000))
    await bindReceiverWorkspace(receiver)
    expect(attempts).toBe(0)
    const request = {
      receivingSessionId: arrived.receivingSessionId,
      revision: arrived.revision,
      rpcId: 'rpc-human-1' as never,
      content: [{ type: 'text' as const, text: 'Help me evaluate this choice.' }],
      mode: 'queue' as const,
    }

    await expect(receiver.admitHumanTurn(request)).rejects.toThrow('materialization interrupted')
    await expect(receiver.admitHumanTurn({
      ...request,
      content: [{ type: 'text', text: 'Edited after failure' }],
    })).rejects.toThrow('different content')
    const admitted = await receiver.admitHumanTurn(request)
    expect(admitted).toMatchObject({ accepted: true, receivingSessionId: arrived.receivingSessionId })
    expect(attempts).toBe(2)
    expect(effects).toEqual(new Set(['rpc-human-1']))
    expect(attemptedContent).toEqual([request.content, request.content])

    await expect(receiver.admitHumanTurn(request)).resolves.toEqual(admitted)
    expect(attempts).toBe(2)
    await expect(receiver.admitHumanTurn({
      ...request,
      content: [{ type: 'text', text: 'Conflicting replay' }],
    })).rejects.toThrow('different content')
  })

  it('replays the original durable image reference after a Host restart', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const content = [{
      type: 'image' as const,
      attachment: {
        attachmentId: 'attachment-human-restart' as never,
        mediaType: 'image/png' as const,
        bytes: 68,
        width: 1,
        height: 1,
        name: 'decision.png',
      },
    }]
    const first = await createReceiver(storagePath, {
      clock: () => 1_000,
      admitter: () => Promise.reject(new Error('Host stopped after reservation')),
    })
    const arrived = await first.ingest(envelopeWith('question-image-restart', 3_000))
    await bindReceiverWorkspace(first)
    await expect(first.admitHumanTurn({
      receivingSessionId: arrived.receivingSessionId,
      revision: arrived.revision,
      rpcId: 'rpc-image-restart' as never,
      content,
      mode: 'queue',
    })).rejects.toThrow('Host stopped after reservation')
    await contexts.pop()!.fiber.dispose()

    const admittedContent: unknown[] = []
    const reopened = await createReceiver(storagePath, {
      clock: () => 1_100,
      admitter: (request) => {
        admittedContent.push(request.content)
        return Promise.resolve({ accepted: true })
      },
    })
    await reopened.resumeReservedHumanTurns()
    expect(admittedContent).toEqual([content])
    expect((await reopened.snapshot()).pending[0]?.reservedAdmission).toBeUndefined()
  })

  it('registers one Host admitter and projects its materialized terminal Session identity', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const receiver = await createReceiver(storagePath, {
      clock: () => 1_000,
      terminalAuthority: new MemoryTerminalAuthority(),
    })
    const contextsSeen: Parameters<MemberQuestionHumanTurnAdmitter>[1][] = []
    const admitter: MemberQuestionHumanTurnAdmitter = (_request, context) => {
      contextsSeen.push(context)
      return Promise.resolve({ accepted: true })
    }
    const unregister = receiver.registerHumanTurnAdmitter(admitter)
    expect(() => receiver.registerHumanTurnAdmitter(admitter)).toThrow('already registered')
    const arrived = await receiver.ingest(envelopeWith('question-registered', 3_000))
    await bindReceiverWorkspace(receiver)
    await receiver.admitHumanTurn({
      receivingSessionId: arrived.receivingSessionId,
      revision: arrived.revision,
      rpcId: 'rpc-registered-1' as never,
      content: [{ type: 'text', text: 'First prompt.' }],
      mode: 'queue',
    })
    await receiver.settle('question-registered' as never, {
      kind: 'declined',
      settledByInstallationId: 'installation-local' as never,
      settledByDeviceName: 'Local Mac',
      settledAt: 1_100,
    })
    const terminal = (await receiver.snapshot()).terminal[0]
    expect(terminal?.hostSessionId).toBe(arrived.receivingSessionId)
    await receiver.admitHumanTurn({
      receivingSessionId: arrived.receivingSessionId,
      revision: terminal!.revision,
      rpcId: 'rpc-registered-2' as never,
      content: [{ type: 'text', text: 'Second prompt.' }],
      mode: 'queue',
    })
    expect(contextsSeen.at(-1)?.questions[0]).toMatchObject({
      questionId: 'question-registered',
      terminal: { outcome: 'declined' },
    })
    expect(contextsSeen.at(-1)?.workspaceId).toBe('workspace-receiver')
    unregister()
    unregister()
    expect(() => receiver.registerHumanTurnAdmitter(admitter)).not.toThrow()
  })

  it('keeps the predecessor pending when terminal publication fails, then retries without admitting the newer question early', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const delegate = new MemoryTerminalAuthority()
    let fail = true
    const terminalAuthority: MemberQuestionTerminalAuthority = {
      async claim(candidate) {
        if (fail) {
          fail = false
          throw new Error('terminal publication unavailable')
        }
        return delegate.claim(candidate)
      },
    }
    const receiver = await createReceiver(storagePath, { clock: () => 1_000, terminalAuthority })
    await receiver.ingest(envelopeWith('question-first', 3_000))
    await expect(receiver.ingest(envelopeWith('question-second', 4_000)))
      .rejects.toThrow('terminal publication unavailable')
    expect((await receiver.snapshot()).pending.map(row => row.questionId)).toEqual(['question-first'])

    await receiver.ingest(envelopeWith('question-second', 4_000))
    expect((await receiver.snapshot()).pending.map(row => row.questionId)).toEqual(['question-second'])
  })

  it('retains a human-turn reservation when the post-admission durable commit fails', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    let failCommit = false
    const effects = new Set<string>()
    let attempts = 0
    const receiver = await createReceiver(storagePath, {
      clock: () => 1_000,
      admitter: async (request) => {
        attempts += 1
        effects.add(request.rpcId)
        failCommit = attempts === 1
        return { accepted: true }
      },
      stateWriter: async (path, content) => {
        if (failCommit) {
          failCommit = false
          throw new Error('durable commit failed')
        }
        await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
      },
    })
    const arrived = await receiver.ingest(envelopeWith('question-write-failure', 3_000))
    await bindReceiverWorkspace(receiver)
    const request = {
      receivingSessionId: arrived.receivingSessionId,
      revision: arrived.revision,
      rpcId: 'rpc-write-failure' as never,
      content: [{ type: 'text' as const, text: 'Commit this once.' }],
      mode: 'queue' as const,
    }
    await expect(receiver.admitHumanTurn(request)).rejects.toThrow('durable commit failed')
    await expect(receiver.admitHumanTurn(request)).resolves.toMatchObject({ accepted: true })
    expect(attempts).toBe(2)
    expect(effects).toEqual(new Set(['rpc-write-failure']))
  })

  it('persists authoritative timer expiry, contains subscriber failures, and reaches quiescence on dispose', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    let now = 1_000
    const timer = new ManualTimer()
    const terminalAuthority = new MemoryTerminalAuthority()
    const receiver = await createReceiver(storagePath, { clock: () => now, timer, terminalAuthority })
    const revisions: number[] = []
    receiver.changes(() => { throw new Error('observer failure') })
    const unsubscribe = receiver.changes((snapshot) => { revisions.push(snapshot.revision) })
    await receiver.ingest(envelopeWith('question-timer', 1_500))
    expect(timer.callbacks.size).toBe(1)

    now = 1_500
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    timer.fire()
    await vi.waitFor(async () => {
      expect((await receiver.snapshot()).terminal[0]?.terminal.outcome).toBe('expired')
    })
    expect(revisions).toEqual([1, 2])
    expect(consoleError).toHaveBeenCalledWith('member-question receiver subscriber failed:', expect.any(Error))
    unsubscribe()
    consoleError.mockRestore()

    await contexts.pop()!.fiber.dispose()
    expect(timer.callbacks.size).toBe(0)
    const reopened = await createReceiver(storagePath, { clock: () => 2_000, terminalAuthority })
    expect((await reopened.snapshot()).terminal[0]?.terminal.outcome).toBe('expired')
  })

  it('fails loud when the persisted ledger carries an unsupported format', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-'))
    roots.push(storagePath)
    const directory = join(storagePath, 'development')
    await mkdir(directory)
    await writeFile(join(directory, 'member-question-receiver.json'), '{"formatVersion":99}\n')
    let failure: unknown
    try {
      const receiver = await createReceiver(storagePath, { clock: () => 1_000 })
      await receiver.snapshot()
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain('formatVersion 99 is unsupported')
  })
})
