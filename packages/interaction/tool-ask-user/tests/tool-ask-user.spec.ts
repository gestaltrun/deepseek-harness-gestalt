import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import UserQuestionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import CompanionMemberQuestionSender, {
  MemoryMemberQuestionDelivery,
  type MemberQuestionSettlement,
} from '@deepseek-ai/dsh-member-question-sender'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import { BACKGROUND_MAX_CODE_POINTS } from '@deepseek-ai/dsh-tool-ask-user'

const testToolSignal = new AbortController().signal

function humanSettlement(
  outcome: 'declined' | { answers: Extract<MemberQuestionSettlement, { outcome: 'answered' }>['answers'] },
): MemberQuestionSettlement {
  const metadata = {
    settledByInstallationId: 'installation-studio' as never,
    settledByDeviceName: 'Ada Studio',
    settledAt: 1_788_089_400_000,
  }
  return outcome === 'declined'
    ? { outcome, ...metadata }
    : { outcome: 'answered', answers: outcome.answers, ...metadata }
}

async function waitForDelivery(delivery: MemoryMemberQuestionDelivery): Promise<void> {
  const deadline = Date.now() + 1000
  while (delivery.delivered.length === 0) {
    if (Date.now() >= deadline) throw new Error('member-question delivery never started')
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

interface OptionSchemaShape {
  properties: {
    questions: {
      items: {
        properties: {
          options: {
            items: {
              properties: Record<string, { type: string }>
            }
          }
        } & Record<string, unknown>
      }
    }
    to_project_member: { type: string }
    background: { type: string }
    references: {
      type: string
      items: {
        properties: Record<string, { type: string }>
        required?: string[]
      }
    }
  }
  required: string[]
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(toolAskUser)
  return ctx
}

function stubAgent(id: string, delegationDepth = 0, cwd?: string, extras: Record<string, unknown> = {}): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: {
      id: agentId,
      header: { delegationDepth, ...cwd !== undefined ? { cwd } : {} },
      ...extras,
    },
  } as unknown as Agent
}

const routedOrigin = {
  projectName: 'Atlas',
  originSessionTitle: 'Refactor the ingest pipeline',
  askerAccountId: 'account-asker',
  askerRole: 'admin' as const,
  askerDisplayName: 'Ada',
  askerAvatarUrl: 'https://example.test/ada.png',
}

async function setupRouted(delivery = new MemoryMemberQuestionDelivery()) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(CompanionMemberQuestionSender, { delivery })
  await ctx.plugin(toolAskUser, {
    originResolver: () => Promise.resolve(routedOrigin),
    boundProjectResolver: () => Promise.resolve('project-atlas'),
  })
  return { ctx, delivery }
}

describe('ask_user_question tool', () => {
  it('registers a model-facing tool schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'ask_user_question')

    expect(schema).toMatchObject({
      name: 'ask_user_question',
      parameters: {
        type: 'object',
        properties: {
          questions: { type: 'array' },
        },
        required: ['questions'],
      },
    })
    const parameters = schema?.parameters as unknown as OptionSchemaShape
    expect(parameters.properties.to_project_member).toMatchObject({ type: 'string' })
    expect(parameters.properties.background).toMatchObject({ type: 'string' })
    expect(parameters.properties.references).toMatchObject({ type: 'array' })
    expect(parameters.properties.references.items.properties).toMatchObject({
      path: { type: 'string' },
      reason: { type: 'string' },
    })
    expect(parameters.required).toEqual(['questions'])
    expect(parameters.required).not.toContain('to_project_member')
    expect(parameters.required).not.toContain('background')
    expect(parameters.required).not.toContain('references')
    expect(parameters.properties.questions.items.properties).toMatchObject({
      id: { type: 'string' },
      question: { type: 'string' },
      header: { type: 'string' },
      options: { type: 'array' },
      multi_select: { type: 'boolean' },
    })
    expect(parameters.properties.questions.items.properties.options.items.properties).toMatchObject({
      label: { type: 'string' },
      description: { type: 'string' },
    })
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('value')
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('recommended')
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('preview')
  })

  it('asks the registered user-questions provider and projects structured answers to text', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['pnpm'] }] }
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-1'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'pkg',
          question: 'Which package manager should I use?',
          options: [{ label: 'pnpm', description: 'Use pnpm workspaces.' }],
        }],
      },
    })

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"answers":[{"id":"pkg","selected":["pnpm"]}]}' }],
    })
    expect(seen).toMatchObject([{
      questions: [{
        id: 'pkg',
        question: 'Which package manager should I use?',
        options: [{ label: 'pnpm', description: 'Use pnpm workspaces.' }],
      }],
    }])
  })

  it('passes recommended option labels through without adding schema fields', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['pnpm (Recommended)'] }] }
      },
    })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-recommended'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'pkg',
          question: 'Which package manager should I use?',
          options: [
            { label: 'pnpm (Recommended)' },
            { label: 'npm' },
          ],
        }],
      },
    })

    expect(seen[0]?.questions[0]?.options).toEqual([
      { label: 'pnpm (Recommended)' },
      { label: 'npm' },
    ])
  })

  it('projects custom answers and multi-select choices', async () => {
    const ctx = await setup()
    ctx.userQuestions.registerProvider({
      async ask() {
        return {
          answers: [
            { id: 'targets', selected: ['tests', 'docs'], custom: 'release notes' },
            { id: 'labels-only', selected: ['tests'] },
            { id: 'notes', selected: [], custom: 'ship today' },
          ],
        }
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-multi'),
      name: 'ask_user_question',
      arguments: {
        questions: [
          {
            id: 'targets',
            question: 'What should I update?',
            options: [{ label: 'tests' }, { label: 'docs' }],
            multi_select: true,
          },
          {
            id: 'labels-only',
            question: 'Which labels should I keep?',
            options: [{ label: 'tests' }, { label: 'docs' }],
            multi_select: true,
          },
          { id: 'notes', question: 'Any note?' },
        ],
      },
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ask_user_question success')
    expect(result.value).toEqual({
      answers: [
        { id: 'targets', selected: ['tests', 'docs'], custom: 'release notes' },
        { id: 'labels-only', selected: ['tests'] },
        { id: 'notes', selected: [], custom: 'ship today' },
      ],
    })
    expect(result.content).toEqual([{
      type: 'text',
      text: '{"answers":[{"id":"targets","selected":["tests","docs"],"custom":"release notes"},{"id":"labels-only","selected":["tests"]},{"id":"notes","selected":[],"custom":"ship today"}]}',
    }])
  })

  it('passes the tool abort signal to the user-questions request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const controller = new AbortController()

    await ctx.tools.execute({
      callId: CallId('ask-2'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
      signal: controller.signal,
    })

    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('passes optional header and a resumed runtime root through to the user-questions request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-3'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', header: 'Confirm', question: 'Continue?' }] },
      agent,
    })

    expect(result.content).toEqual([{ type: 'text', text: '{"answers":[{"id":"continue","selected":["ok"]}]}' }])
    expect(seen[0]).toMatchObject({ questions: [{ id: 'continue', header: 'Confirm', question: 'Continue?' }], agent })
  })

  it('returns structured user-questions errors through tool execution', async () => {
    const ctx = await setup()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-no-provider'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'NO_PROVIDER' } },
    })
  })

  it('rejects a live runtime-owned agent with a structured DELEGATED_CALLER error', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-delegated'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
      agent: child,
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'DELEGATED_CALLER' } },
      content: [{
        type: 'text',
        text: "Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
      }],
    })
    expect(seen).toHaveLength(0)
  })

  it('returns a structured error for empty question batches', async () => {
    const ctx = await setup()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-empty'),
      name: 'ask_user_question',
      arguments: { questions: [] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' } },
    })
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    const fiber = await ctx.plugin(toolAskUser)
    expect(ctx.tools.get('ask_user_question')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('ask_user_question')).toBeUndefined()
  })

  it('accepts local asks with workspace-bounded references without routing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ask-user-refs-'))
    writeFileSync(join(workspace, 'plan.md'), '# plan\n')
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['pnpm'] }] }
      },
    })
    const agent = stubAgent('local-root', 0, workspace)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-refs-local'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Which package manager should I use?' }],
        references: [{ path: 'plan.md', reason: 'Current rollout plan' }],
      },
      agent,
    })

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"answers":[{"id":"pkg","selected":["pnpm"]}]}' }],
    })
    expect(seen).toHaveLength(1)
  })

  it('rejects a routed ask without background at construction', async () => {
    const { ctx } = await setupRouted()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-routed-missing-background'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
      },
    })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'BACKGROUND_REQUIRED' } },
    })
  })

  it('rejects a routed ask whose background exceeds 600 code points', async () => {
    const { ctx } = await setupRouted()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-routed-long-background'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
        background: '文'.repeat(BACKGROUND_MAX_CODE_POINTS + 1),
      },
    })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'BACKGROUND_TOO_LONG' } },
    })
  })

  it('rejects references that leave the workspace or carry an overlong reason', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ask-user-bad-refs-'))
    writeFileSync(join(workspace, 'inside.md'), 'ok\n')
    mkdirSync(join(workspace, 'nested'))
    const ctx = await setup()
    ctx.userQuestions.registerProvider({
      async ask() {
        return { answers: [{ id: 'pkg', selected: ['ok'] }] }
      },
    })
    const agent = stubAgent('local-root', 0, workspace)
    ctx.agents.enter(agent, undefined)

    const outside = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-refs-outside'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        references: [{ path: '../secret.md' }],
      },
      agent,
    })
    expect(outside).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'REFERENCES_INVALID' } },
    })

    const missing = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-refs-missing'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        references: [{ path: 'missing.md' }],
      },
      agent,
    })
    expect(missing).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'REFERENCES_INVALID' } },
    })

    const longReason = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-refs-reason'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        references: [{ path: 'inside.md', reason: 'x'.repeat(101) }],
      },
      agent,
    })
    expect(longReason).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'REFERENCES_INVALID' } },
    })
  })

  it('routes to_project_member through the member-question sender and skips the local provider', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-ask-user-routed-'))
    writeFileSync(join(workspace, 'plan.md'), '# plan\n')
    const { ctx, delivery } = await setupRouted()
    const seen: AskUserQuestionRequest[] = []
    ctx.userQuestions.registerProvider({
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['local'] }] }
      },
    })
    const events: Array<{ type: string; data: unknown }> = []
    const agent = stubAgent('routed-root', 0, workspace, {
      append: (type: string, data: unknown) => {
        events.push({ type, data })
        return { type, data }
      },
    })
    ctx.agents.enter(agent, undefined)

    const executing = ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-routed'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?', options: [{ label: 'yes' }] }],
        to_project_member: 'account-peer',
        background: 'Need a rollback window before Friday.',
        references: [{ path: 'plan.md' }, { path: 'plan.md', reason: 'Current rollout plan' }],
      },
      agent,
    })
    await waitForDelivery(delivery)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(
      questionId!,
      humanSettlement({ answers: [{ id: 'pkg', selected: ['yes'] }] }),
    )
    const result = await executing

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '{"answers":[{"id":"pkg","selected":["yes"]}]}' }])
    expect(seen).toHaveLength(0)
    const message = delivery.delivered[0]?.message
    expect(message?.type).toBe('operation')
    if (message?.type !== 'operation') throw new Error('expected member-question operation')
    expect(message.operation.type).toBe('member-question')
    if (message.operation.type !== 'member-question') throw new Error('expected member-question operation')
    expect(message.operation.background).toBe('Need a rollback window before Friday.')
    expect(message.operation.origin).toEqual(routedOrigin)
    expect(message.operation.references).toEqual([
      { path: 'plan.md', reason: 'plan.md' },
      { path: 'plan.md', reason: 'Current rollout plan' },
    ])
    expect(events.map(event => event.type)).toEqual(['member-question/asked', 'member-question/outcome'])
  })

  it('returns empty answers when the member declines', async () => {
    const { ctx, delivery } = await setupRouted()
    const executing = ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-declined'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
        background: 'Need a rollback window before Friday.',
      },
    })
    await waitForDelivery(delivery)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(questionId!, humanSettlement('declined'))
    const result = await executing
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '{"answers":[]}' }])
  })

  it('rejects a routed ask when the sender is not composed', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-no-sender'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
        background: 'Need a rollback window before Friday.',
      },
    })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'AskUserQuestionError', code: 'SENDER_UNAVAILABLE' } },
    })
  })

  it('hides to_project_member from assembled prompts when the workspace is unbound', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'Echo.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ok'),
    }))
    const assembly = await ctx.systemPrompt.assemble()
    const schema = assembly.tools.find(tool => tool.name === 'ask_user_question')
    const parameters = schema?.parameters as { properties?: Record<string, unknown> } | undefined
    expect(parameters?.properties).not.toHaveProperty('to_project_member')
    expect(parameters?.properties).toHaveProperty('questions')
    expect(parameters?.properties).toHaveProperty('references')
    expect(assembly.tools.some(tool => tool.name === 'echo')).toBe(true)
    expect(ctx.tools.schemas().find(tool => tool.name === 'ask_user_question')?.parameters)
      .toHaveProperty('properties.to_project_member')
  })

  it('surfaces to_project_member in assembled prompts when the workspace is bound', async () => {
    const { ctx } = await setupRouted()
    const assembly = await ctx.systemPrompt.assemble()
    const schema = assembly.tools.find(tool => tool.name === 'ask_user_question')
    const parameters = schema?.parameters as { properties?: Record<string, unknown> } | undefined
    expect(parameters?.properties).toHaveProperty('to_project_member')
  })

  it('hides to_project_member when the bound-project resolver rejects', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(toolAskUser, {
      boundProjectResolver: () => Promise.reject(new Error('no project')),
    })
    const assembly = await ctx.systemPrompt.assemble()
    const schema = assembly.tools.find(tool => tool.name === 'ask_user_question')
    const parameters = schema?.parameters as { properties?: Record<string, unknown> } | undefined
    expect(parameters?.properties).not.toHaveProperty('to_project_member')
  })

  it('rejects a non-function injected resolver at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await expect(ctx.plugin(toolAskUser, { originResolver: {} as never }))
      .rejects.toThrow(/originResolver must be a resolver function/)
    await expect(ctx.plugin(toolAskUser, { boundProjectResolver: {} as never }))
      .rejects.toThrow(/boundProjectResolver must be a resolver function/)
  })

  it('forwards the addressee as project id when boundProjectResolver is omitted', async () => {
    const ctx = new Context()
    const delivery = new MemoryMemberQuestionDelivery()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(CompanionMemberQuestionSender, { delivery })
    await ctx.plugin(toolAskUser, {
      originResolver: () => Promise.resolve(routedOrigin),
    })
    const executing = ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-no-bound'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
        background: 'Need a rollback window before Friday.',
      },
    })
    await waitForDelivery(delivery)
    const questionId = delivery.delivered[0]?.questionId
    expect(questionId).toBeDefined()
    await ctx.memberQuestionSender.settle(
      questionId!,
      humanSettlement({ answers: [{ id: 'pkg', selected: [], custom: 'later' }] }),
    )
    const result = await executing
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{
      type: 'text',
      text: '{"answers":[{"id":"pkg","selected":[],"custom":"later"}]}',
    }])
  })

  it('retains MEMBER_OFFLINE as an ordinary tool result', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(CompanionMemberQuestionSender, {
      delivery: new MemoryMemberQuestionDelivery(),
      presenceLookup: () => Promise.resolve('offline'),
    })
    await ctx.plugin(toolAskUser, {
      originResolver: () => Promise.resolve(routedOrigin),
      boundProjectResolver: () => Promise.resolve('project-atlas'),
    })
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('ask-offline'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'pkg', question: 'Ship it?' }],
        to_project_member: 'account-peer',
        background: 'Need a rollback window before Friday.',
      },
    })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'MemberQuestionSenderError', code: 'MEMBER_OFFLINE' } },
    })
  })
})
