/**
 * Host-side assembly for the `project_members` tool: a stub current-account
 * resolver injected through Config and an in-memory membership provider
 * behind the real Service Definition prove the canonical JSON shape and the
 * stable `PROJECT_UNBOUND` / `ACCOUNT_UNAVAILABLE` error paths.
 * @module tests/tool-project-members.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  ProjectMembershipError,
  ProjectMembershipService,
  type FunctionTag,
  type MemberView,
  type MembershipId,
  type ProjectId,
  type ProjectView,
  type RosterView,
} from '@deepseek-ai/dsh-project-membership'
import type { Branded } from '@deepseek-ai/dsh-brand'
import * as toolProjectMembers from '@deepseek-ai/dsh-tool-project-members'
import type { Config } from '@deepseek-ai/dsh-tool-project-members'

/** The same brand key the Account Service Definition uses; tests never import a platform package. */
type TestAccountId = Branded<'PlatformAccountId'>

const testToolSignal = new AbortController().signal

const account = (id: string): TestAccountId => id as TestAccountId
const projectId = (id: string): ProjectId => id as ProjectId

/** Stored member seeds for one in-memory project. */
interface SeedMember {
  readonly accountId: TestAccountId
  readonly role: 'owner' | 'admin' | 'member'
  readonly tags: string[]
}

const PROJECT: ProjectView = {
  id: projectId('proj-alpha'),
  name: 'alpha',
  boundRemoteUrl: 'https://github.com/example/alpha.git',
  createdAt: 1_000,
}

const SEED_MEMBERS: readonly SeedMember[] = [
  { accountId: account('acc-owner'), role: 'owner', tags: ['founding'] },
  { accountId: account('acc-member'), role: 'member', tags: ['docs', 'review'] },
]

/** The unreachable mutation surface of the read-only test provider. */
function unreachable(): Error {
  return new Error('tool-project-members tests never reach membership mutations')
}

/**
 * In-memory membership provider backing the roster read. Mirrors the service
 * contract its readers rely on: unknown projects reject, and only an active
 * member may enumerate a roster.
 */
class MemoryProjectMembership extends ProjectMembershipService {
  private readonly projects = new Map<ProjectId, ProjectView>()
  private readonly members = new Map<ProjectId, MemberView[]>()

  constructor(ctx: Context) {
    super(ctx)
    this.projects.set(PROJECT.id, PROJECT)
    this.members.set(PROJECT.id, SEED_MEMBERS.map((member, index) => ({
      id: `mem-${index}` as MembershipId,
      accountId: member.accountId,
      role: member.role,
      tags: member.tags as FunctionTag[],
      joinedAt: 2_000 + index,
    })))
  }

  override async roster(actor: TestAccountId, id: ProjectId): Promise<RosterView> {
    const project = this.projects.get(id)
    const members = this.members.get(id)
    if (project === undefined || members === undefined) {
      throw new ProjectMembershipError('PROJECT_NOT_FOUND', `project ${id} does not exist`)
    }
    if (!members.some(member => member.accountId === actor)) {
      throw new ProjectMembershipError('NOT_A_MEMBER', `account ${actor} holds no membership in project ${id}`)
    }
    return { project, members }
  }

  override async createProject(): Promise<never> {
    throw unreachable()
  }

  override async invite(): Promise<never> {
    throw unreachable()
  }

  override async retractInvitation(): Promise<never> {
    throw unreachable()
  }

  override async acceptInvitation(): Promise<never> {
    throw unreachable()
  }

  override async declineInvitation(): Promise<never> {
    throw unreachable()
  }

  override async changeRole(): Promise<never> {
    throw unreachable()
  }

  override async setMemberTags(): Promise<never> {
    throw unreachable()
  }

  override async removeMember(): Promise<never> {
    throw unreachable()
  }

  override async pendingInvitationsFor(): Promise<never> {
    throw unreachable()
  }

  override async pendingInvitationContextsFor(): Promise<never> {
    throw unreachable()
  }

  override async pendingInvitationsIssuedBy(): Promise<never> {
    throw unreachable()
  }

  override async projectByRemote(): Promise<never> {
    throw unreachable()
  }

  override async rosterVersion(): Promise<never> {
    throw unreachable()
  }
}

/** Resolves the session-bound account for the happy-path compositions. */
const resolveActorAccount = async (): Promise<TestAccountId> => account('acc-owner')

/** The faces every happy-path call needs: the session-bound account. */
const ACTOR_CONFIG: Config = {
  currentAccountResolver: resolveActorAccount,
}

/** Boot the tool on a real context with the given injected faces. */
async function setup(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryProjectMembership)
  await ctx.plugin(toolProjectMembers, config)
  return ctx
}

function stubAgent(id: string): Agent {
  return {
    id,
    session: { id, header: { cwd: '/workspace/alpha' }, deriveMessages: () => [] },
  } as unknown as Agent
}

/** Execute one `project_members` call and return the registry-normalized result. */
async function execute(
  ctx: Context,
  callId: string,
  arguments_: Record<string, unknown> = {},
  agent?: Agent,
) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(callId),
    name: 'project_members',
    arguments: arguments_,
    ...agent === undefined ? {} : { agent },
  })
}

/** Parse the single text block of a successful result. */
function resultValue(result: { content: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

describe('project_members tool', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in toolProjectMembers).toBe(false)
    expect(toolProjectMembers.name).toBe('tool-project-members')
    expect(toolProjectMembers.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolProjectMembers) as Record<string, unknown>
    expect(unwrapped).toBe(toolProjectMembers)
    expect(unwrapped.name).toBe('tool-project-members')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('registers a model-facing schema with an optional projectId and an array output', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'project_members')

    expect(schema).toMatchObject({
      name: 'project_members',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
      },
    })
    expect(schema?.parameters.required).toBeUndefined()
    const output = ctx.tools.get('project_members')?.output?.schema as {
      type: string
      items: {
        required?: string[]
        properties: {
          accountId: { description?: string }
          displayName: { description?: string }
          self: { type?: string }
        }
      }
    }
    expect(output).toMatchObject({ type: 'array' })
    expect(output.items.properties.displayName.description).toContain('ask_user_question.to_project_member')
    expect(output.items.properties.accountId.description).toContain('Not the ask_user_question.to_project_member')
    expect(output.items.properties.self).toMatchObject({ type: 'boolean' })
    expect(output.items.required).toEqual(expect.arrayContaining(['self']))
  })

  it('returns the full roster as compact JSON with presence offline absent a presenter', async () => {
    const ctx = await setup(ACTOR_CONFIG)

    const result = await execute(ctx, 'pm-roster', { projectId: 'proj-alpha' })

    expect(result.isError).toBe(false)
    expect(resultValue(result)).toEqual([
      { accountId: 'acc-owner', role: 'owner', tags: ['founding'], presence: 'offline', self: true },
      { accountId: 'acc-member', role: 'member', tags: ['docs', 'review'], presence: 'offline', self: false },
    ])
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: '[{"accountId":"acc-owner","role":"owner","tags":["founding"],"presence":"offline","self":true},'
        + '{"accountId":"acc-member","role":"member","tags":["docs","review"],"presence":"offline","self":false}]',
    })
  })

  it('resolves the workspace-bound project when projectId is omitted', async () => {
    let bindingCalls = 0
    let seenAgent: Agent | undefined
    const agent = stubAgent('session-alpha')
    const ctx = await setup({
      currentAccountResolver: async ({ agent: resolvedAgent } = {}) => {
        seenAgent = resolvedAgent
        return account('acc-owner')
      },
      boundProjectResolver: async ({ agent: resolvedAgent } = {}) => {
        expect(resolvedAgent).toBe(agent)
        bindingCalls += 1
        return projectId('proj-alpha')
      },
    })

    const result = await execute(ctx, 'pm-bound', {}, agent)

    expect(result.isError).toBe(false)
    expect(bindingCalls).toBe(1)
    expect(seenAgent).toBe(agent)
    expect(resultValue(result)).toHaveLength(2)
  })

  it('keeps an explicit projectId authoritative over the workspace binding', async () => {
    let bindingCalls = 0
    const ctx = await setup({
      currentAccountResolver: resolveActorAccount,
      boundProjectResolver: async () => {
        bindingCalls += 1
        return projectId('proj-other')
      },
    })

    const result = await execute(ctx, 'pm-explicit', { projectId: 'proj-alpha' })

    expect(result.isError).toBe(false)
    expect(bindingCalls).toBe(0)
  })

  it('attaches presence and public identity through the injected presenter', async () => {
    const ctx = await setup({
      currentAccountResolver: resolveActorAccount,
      rosterPresenter: async view => view.members.map(member => ({
        presence: member.role === 'owner' ? ('online' as const) : ('offline' as const),
        ...member.role === 'owner' ? { displayName: 'alice', avatarRef: 'https://example.com/a.png' } : {},
      })),
    })

    const result = await execute(ctx, 'pm-presented', { projectId: 'proj-alpha' })

    expect(result.isError).toBe(false)
    expect(resultValue(result)).toEqual([
      {
        accountId: 'acc-owner', displayName: 'alice', avatarRef: 'https://example.com/a.png',
        role: 'owner', tags: ['founding'], presence: 'online', self: true,
      },
      { accountId: 'acc-member', role: 'member', tags: ['docs', 'review'], presence: 'offline', self: false },
    ])
  })

  it('fills missing presenter rows as offline so a short presentation still yields the full roster', async () => {
    const ctx = await setup({
      currentAccountResolver: resolveActorAccount,
      rosterPresenter: async view => view.members.slice(0, 1).map(() => ({
        presence: 'online' as const,
        displayName: 'alice',
      })),
    })

    const result = await execute(ctx, 'pm-short-presenter', { projectId: 'proj-alpha' })

    expect(result.isError).toBe(false)
    expect(resultValue(result)).toEqual([
      { accountId: 'acc-owner', displayName: 'alice', role: 'owner', tags: ['founding'], presence: 'online', self: true },
      { accountId: 'acc-member', role: 'member', tags: ['docs', 'review'], presence: 'offline', self: false },
    ])
  })

  it('answers the stable PROJECT_UNBOUND error when no workspace binding resolves', async () => {
    const ctx = await setup(ACTOR_CONFIG)

    const result = await execute(ctx, 'pm-unbound')

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'PROJECT_UNBOUND' } },
      content: [{
        type: 'text',
        text: 'Error: PROJECT_UNBOUND: no cloud project is bound to this workspace; '
          + 'link the workspace to a project or pass projectId explicitly',
      }],
    })
  })

  it('answers PROJECT_UNBOUND with the binding failure chained as cause', async () => {
    const ctx = await setup({
      currentAccountResolver: resolveActorAccount,
      boundProjectResolver: async () => {
        throw new Error('git remote unavailable')
      },
    })

    const result = await execute(ctx, 'pm-unbound-cause')

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'PROJECT_UNBOUND' } },
    })
  })

  it('answers the stable ACCOUNT_UNAVAILABLE error when no session account resolves', async () => {
    const ctx = await setup({
      boundProjectResolver: async () => projectId('proj-alpha'),
    })

    const result = await execute(ctx, 'pm-no-account')

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'ACCOUNT_UNAVAILABLE' } },
      content: [{
        type: 'text',
        text: 'Error: ACCOUNT_UNAVAILABLE: no account is bound to the current session; '
          + 'sign in before querying project members',
      }],
    })
  })

  it('answers ACCOUNT_UNAVAILABLE when the resolver declines with undefined', async () => {
    const ctx = await setup({
      currentAccountResolver: async () => undefined,
      boundProjectResolver: async () => projectId('proj-alpha'),
    })

    const result = await execute(ctx, 'pm-account-undefined')

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'ACCOUNT_UNAVAILABLE' } },
    })
  })

  it('answers ACCOUNT_UNAVAILABLE with the resolver failure chained as cause', async () => {
    const ctx = await setup({
      currentAccountResolver: async () => {
        throw new Error('protected storage locked')
      },
      boundProjectResolver: async () => projectId('proj-alpha'),
    })

    const result = await execute(ctx, 'pm-account-cause')

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'ACCOUNT_UNAVAILABLE' } },
    })
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryProjectMembership)
    const fiber = await ctx.plugin(toolProjectMembers, ACTOR_CONFIG)
    expect(ctx.tools.get('project_members')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('project_members')).toBeUndefined()
  })

  it('fails at load when an injected face is not callable', () => {
    const broken = { currentAccountResolver: 'nope' } as unknown as Config
    expect(() => {
      toolProjectMembers.apply(new Context(), broken)
    }).toThrow('tool-project-members: config.currentAccountResolver must be a resolver function')
  })

  it('fails closed when no roster provider is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolProjectMembers, {
      currentAccountResolver: resolveActorAccount,
    })
    const result = await execute(ctx, 'pm-no-provider', { projectId: 'proj-alpha' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/no project-membership roster provider is composed/)
  })

  it('reads the roster through an injected bridge without requiring ctx.projectMembership', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(toolProjectMembers, {
      currentAccountResolver: async ({ signal } = {}) => {
        expect(signal).toBe(testToolSignal)
        return account('acc-owner')
      },
      rosterResolver: async (actor, requestedProjectId, { signal } = {}) => {
        expect(actor).toBe('acc-owner')
        expect(requestedProjectId).toBe('proj-alpha')
        expect(signal).toBe(testToolSignal)
        return {
          project: PROJECT,
          members: [{
            id: 'mem-owner' as MembershipId,
            accountId: account('acc-owner'),
            role: 'owner',
            tags: ['founding'] as FunctionTag[],
            joinedAt: 1_000,
          }],
        }
      },
    })
    const result = await execute(ctx, 'pm-bridge', { projectId: 'proj-alpha' })
    expect(result.isError).toBe(false)
    expect(resultValue(result)).toEqual([
      { accountId: 'acc-owner', role: 'owner', tags: ['founding'], presence: 'offline', self: true },
    ])
    const withAgent = await execute(ctx, 'pm-bridge-agent', { projectId: 'proj-alpha' }, stubAgent('session-bridge'))
    expect(withAgent.isError).toBe(false)
  })

  it('cancels a pending current-account read through the tool signal', async () => {
    let started: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { started = resolve })
    const ctx = await setup({
      currentAccountResolver: async ({ signal } = {}) => {
        started?.()
        return new Promise((_resolve, reject) => {
          const rejectAbort = (): void => { reject(new Error(String(signal?.reason ?? 'aborted'))) }
          if (signal?.aborted === true) {
            rejectAbort()
            return
          }
          signal?.addEventListener('abort', rejectAbort, { once: true })
        })
      },
    })
    const controller = new AbortController()
    const executing = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('pm-account-cancelled'),
      name: 'project_members',
      arguments: { projectId: 'proj-alpha' },
    })
    await waiting
    controller.abort(new Error('account cancelled'))
    const result = await executing
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'ProjectMembersToolError', code: 'ACCOUNT_UNAVAILABLE' } },
    })
  })
})
