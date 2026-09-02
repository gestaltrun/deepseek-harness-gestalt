/**
 * Real-composition proof that a Cloud-Project-bound Desktop session can
 * construct a routed ask after live-roster public-login matching. The Loader
 * boots the Web Host sender (no production delivery port), the Desktop
 * membership bridge, and the standard-preset routeResolver. The model-visible
 * addressee is the public GitHub login, never an injected Account id.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import CompanionMemberQuestionSender from '@deepseek-ai/dsh-member-question-sender'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import DesktopProjectMembership from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function stubAgent(cwd: string): Agent {
  return {
    id: 'session-atlas',
    session: { id: 'session-atlas', header: { cwd } },
  } as unknown as Agent
}

describe('bound Desktop routed-ask Loader composition', () => {
  it('constructs a routed ask from a public GitHub login without injecting an Account id', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-routed-ask-loader-'))
    const tokenFile = join(root, 'token')
    await writeFile(tokenFile, 'secret\n')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-user-questions'",
      "- name: '@deepseek-ai/dsh-member-question-sender'",
      "- name: '@deepseek-ai/dsh-project-membership-desktop'",
      '  config:',
      "    baseUrl: 'http://127.0.0.1:4321'",
      `    tokenFile: ${JSON.stringify(tokenFile)}`,
      "- name: '@deepseek-ai/dsh-tool-ask-user'",
      '  config:',
      "    routeResolver: !!js \"async ({ agent, toProjectMember, signal } = {}) => { const membership = ctx.get('desktopProjectMembership'); if (membership == null) throw new Error('Desktop Project Membership is unavailable'); return await membership.questionRoute(agent, toProjectMember, 'Desktop session', signal) }\"",
      "    boundProjectResolver: !!js \"async ({ agent, signal } = {}) => (await ctx.get('desktopProjectMembership')?.context(agent, signal))?.project?.id\"",
      '',
    ].join('\n'))

    const fetch = vi.fn(async (input: string | URL | Request) => {
      const href = input instanceof Request ? input.url : String(input)
      if (href.endsWith('/v1/context') || href.endsWith('/v1/account')) {
        return Response.json({
          account: { id: 'account-a', githubLogin: 'ada', avatarUrl: 'https://avatars.example/ada.png' },
          project: { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1 },
        })
      }
      return Response.json({
        project: { id: 'project-atlas', name: 'Atlas', boundRemoteUrl: 'https://github.com/o/atlas', createdAt: 1 },
        members: [{
          id: 'membership-b', accountId: 'account-b', role: 'member', tags: ['release'], joinedAt: 1,
          presence: 'online', displayName: 'Grace', avatarRef: 'https://avatars.example/grace.png',
        }, {
          id: 'membership-a', accountId: 'account-a', role: 'owner', tags: [], joinedAt: 1,
          presence: 'online', displayName: 'Ada', avatarRef: 'https://avatars.example/ada.png',
        }],
      })
    })
    vi.stubGlobal('fetch', fetch)

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-user-questions', UserQuestionService],
      ['@deepseek-ai/dsh-member-question-sender', CompanionMemberQuestionSender],
      ['@deepseek-ai/dsh-project-membership-desktop', DesktopProjectMembership],
      ['@deepseek-ai/dsh-tool-ask-user', toolAskUser],
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

    expect(ctx.get('memberQuestionSender')).toBeDefined()
    const agent = stubAgent('/workspace/atlas')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('ask-bound-desktop'),
      name: 'ask_user_question',
      arguments: {
        questions: [{ id: 'rollout', question: 'Ship it?' }],
        to_project_member: 'GRACE',
        background: 'Need a rollback window before Friday.',
      },
      agent,
    })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'MemberQuestionSenderError', code: 'DELIVERY_UNAVAILABLE' } },
    })
    expect(JSON.stringify(result)).not.toMatch(/SENDER_UNAVAILABLE/)
    expect(JSON.stringify(result)).not.toMatch(/account-b/)
    const rosterBodies = fetch.mock.calls
      .map(([input, init]) => {
        const href = input instanceof Request ? input.url : String(input)
        return href.endsWith('/v1/roster') ? String(init && typeof init === 'object' && 'body' in init ? init.body : '') : undefined
      })
      .filter((body): body is string => body !== undefined)
    expect(rosterBodies.some(body => body.includes('account-a'))).toBe(true)
    expect(rosterBodies.every(body => !body.includes('GRACE') && !body.includes('account-b'))).toBe(true)
  }, 30_000)
})
