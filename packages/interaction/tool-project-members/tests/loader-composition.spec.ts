/**
 * Real-composition proof for `project_members`: the tool boots through the
 * actual Loader from a test cordis.yml whose `!!js` config carries the
 * resolver functions, and an in-memory membership provider serves the roster.
 * Asserts the model-visible result text and the stable no-account error path.
 * @module tests/loader-composition.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
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

type TestAccountId = Branded<'PlatformAccountId'>

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const PROJECT: ProjectView = {
  id: 'proj-loader' as ProjectId,
  name: 'loader',
  boundRemoteUrl: 'https://github.com/example/loader.git',
  createdAt: 1_000,
}

const MEMBERS: readonly MemberView[] = [
  {
    id: 'mem-0' as MembershipId,
    accountId: 'acc-owner' as TestAccountId,
    role: 'owner',
    tags: ['founding'] as FunctionTag[],
    joinedAt: 2_000,
  },
  {
    id: 'mem-1' as MembershipId,
    accountId: 'acc-member' as TestAccountId,
    role: 'member',
    tags: [] as FunctionTag[],
    joinedAt: 2_100,
  },
]

/** In-memory membership provider; non-read operations are unreachable here. */
class MemoryProjectMembership extends ProjectMembershipService {
  override async roster(actor: TestAccountId, id: ProjectId): Promise<RosterView> {
    if (id !== PROJECT.id) throw new ProjectMembershipError('PROJECT_NOT_FOUND', `project ${id} does not exist`)
    if (!MEMBERS.some(member => member.accountId === actor)) {
      throw new ProjectMembershipError('NOT_A_MEMBER', `account ${actor} holds no membership in project ${id}`)
    }
    return { project: PROJECT, members: MEMBERS }
  }

  override async createProject(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async invite(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async retractInvitation(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async acceptInvitation(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async declineInvitation(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async changeRole(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async setMemberTags(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async removeMember(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async pendingInvitationsFor(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async pendingInvitationContextsFor(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async pendingInvitationsIssuedBy(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async projectByRemote(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }

  override async rosterVersion(): Promise<never> {
    throw new Error('loader-composition tests never reach membership mutations')
  }
}

/** The provider module the test Loader serves for the in-memory membership row. */
const memoryModule = { default: MemoryProjectMembership }

/**
 * Boot a cordis.yml carrying the given tool config lines through the real Loader.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-project-members-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'test-memory-project-membership'",
    "- name: '@deepseek-ai/dsh-tool-project-members'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['test-memory-project-membership', memoryModule],
    ['@deepseek-ai/dsh-tool-project-members', toolProjectMembers],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-project-members real Loader composition through cordis.yml', () => {
  it('serves the workspace-bound roster end to end through !!js resolver config', async () => {
    const ctx = await boot([
      '    currentAccountResolver: !!js "async () => \'acc-owner\'"',
      '    boundProjectResolver: !!js "async () => \'proj-loader\'"',
    ])

    expect(ctx.tools.get('project_members')).toBeDefined()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('pm-loader'),
      name: 'project_members',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe(
      '[{"accountId":"acc-owner","role":"owner","tags":["founding"],"presence":"offline","self":true},'
      + '{"accountId":"acc-member","role":"member","tags":[],"presence":"offline","self":false}]',
    )
  }, 30_000)

  it('answers the stable ACCOUNT_UNAVAILABLE error when the composition injects no faces', async () => {
    const ctx = await boot([])

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('pm-loader-no-account'),
      name: 'project_members',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe('Error: ACCOUNT_UNAVAILABLE: no account is bound to the current session; '
      + 'sign in before querying project members')
  }, 30_000)

  it('fails loading when an injected face is not callable', async () => {
    await expect(boot(['    currentAccountResolver: "not-a-function"'])).rejects.toThrow(
      'tool-project-members: config.currentAccountResolver must be a resolver function',
    )
  }, 30_000)
})
