import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PROMPT = 'Reply exactly MINIMAL_PRESET_REQUEST_OK and stop.'
const SHIPPED_MINIMAL_PRESET = fileURLToPath(new URL('../../cli/config/agent-presets/minimal', import.meta.url))

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void
  let presetRoot: string

  beforeAll(async () => {
    presetRoot = await mkdtemp(join(tmpdir(), 'dsh-allow-only-preset-'))
    const minimal = join(presetRoot, 'minimal')
    await cp(SHIPPED_MINIMAL_PRESET, minimal, { recursive: true })
    await appendFile(join(minimal, 'agent.cordis.yml'), `

- id: tool-eligibility
  name: '@deepseek-ai/dsh-agent-tool-eligibility'
  config:
    allow: []
`)
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      agentPresets: { roots: [{ path: presetRoot, trust: 'system' }], default: 'minimal' },
    })
    await scaffold.ctx.settings.replace(settingsNamespace('dsh-better-sidebar'), {
      agentOpenTools: true,
    })
    await scaffold.ctx.settings.replace(settingsNamespace('tool-eligibility'), {
      workspaces: {},
      sessions: { 'minimal-preset-smoke': ['bash', 'sidebar_open'] },
    })
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(presetRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends only eligible schemas, executes the allowed shell, and rejects a stale editor call', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    expect(agentHandle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')).toBe(false)
    const presetFileSystem = scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')
    expect(presetFileSystem).toBeDefined()
    expect(presetFileSystem?.sandboxMode).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeUndefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-bash-state-setup'),
      name: 'bash',
      arguments: { command: `cd ${JSON.stringify(stateDir)} && export DSH_MINIMAL_STATE=PERSISTED` },
      agent: agentHandle.agent,
    })
    const bash = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-bash-state-read'),
      name: 'bash',
      arguments: { command: 'printf \'%s:%s\n\' "$DSH_MINIMAL_STATE" "$PWD"' },
      agent: agentHandle.agent,
    })
    const editor = await scaffold.ctx.tools.execute({
      signal,
      callId: CallId('minimal-editor-smoke'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: join(scaffold.workspaceCwd, 'preset-smoke.txt') },
      agent: agentHandle.agent,
    })

    const text = (result: typeof bash): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()

    expect({
      prompt: requestHeader.system,
      tools: requestHeader.tools?.map(tool => tool.name),
      bash: text(bash),
      editor: text(editor),
    }).toMatchInlineSnapshot(`
      {
        "bash": "PERSISTED:{{cwd}}/persistent-state",
        "editor": "Error: unknown tool \"str_replace_editor\"",
        "prompt": "You are a helpful software engineer assistant.",
        "tools": [
          "bash",
          "sidebar_open",
          "tool_search",
        ],
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
