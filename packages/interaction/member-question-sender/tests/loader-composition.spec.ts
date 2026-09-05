import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { InstallationId } from '@deepseek-ai/dsh-platform-account'
import { parseCompanionSessionId, parseMemberQuestionProjectId } from '@deepseek-ai/dsh-remote-protocol'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import Sender, { MemoryMemberQuestionDelivery } from '../src/index.ts'

interface Booted {
  context: Context
  root: string
  delivery: MemoryMemberQuestionDelivery
  localRequests: unknown[]
  run: () => Promise<{ local: string; member: string }>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-question-loader-'))
  const context = new Context()
  const delivery = new MemoryMemberQuestionDelivery()
  const localRequests: unknown[] = []
  let run: Booted['run'] | undefined
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-user-questions'",
      "- name: 'test-ui-answerer'",
      "- name: 'test-member-question-sender'",
      "- name: '@deepseek-ai/dsh-tool-ask-user'",
      '  config:',
      "    boundProjectResolver: !!js \"async () => 'loader-project'\"",
      "    routeResolver: !!js \"async () => ({ toProjectMember: 'loader-peer', projectId: 'loader-project', origin: { projectName: 'Loader', originSessionTitle: 'Composition', askerAccountId: 'loader-asker', askerRole: 'member', askerDisplayName: 'Ask', askerAvatarUrl: 'https://example.test/ask.png' } })\"",
      "- name: 'test-driver'",
      '',
    ].join('\n'))
    const ui = { name: 'test-ui', apply(ctx: Context) { ctx.on('user-questions/request', (request) => { localRequests.push(request); return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['local'] })) }) }) } }
    class TestSender extends Sender { constructor(ctx: Context) { super(ctx, { delivery }) } }
    const driver = { name: 'test-driver', inject: ['tools', 'memberQuestionSender'], apply(ctx: Context) { run = async () => {
      const local = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('local'), name: 'ask_user_question', arguments: { questions: [{ id: 'local', question: 'Local?' }] } })
      const memberPromise = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('member'), name: 'ask_user_question', arguments: { questions: [{ id: 'member', question: 'Member?' }], to_project_member: 'loader-peer', background: 'Choose the release window.' } })
      for (let attempt = 0; attempt < 20 && delivery.delivered.length === 0; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const questionId = delivery.delivered[0]?.questionId
      if (questionId === undefined) throw new Error('member question was not delivered')
      await ctx.memberQuestionSender.settle(questionId, { outcome: 'declined', settledByInstallationId: 'loader-installation' as InstallationId, settledByDeviceName: 'Loader', settledAt: 1 })
      const member = await memberPromise
      const text = (result: typeof local) => result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      return { local: text(local), member: text(member) }
    } } }
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-user-questions', UserQuestions], ['test-ui-answerer', ui],
      ['test-member-question-sender', TestSender], ['@deepseek-ai/dsh-tool-ask-user', toolAskUser], ['test-driver', driver],
    ])
    context.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`); return modules.get(specifier) } } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    if (run === undefined) throw new Error('composition driver did not activate')
    return { context, root, delivery, localRequests, run }
  } catch (error) {
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe('member-question sender real Loader composition', () => {
  it('routes local and member tool calls through their composed answerers', async () => {
    const composed = await boot()
    try {
      const result = await composed.run()
      expect(result).toEqual({ local: '{"answers":[{"id":"local","selected":["local"]}]}', member: '{"answers":[]}' })
      expect(composed.localRequests).toHaveLength(1)
      expect(composed.delivery.delivered).toHaveLength(1)
      expect(composed.delivery.delivered[0]?.message.operation).toMatchObject({
        projectId: parseMemberQuestionProjectId('loader-project'),
        originSessionId: parseCompanionSessionId('unbound-origin'),
        background: 'Choose the release window.',
        questions: [{ id: 'member', question: 'Member?' }],
      })
    } finally {
      await composed.context.fiber.dispose()
      await rm(composed.root, { recursive: true, force: true })
    }
  }, 30_000)
})
