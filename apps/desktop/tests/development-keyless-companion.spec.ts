import { describe, expect, it } from 'vitest'
import {
  negotiateDevelopmentCompanionProtocol,
  openDevelopmentCompanionMessage,
  sealDevelopmentCompanionMessage,
} from '@deepseek-ai/dsh-remote-access-client'
import {
  parseAttachmentCapability,
  parseCompanionInteractionId,
  parseCompanionOperationId,
  parseCompanionSessionId,
} from '@deepseek-ai/dsh-remote-protocol'
import { DevelopmentKeylessCompanionAuthority } from '../src/development-keyless-companion.ts'

describe('Development keyless Companion authority', () => {
  it('echoes a one-byte sync frame and ignores undecryptable ciphertext', async () => {
    const authority = new DevelopmentKeylessCompanionAuthority()
    await expect(authority.reply(Uint8Array.of(7))).resolves.toEqual([Uint8Array.of(1)])
    await expect(authority.reply(Uint8Array.from({ length: 48 }, () => 3))).resolves.toEqual([])
  })

  it('confirms create, prompt, cancel, status, attachment, and interaction settlement', async () => {
    const authority = new DevelopmentKeylessCompanionAuthority()
    const protocol = negotiateDevelopmentCompanionProtocol()
    const sessionId = parseCompanionSessionId('session-authority')
    const createId = parseCompanionOperationId('operation-create')
    const workspaceCreate = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'create-session',
        operationId: parseCompanionOperationId('operation-workspace'),
        sessionId: parseCompanionSessionId('session-workspace'),
        title: 'Workspace Session',
        workspace: 'Work',
      },
    }))
    expect(workspaceCreate).toHaveLength(1)
    const createReplies = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'create-session', operationId: createId, sessionId, title: 'Ungrouped Session' },
    }))
    expect(createReplies).toHaveLength(1)
    await expect(openDevelopmentCompanionMessage(protocol, createReplies[0]!)).resolves.toMatchObject({
      type: 'result',
      result: { type: 'confirmed', operationId: createId, outcome: 'accepted' },
    })

    const promptId = parseCompanionOperationId('operation-prompt')
    const promptReplies = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'submit-prompt', operationId: promptId, sessionId, text: 'hello from Mobile' },
    }))
    expect(promptReplies).toHaveLength(2)
    const completed = await openDevelopmentCompanionMessage(protocol, promptReplies[1]!)
    expect(completed).toMatchObject({
      type: 'projection',
      projection: {
        type: 'transcript-page',
        sessionId,
        entries: [
          { type: 'text', role: 'user', text: 'hello from Mobile' },
          { type: 'text', role: 'assistant', text: 'Desktop accepted: hello from Mobile' },
          { type: 'approval', summary: 'Allow Desktop development action' },
          { type: 'ask-user', summary: 'Which Desktop path?' },
        ],
      },
    })
    expect(completed.type === 'projection' && completed.projection.streaming).toBeUndefined()
    const approvalId = completed.type === 'projection'
      ? completed.projection.entries.find(entry => entry.type === 'approval')?.interactionId
      : undefined
    const questionId = completed.type === 'projection'
      ? completed.projection.entries.find(entry => entry.type === 'ask-user')?.interactionId
      : undefined
    expect(approvalId).toBeDefined()
    expect(questionId).toBeDefined()

    const replay = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'create-session', operationId: createId, sessionId, title: 'Duplicate' },
    }))
    const replayed = await openDevelopmentCompanionMessage(protocol, replay[0]!)
    expect(replayed.type === 'result' && replayed.result.type === 'confirmed' && replayed.result.operationId).toBe(createId)

    const status = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'query-operation-status', operationId: promptId },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, status[0]!)).resolves.toMatchObject({
      type: 'result',
      result: { type: 'status', operationId: promptId, committed: { operationId: promptId } },
    })

    const absent = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'query-operation-status', operationId: parseCompanionOperationId('operation-missing') },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, absent[0]!)).resolves.toMatchObject({
      type: 'result',
      result: { type: 'status', absent: true },
    })

    const cancelId = parseCompanionOperationId('operation-cancel')
    const cancel = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'cancel-prompt', operationId: cancelId, sessionId },
    }))
    expect(cancel).toHaveLength(2)
    const cancelReplay = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: { type: 'cancel-prompt', operationId: cancelId, sessionId },
    }))
    expect(cancelReplay).toHaveLength(2)

    const implicit = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'submit-prompt',
        operationId: parseCompanionOperationId('operation-implicit'),
        sessionId: parseCompanionSessionId('session-implicit'),
        text: 'first prompt creates the Session',
      },
    }))
    expect(implicit).toHaveLength(2)
    await expect(authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'result',
      result: { type: 'confirmed', operationId: createId, committedAt: 1, outcome: 'accepted' },
    }))).resolves.toEqual([])

    const expired = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'offer-attachment',
        operationId: parseCompanionOperationId('operation-attach-expired'),
        sessionId,
        capability: parseAttachmentCapability('A'.repeat(43)),
        ciphertextSha256: 'a'.repeat(64),
        byteLength: 1,
        expiresAt: 1,
        fileName: 'note.txt',
      },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, expired[0]!)).resolves.toMatchObject({
      type: 'result',
      result: { type: 'attachment-rejected', reason: 'expired' },
    })

    const attach = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'offer-attachment',
        operationId: parseCompanionOperationId('operation-attach'),
        sessionId,
        capability: parseAttachmentCapability('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
        ciphertextSha256: 'b'.repeat(64),
        byteLength: 1,
        expiresAt: 3_000_000_000_000,
        fileName: 'shot.png',
      },
    }))
    expect(attach).toHaveLength(2)
    const attached = await openDevelopmentCompanionMessage(protocol, attach[1]!)
    expect(attached.type).toBe('projection')
    if (attached.type !== 'projection') throw new Error('expected transcript projection')
    expect(attached.projection.entries.some(entry => (
      entry.type === 'image' && entry.fileName === 'shot.png' && entry.alt === 'shot.png'
    ))).toBe(true)

    const settle = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'settle-approval',
        operationId: parseCompanionOperationId('operation-settle'),
        sessionId,
        interactionId: approvalId ?? parseCompanionInteractionId('approval-missing'),
        decision: 'once',
      },
    }))
    const settledPage = await openDevelopmentCompanionMessage(protocol, settle[1]!)
    expect(settledPage.type).toBe('projection')
    if (settledPage.type !== 'projection') throw new Error('expected transcript projection')
    expect(settledPage.projection.entries.some(entry => (
      entry.type === 'approval' && entry.settled?.decision === 'once'
    ))).toBe(true)

    const answer = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'answer-ask-user',
        operationId: parseCompanionOperationId('operation-answer'),
        sessionId,
        interactionId: questionId ?? parseCompanionInteractionId('question-missing'),
        decision: 'A',
      },
    }))
    const answered = await openDevelopmentCompanionMessage(protocol, answer[1]!)
    expect(answered.type).toBe('projection')
    if (answered.type !== 'projection') throw new Error('expected transcript projection')
    expect(answered.projection.entries.some(entry => (
      entry.type === 'ask-user' && entry.settled?.decision === 'A'
    ))).toBe(true)
  })

  it('keeps streaming true until cancel or the delayed assistant projection', async () => {
    let delayed: (() => Promise<void>) | undefined
    const emitted: Uint8Array[] = []
    const authority = new DevelopmentKeylessCompanionAuthority({
      streamDelayMs: 2_000,
      schedule: (task) => {
        delayed = task
        return () => { delayed = undefined }
      },
      emit: (frames) => { emitted.push(...frames) },
    })
    const protocol = negotiateDevelopmentCompanionProtocol()
    const sessionId = parseCompanionSessionId('session-stream')
    const promptReplies = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'submit-prompt',
        operationId: parseCompanionOperationId('operation-stream'),
        sessionId,
        text: 'hold for cancel',
      },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, promptReplies[1]!)).resolves.toMatchObject({
      type: 'projection',
      projection: {
        streaming: true,
        entries: [{ type: 'text', role: 'user', text: 'hold for cancel' }],
      },
    })

    const cancel = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'cancel-prompt',
        operationId: parseCompanionOperationId('operation-stream-cancel'),
        sessionId,
      },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, cancel[1]!)).resolves.toMatchObject({
      type: 'projection',
      projection: {
        entries: [
          { type: 'text', role: 'user', text: 'hold for cancel' },
          { type: 'text', role: 'assistant', text: 'cancelled' },
        ],
      },
    })
    expect(delayed).toBeUndefined()
    expect(emitted).toEqual([])

    const second = await authority.reply(await sealDevelopmentCompanionMessage(protocol, {
      type: 'operation',
      operation: {
        type: 'submit-prompt',
        operationId: parseCompanionOperationId('operation-stream-complete'),
        sessionId,
        text: 'let it finish',
      },
    }))
    await expect(openDevelopmentCompanionMessage(protocol, second[1]!)).resolves.toMatchObject({
      projection: { streaming: true },
    })
    expect(delayed).toBeDefined()
    await delayed?.()
    expect(emitted).toHaveLength(1)
    const finished = await openDevelopmentCompanionMessage(protocol, emitted[0]!)
    expect(finished.type).toBe('projection')
    if (finished.type !== 'projection') throw new Error('expected transcript projection')
    expect(finished.projection.entries.some(entry => (
      entry.type === 'text' && entry.role === 'assistant' && entry.text === 'Desktop accepted: let it finish'
    ))).toBe(true)
    expect(finished.projection.entries.some(entry => entry.type === 'approval')).toBe(true)
  })
})
