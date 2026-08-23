import { describe, expect, it } from 'vitest'
import {
  negotiateDevelopmentCompanionProtocol,
  openDevelopmentCompanionMessage,
  sealDevelopmentCompanionMessage,
} from '@deepseek-ai/dsh-remote-access-client'
import { parseCompanionTranscriptEntryId, parseRelayAttachmentId } from '@deepseek-ai/dsh-remote-protocol'
import {
  DevelopmentCompanionClient,
  DevelopmentCompanionSessionStore,
  installDevelopmentCompanionClient,
} from '../src/development-keyless-companion.ts'

describe('Development keyless Companion client', () => {
  it('adds a Session and transcript only after Desktop confirmation', async () => {
    const desktop = negotiateDevelopmentCompanionProtocol()
    const store = new DevelopmentCompanionSessionStore()
    const client = new DevelopmentCompanionClient(
      store,
      async (_target, ciphertext) => {
        const inbound = await openDevelopmentCompanionMessage(desktop, ciphertext)
        if (inbound.type !== 'operation') return
        const operationId = inbound.operation.operationId
        await client.receive(await sealDevelopmentCompanionMessage(desktop, {
          type: 'result',
          result: { type: 'confirmed', operationId, committedAt: 1, outcome: 'accepted' },
        }))
        if (inbound.operation.type === 'submit-prompt') {
          await client.receive(await sealDevelopmentCompanionMessage(desktop, {
            type: 'projection',
            projection: {
              type: 'transcript-page',
              sessionId: inbound.operation.sessionId,
              entries: [
                { type: 'text', entryId: parseCompanionTranscriptEntryId('entry-1'), role: 'user', text: inbound.operation.text },
                { type: 'text', entryId: parseCompanionTranscriptEntryId('entry-2'), role: 'assistant', text: `Desktop accepted: ${inbound.operation.text}` },
                {
                  type: 'approval',
                  entryId: parseCompanionTranscriptEntryId('entry-3'),
                  interactionId: 'approval-1' as never,
                  summary: 'Allow Desktop development action',
                  authorized: ['once'],
                },
              ],
            },
          }))
        }
      },
      parseRelayAttachmentId('desktop-development-keyless'),
    )
    const dispose = installDevelopmentCompanionClient(client)
    try {
      await client.createSession({
        operationId: 'operation-create',
        sessionId: 'session-create',
        title: 'Ungrouped Session',
      })
      await client.createSession({
        operationId: 'operation-workspace',
        sessionId: 'session-workspace',
        title: 'Workspace Session',
        workspace: 'Work',
      })
      expect(store.getSnapshot()).toEqual([
        expect.objectContaining({
          id: 'session-create',
          title: 'Ungrouped Session',
          summary: 'New Session',
          blocks: [],
        }),
        expect.objectContaining({ id: 'session-workspace', workspace: 'Work' }),
      ])
      await client.createSession({
        operationId: 'operation-create',
        sessionId: 'session-create',
        title: 'Duplicate',
      })
      expect(store.getSnapshot()).toHaveLength(2)
      await client.submitPrompt({
        operationId: 'operation-prompt',
        sessionId: 'session-create',
        text: 'hello from Mobile',
      })
      expect(store.getSnapshot()[0]).toMatchObject({
        transcript: ['hello from Mobile', 'Desktop accepted: hello from Mobile', 'Allow Desktop development action'],
        blocks: [
          { kind: 'markdown', text: 'hello from Mobile' },
          { kind: 'markdown', text: 'Desktop accepted: hello from Mobile' },
          {
            kind: 'approval',
            summary: 'Allow Desktop development action',
            interactionId: 'approval-1',
            authorized: ['once'],
          },
        ],
      })
      await client.cancelPrompt({ operationId: 'operation-cancel', sessionId: 'session-create' })
      await client.receive()
      await client.receive(Uint8Array.of(1))
    } finally {
      dispose()
    }
  })

  it('rejects a send failure without inventing a Session row', async () => {
    const store = new DevelopmentCompanionSessionStore()
    const client = new DevelopmentCompanionClient(
      store,
      async () => { throw new Error('REMOTE_OFFLINE') },
      parseRelayAttachmentId('desktop-development-keyless'),
    )
    await expect(client.createSession({
      operationId: 'operation-offline',
      sessionId: 'session-offline',
      title: 'Ungrouped Session',
    })).rejects.toThrow('REMOTE_OFFLINE')
    expect(store.getSnapshot()).toEqual([])
    store.applyTranscript('session-projected', [{
      type: 'text',
      entryId: parseCompanionTranscriptEntryId('entry-cached'),
      role: 'assistant',
      text: 'already confirmed',
    }])
    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({ id: 'session-projected', summary: 'already confirmed' }),
    ])
    const thrown = new DevelopmentCompanionClient(
      store,
      async () => { throw 'offline' },
      parseRelayAttachmentId('desktop-development-keyless'),
    )
    await expect(thrown.createSession({
      operationId: 'operation-thrown',
      sessionId: 'session-thrown',
      title: 'Ungrouped Session',
    })).rejects.toThrow('Companion send failed')
  })

  it('restores cached Session metadata into an empty store and keeps later confirmations', async () => {
    const {
      bindDevelopmentCompanionCache,
      createMemoryDevelopmentCompanionCache,
    } = await import('../src/development-keyless-companion.ts')
    const cache = createMemoryDevelopmentCompanionCache('development', 'account-cache' as never)
    const first = new DevelopmentCompanionSessionStore()
    first.applyTranscript('session-cached', [{
      type: 'text',
      entryId: parseCompanionTranscriptEntryId('entry-restore'),
      role: 'assistant',
      text: 'cached line',
    }])
    const stop = await bindDevelopmentCompanionCache(first, cache)
    stop()
    const restored = new DevelopmentCompanionSessionStore()
    await bindDevelopmentCompanionCache(restored, cache)
    expect(restored.getSnapshot()).toEqual([
      expect.objectContaining({ id: 'session-cached', summary: 'cached line' }),
    ])
  })
})
