import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AgentOpenRegistry, registerOpenTool } from '../src/agent-opens.ts'
import type { Context } from '../src/context-types.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'

function exec(sessionId: string): ToolRunContext {
  return {
    signal: { throwIfAborted: () => {}, aborted: false },
    agent: { session: { id: sessionId } },
  } as unknown as ToolRunContext
}

function mount(options: {
  prefs?: Partial<SidebarPrefs>
  resolveCwd?: (sessionId: string) => string
} = {}): { definition: ToolDefinition; registry: AgentOpenRegistry } {
  let definition: ToolDefinition | undefined
  const ctx = {
    tools: {
      register: (tool: unknown): (() => void) => {
        definition = tool as ToolDefinition
        return () => {}
      },
    },
  } as unknown as Context
  const registry = new AgentOpenRegistry(() => {})
  const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, ...options.prefs }
  registerOpenTool(ctx, registry, options.resolveCwd ?? (() => '/cwd'), () => prefs)
  if (definition === undefined) throw new Error('sidebar_open was not registered')
  return { definition, registry }
}

describe('AgentOpenRegistry', () => {
  it('queues by Session and consumes the request when that Session attaches', () => {
    const registry = new AgentOpenRegistry(() => {})
    expect(registry.enqueue('session-a', 'file', '/work/a.txt', 'a.txt').delivered).toBe(false)

    const other: unknown[] = []
    const detachOther = registry.attach('session-b', request => { other.push(request) })
    expect(other).toEqual([])

    const own: unknown[] = []
    const detachOwn = registry.attach('session-a', request => { own.push(request) })
    expect(own).toEqual([
      expect.objectContaining({ sessionId: 'session-a', kind: 'file', target: '/work/a.txt', title: 'a.txt' }),
    ])

    const replayed: unknown[] = []
    const detachReplay = registry.attach('session-a', request => { replayed.push(request) })
    expect(replayed).toEqual([])
    detachOther()
    detachOwn()
    detachReplay()
  })

  it('detaches a failed sender while delivering to the other connected views', () => {
    const reportError = vi.fn()
    const registry = new AgentOpenRegistry(reportError)
    let failedCalls = 0
    registry.attach('session-a', () => {
      failedCalls += 1
      throw new Error('socket closed during send')
    })
    const delivered: unknown[] = []
    registry.attach('session-a', request => { delivered.push(request) })

    expect(registry.enqueue('session-a', 'file', '/work/a.txt', 'a.txt').delivered).toBe(true)
    expect(registry.enqueue('session-a', 'file', '/work/b.txt', 'b.txt').delivered).toBe(true)

    expect(failedCalls).toBe(1)
    expect(reportError).toHaveBeenCalledOnce()
    expect(delivered).toHaveLength(2)
  })

  it('retains a queued request when its attaching sender fails', () => {
    const reportError = vi.fn()
    const registry = new AgentOpenRegistry(reportError)
    registry.enqueue('session-a', 'file', '/work/a.txt', 'a.txt')

    expect(() => registry.attach('session-a', () => {
      throw new Error('socket closed during replay')
    })).not.toThrow()

    const delivered: unknown[] = []
    registry.attach('session-a', request => { delivered.push(request) })
    expect(delivered).toEqual([
      expect.objectContaining({ sessionId: 'session-a', target: '/work/a.txt' }),
    ])
    expect(reportError).toHaveBeenCalledOnce()
  })
})

describe('sidebar_open', () => {
  it('resolves a relative file for the calling Session and returns schema-valid delivery state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-open-'))
    try {
      const file = join(directory, 'note.md')
      writeFileSync(file, '# note')
      const { definition, registry } = mount({ resolveCwd: () => directory })
      const delivered: unknown[] = []
      const detach = registry.attach('session-a', request => { delivered.push(request) })

      const value = await definition.execute({ target: 'note.md' }, exec('session-a'))

      expect(value).toEqual({ kind: 'file', target: file, title: 'note.md', delivered: true })
      expect(validateJsonSchemaValue(definition.output.schema, value, 'value')).toEqual([])
      expect(delivered).toHaveLength(1)
      detach()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects disallowed URL schemes and disabled target tab types', async () => {
    const enabled = mount().definition
    await expect(enabled.execute({ target: 'file:///tmp/a.txt' }, exec('session-a')))
      .rejects.toThrow(/only accepts http/)

    const disabled = mount({ prefs: { tabsEnabled: { browser: false } } }).definition
    await expect(disabled.execute({ target: 'https://example.com/' }, exec('session-a')))
      .rejects.toThrow(/browser tab is disabled/)
  })
})
