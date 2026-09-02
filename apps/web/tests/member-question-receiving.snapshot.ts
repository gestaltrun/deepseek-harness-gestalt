/** Keyless assembled snapshot for lazy receiver materialization and its first model transcript. */

import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  createAuthenticatedMemberQuestionIngress,
} from '@deepseek-ai/dsh-member-question-receiver'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const expectedPath = new URL('./snapshots/member-question-receiving.expected.json', import.meta.url)
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('member-question receiving keyless assembled snapshot', () => {
  it('keeps arrival model-free and logs the brief before the first human prompt', async () => {
    const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-member-question-snapshot-'))
    const scaffold = await launchWebScaffold({ harnessHome })
    try {
      const receiver = scaffold.ctx.get('memberQuestionReceiver')
      if (receiver === undefined) throw new Error('member-question snapshot: receiver unavailable')
      const workspacePath = join(scaffold.workspaceCwd, 'workspace')
      await mkdir(workspacePath, { recursive: true })
      const workspace = await scaffold.ctx.workspaceRegistry.create(workspacePath)
      await receiver.bind(
        'account:receiver' as PlatformAccountId,
        'project-snapshot' as never,
        workspace.id,
      )
      const ingress = createAuthenticatedMemberQuestionIngress(receiver)
      const arrived = await ingress({
        authority: { accountId: 'account:receiver' as PlatformAccountId },
        operation: {
          type: 'member-question',
          operationId: 'operation-snapshot' as never,
          questionId: 'question-snapshot' as never,
          projectId: 'project-snapshot' as never,
          originSessionId: 'origin-session-snapshot' as never,
          expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
          origin: {
            projectName: 'Project Atlas',
            originSessionTitle: 'Receiver launch decision',
            askerAccountId: 'account:alice',
            askerRole: 'owner',
            askerDisplayName: 'Alice',
            askerAvatarUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
          },
          background: 'The preview needs a reversible channel before the wider release.',
          questions: [{
            id: 'release-channel',
            header: 'Choose a channel',
            question: 'Which release channel should carry the receiver preview?',
            options: [
              { label: 'Canary (Recommended)', description: 'Limits the first rollout.' },
              { label: 'Stable', description: 'Makes the preview broadly visible.' },
            ],
          }],
          references: [{ path: 'docs/receiver-decision.md', reason: 'Lists the rollout constraints' }],
        },
      })
      const sessionAfterArrival = scaffold.ctx.sessions.get(arrived.receivingSessionId as never)
      if (sessionAfterArrival === undefined) throw new Error('member-question snapshot: Host Session was not materialized on arrival')
      const arrival = {
        sessionCount: scaffold.ctx.sessions.list().length,
        requestCount: sessionAfterArrival.events.filter(event => event.type === 'request/header').length,
        receivedCount: sessionAfterArrival.events.filter(event => event.type === 'member-question/received').length,
        attached: workspace.sessionIds.includes(arrived.receivingSessionId as never),
      }

      await receiver.admitHumanTurn({
        receivingSessionId: arrived.receivingSessionId,
        revision: arrived.revision,
        rpcId: 'rpc-snapshot' as never,
        content: [{ type: 'text', text: 'Help me evaluate the rollout tradeoffs before I answer.' }],
        mode: 'queue',
      })
      await expect.poll(() => scaffold.ctx.sessions.get(arrived.receivingSessionId as never)?.events
        .filter(event => event.type === 'request/header').length).toBe(1)
      const session = scaffold.ctx.sessions.get(arrived.receivingSessionId as never)
      if (session === undefined) throw new Error('member-question snapshot: Host Session was not materialized')
      const received = session.events.find(event => event.type === 'member-question/received')
      if (received?.type !== 'member-question/received') throw new Error('member-question snapshot: received event missing')
      const snapshot = {
        arrival,
        firstHumanTurn: {
          eventTypes: session.events
            .filter(event => [
              'member-question/received',
              'agent/inbox/spliced',
              'turn/start',
              'user/message',
              'request/header',
            ].includes(event.type))
            .map(event => event.type),
          received: {
            questionId: received.data.questionId,
            projectId: received.data.projectId,
            originSessionId: received.data.originSessionId,
            expiresAt: received.data.expiresAt,
            origin: received.data.origin,
            background: received.data.background,
            questions: received.data.questions,
            references: received.data.references,
          },
          messages: session.deriveMessages()
            .filter(message => message.source.kind === 'user'
              || (message.source.kind === 'plugin' && message.source.plugin === 'member-question-receiver'))
            .map(message => ({
              role: message.role,
              content: message.content,
              source: message.source,
            })),
          requestCount: session.events.filter(event => event.type === 'request/header').length,
        },
      }
      const output = `${JSON.stringify(snapshot, null, 2)}\n`
      if (refreshing) await writeFile(expectedPath, output)
      expect(output).toBe(await readFile(expectedPath, 'utf8'))
    } finally {
      await scaffold.close()
      await rm(harnessHome, { recursive: true, force: true })
    }
  })
})
