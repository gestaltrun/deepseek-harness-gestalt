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
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import { parseCompanionSessionId, parseMemberQuestionProjectId } from '@deepseek-ai/dsh-remote-protocol'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import Sender from '@deepseek-ai/dsh-member-question-sender'
import type { EncodedMemberQuestion, EncodedMemberQuestionDocument, MemberQuestionDeliveryPort, MemberQuestionTerminalClaim } from '@deepseek-ai/dsh-member-question-sender'
import type { CompanionMemberQuestionSettledResult, MemberQuestionId } from '@deepseek-ai/dsh-remote-protocol'

interface Booted {
  context: Context
  root: string
  delivery: DeferredDelivery
  localRequests: unknown[]
  run: () => Promise<{ local: string; member: string }>
}

interface Delivered extends EncodedMemberQuestion {
  toProjectMember: string
  projectId: ReturnType<typeof parseMemberQuestionProjectId>
  documents: readonly EncodedMemberQuestionDocument[]
}

class DeferredDelivery implements MemberQuestionDeliveryPort {
  readonly delivered: Promise<Delivered>
  private resolveDelivered!: (value: Delivered) => void
  private readonly terminals = new Map<MemberQuestionId, CompanionMemberQuestionSettledResult>()
  captured: Delivered | undefined

  constructor() {
    this.delivered = new Promise((resolve) => { this.resolveDelivered = resolve })
  }

  deliver(value: Delivered): Promise<void> {
    this.captured = value
    this.resolveDelivered(value)
    return Promise.resolve()
  }

  publishTerminal(terminal: CompanionMemberQuestionSettledResult): Promise<MemberQuestionTerminalClaim> {
    const retained = this.terminals.get(terminal.questionId)
    if (retained !== undefined) return Promise.resolve({ claimed: false, terminal: retained })
    this.terminals.set(terminal.questionId, terminal)
    return Promise.resolve({ claimed: true, terminal })
  }

  queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined> {
    return Promise.resolve(this.terminals.get(questionId))
  }
}

async function testAgent(context: Context, cwd: string): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const agentScope = context.plugin(() => undefined)
  await agentScope
  const id = SessionId('loader-session')
  const session = Session.create(id, undefined, { version: 0, id, createdAt: 0, cwd, isSeeded: false })
  const agent: Agent = {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle', ctx: agentScope.ctx, send() {}, followup() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, dispose: () => agentScope.dispose() }
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-question-loader-'))
  const context = new Context()
  const delivery = new DeferredDelivery()
  const localRequests: unknown[] = []
  let run: Booted['run'] | undefined
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-user-questions'",
      "- name: 'test-ui-answerer'",
      "- name: 'test-delivery-config'",
      "- name: '@deepseek-ai/dsh-member-question-sender'",
      '  inject:',
      '    - testDeliveryConfig',
      '  config:',
      '    delivery: !!js ctx.get(\"testDeliveryConfig\").delivery',
      "- name: 'test-tool-ask-user'",
      "- name: 'test-driver'",
      '',
    ].join('\n'))
    const ui = { name: 'test-ui', apply(ctx: Context) { ctx.on('user-questions/request', (request) => { localRequests.push(request); return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['local'] })) }) }) } }
    const deliveryConfig = { name: 'test-delivery-config', apply(ctx: Context) { ctx.provide('testDeliveryConfig', { delivery }) } }
    const senderModule = { default: Sender }
    const tool = {
      name: 'test-tool-ask-user',
      inject: ['tools', 'userQuestions'],
      apply(ctx: Context) {
        toolAskUser.apply(ctx, {
          boundProjectResolver: () => Promise.resolve(parseMemberQuestionProjectId('loader-project')),
          routeResolver: () => Promise.resolve({
            toProjectMember: parsePlatformAccountId('loader-peer'),
            projectId: parseMemberQuestionProjectId('loader-project'),
            origin: {
              projectName: 'Loader', originSessionTitle: 'Composition',
              askerAccountId: parsePlatformAccountId('loader-asker'), askerRole: 'member',
              askerDisplayName: 'Ask', askerAvatarUrl: 'https://example.test/ask.png',
            },
          }),
        })
      },
    }
    const { agent, dispose: disposeAgentScope } = await testAgent(context, root)
    const driver = { name: 'test-driver', inject: ['agents', 'tools', 'memberQuestionSender'], apply(ctx: Context) { run = async () => {
      expect(ctx.memberQuestionSender).toBeInstanceOf(Sender)
      const unregister = ctx.agents.register(agent)
      let result: { local: string; member: string }
      try {
        expect(ctx.agents.get(agent.id)).toBe(agent)
        const local = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('local'), name: 'ask_user_question', arguments: { questions: [{ id: 'local', question: 'Local?' }] } })
        const memberPromise = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('member'), name: 'ask_user_question', agent, arguments: { questions: [{ id: 'member', question: 'Member?' }], to_project_member: 'loader-peer', background: 'Choose the release window.', references: [{ path: 'decision.txt', reason: 'Release evidence.' }] } })
        const delivered = await Promise.race([
          delivery.delivered,
          memberPromise.then((result) => { throw new Error(`member tool settled before delivery: ${JSON.stringify(result)}`) }),
        ])
        const questionId = delivered.questionId
        await ctx.memberQuestionSender.settle(questionId, { outcome: 'declined', settledByInstallationId: parseInstallationId('loader-installation'), settledByDeviceName: 'Loader', settledAt: 1 })
        const member = await memberPromise
        const text = (result: typeof local) => result.content.filter(block => block.type === 'text').map(block => block.text).join('')
        result = { local: text(local), member: text(member) }
      } finally {
        try {
          unregister()
        } finally {
          await disposeAgentScope()
        }
      }
      expect(ctx.agents.get(agent.id)).toBeUndefined()
      return result
    } } }
    context.baseUrl = `${pathToFileURL(root).href}/`
    await writeFile(join(root, 'decision.txt'), 'release evidence\n')
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-user-questions', UserQuestions], ['test-ui-answerer', ui], ['test-delivery-config', deliveryConfig],
      ['@deepseek-ai/dsh-member-question-sender', senderModule], ['test-tool-ask-user', tool], ['test-driver', driver],
    ])
    context.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`); return modules.get(specifier) } } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const providerEntry = [...context.loader.entries()].find(entry => entry.options.name === 'test-delivery-config')
    const senderEntry = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-member-question-sender')
    if (providerEntry === undefined || senderEntry === undefined) throw new Error('expected delivery and sender Loader entries')
    expect(providerEntry.fiber).toBeDefined()
    expect(senderEntry.fiber).toBeDefined()
    const unloaded = [...context.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)
    if (unloaded.length > 0) throw new Error(`enabled Loader entries did not load: ${unloaded.map(entry => entry.options.name).join(', ')}`)
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
      expect(composed.localRequests[0]).not.toHaveProperty('memberRoute')
      const delivered = composed.delivery.captured
      expect(delivered?.message.type).toBe('operation')
      if (delivered?.message.type !== 'operation') throw new Error('expected operation delivery')
      expect(delivered.message.operation).toMatchObject({
        projectId: parseMemberQuestionProjectId('loader-project'),
        originSessionId: parseCompanionSessionId('loader-session'),
        background: 'Choose the release window.',
        questions: [{ id: 'member', question: 'Member?' }],
        references: [{ path: 'decision.txt', reason: 'Release evidence.' }],
        origin: { projectName: 'Loader', originSessionTitle: 'Composition', askerAccountId: parsePlatformAccountId('loader-asker'), askerRole: 'member', askerDisplayName: 'Ask', askerAvatarUrl: 'https://example.test/ask.png' },
      })
      expect(delivered.toProjectMember).toBe('loader-peer')
      expect(delivered.projectId).toBe(parseMemberQuestionProjectId('loader-project'))
      expect(delivered.documents).toHaveLength(1)
      expect(delivered.documents[0]?.path).toBe('decision.txt')
      expect(delivered.documents[0]?.messages).toHaveLength(1)
      const documentMessage = delivered.documents[0]?.messages[0]
      expect(documentMessage?.type).toBe('operation')
      if (documentMessage?.type !== 'operation' || documentMessage.operation.type !== 'document-chunk') {
        throw new Error('expected one document chunk')
      }
      expect(documentMessage.operation).toMatchObject({
        questionId: delivered.questionId,
        index: 0,
        total: 1,
        bytes: 'cmVsZWFzZSBldmlkZW5jZQo',
      })
    } finally {
      await composed.context.fiber.dispose()
      await rm(composed.root, { recursive: true, force: true })
    }
  }, 30_000)
})
