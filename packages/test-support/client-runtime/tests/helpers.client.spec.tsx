// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CHAT_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-chat/client'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindSnapshotSelector,
  chatSnapshot,
  conversationSnapshot,
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from '../src/index.ts'

const originalLanguages = [...navigator.languages]
const originalLanguage = navigator.language

usePinnedBrowserLanguages('zh-CN', 'en-US')
afterEach(cleanup)
afterAll(() => {
  expect(navigator.languages).toEqual(originalLanguages)
  expect(navigator.language).toBe(originalLanguage)
})

function entry(seq: number): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      type: 'fixture/event',
      seq,
      time: seq,
      data: { seq },
      ignorable: true,
    } as SessionLiveEventEntry['event'],
  }
}

describe('fixture helpers', () => {
  it('builds independent Conversation and Chat snapshots with optional overrides', () => {
    const conversation = conversationSnapshot()
    expect(conversation).toEqual(EMPTY_CONVERSATION_SNAPSHOT)
    expect(conversation).not.toBe(EMPTY_CONVERSATION_SNAPSHOT)
    const activeTargets = new Set(['chat'])
    expect(conversationSnapshot({ activeTargets }).activeTargets).toBe(activeTargets)

    const chat = chatSnapshot()
    expect(chat).toEqual(EMPTY_CHAT_SNAPSHOT)
    expect(chat).not.toBe(EMPTY_CHAT_SNAPSHOT)
    const order = ['node-1']
    expect(chatSnapshot({ order }).order).toBe(order)
  })

  it('binds an observable snapshot through the production selector hook', () => {
    const source = createSnapshotStore({ value: 1 })
    const useValue = bindSnapshotSelector(source)
    const view = renderHook(() => useValue(snapshot => snapshot.value))
    expect(view.result.current).toBe(1)

    act(() => { source.update((draft) => { draft.value = 2 }) })
    expect(view.result.current).toBe(2)
  })

  it('pins both browser language fields for the calling suite', () => {
    expect(navigator.languages).toEqual(['zh-CN', 'en-US'])
    expect(navigator.language).toBe('zh-CN')
  })
})

describe('Session fixture lifecycle', () => {
  it('initializes and drives complete event windows through replace, prepend, and append', async () => {
    const runtime = await SlotTestRuntime.create()
    const first = entry(1)
    const older = entry(0)
    const live = entry(2)

    await runtime.sessions.add({ id: 'events', events: [first] }, { current: false })
    expect(runtime.sessions.behavior('events').eventSource.getSnapshot()).toMatchObject({
      entries: [first],
      hasMore: false,
      change: { kind: 'replace', entries: [first] },
    })

    await runtime.sessions.add({ id: 'has-more', hasMore: true }, { current: false })
    expect(runtime.sessions.behavior('has-more').eventSource.getSnapshot()).toMatchObject({
      entries: [],
      hasMore: true,
    })

    await runtime.sessions.replaceEvents('events', [first])
    await runtime.sessions.prependEvents('events', [older])
    await runtime.sessions.appendEvent('events', live)
    expect(runtime.sessions.behavior('events').eventSource.getSnapshot()).toMatchObject({
      entries: [older, first, live],
      hasMore: false,
      change: { kind: 'append', entries: [live] },
    })
    await runtime.dispose()
  })

  it('requires an explicit create stub and records successful create and refresh calls', async () => {
    const runtime = await SlotTestRuntime.create()
    await expect(runtime.sessions.create()).rejects.toThrow(/create is not stubbed/)
    await runtime.sessions.add({ id: 'created' }, { current: false })
    const create = vi.fn(() => Promise.resolve('created' as SessionId))
    runtime.sessions.stubCreate(create)

    await expect(runtime.sessions.create({ cwd: '/workspace' })).resolves.toBe('created')
    await expect(runtime.sessions.refresh()).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(runtime.sessions.calls.slice(-2)).toEqual([
      { method: 'create', args: [{ cwd: '/workspace' }] },
      { method: 'refresh', args: [] },
    ])
    await runtime.dispose()
  })

  it('stages a provisional identity with a resolvable stable binding and releases it', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'parent' }, { current: true })
    const current = runtime.sessions.list.getSnapshot().current
    const release = runtime.sessions.stageProvisional({
      sessionId: 'draft' as SessionId,
      parentSessionId: 'parent' as SessionId,
      origin: 'subagent',
      title: 'Side: New thread',
    })
    const binding = runtime.sessions.binding('draft')
    expect(binding?.sessionId).toBe('draft')
    expect(runtime.sessions.scope('draft')).toBe(binding?.ctx)
    expect(runtime.sessions.sessionOf(binding!.ctx)).toBe(binding?.session)
    expect(runtime.sessions.binding('draft')).toBe(binding)
    expect(runtime.sessions.list.getSnapshot().current).toBe(current)
    expect(runtime.sessions.list.getSnapshot().byId['draft' as SessionId]).toMatchObject({
      displayTitle: 'Side: New thread', blank: true, provisional: true,
    })
    release()
    expect(runtime.sessions.binding('draft')).toBeUndefined()
    expect(runtime.sessions.scope('draft')).toBeUndefined()
    expect(runtime.sessions.list.getSnapshot().byId['draft' as SessionId]).toBeUndefined()
    await runtime.dispose()
  })

  it('does not let a provisional disposer remove a published fixture identity', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'parent' }, { current: false })
    const release = runtime.sessions.stageProvisional({
      sessionId: 'draft' as SessionId,
      parentSessionId: 'parent' as SessionId,
      origin: 'subagent',
      title: 'Side: New thread',
    })
    const binding = runtime.sessions.binding('draft')
    await runtime.sessions.updateSummary('draft', { blank: false, provisional: undefined })
    release()
    expect(runtime.sessions.binding('draft')).toBe(binding)
    expect(runtime.sessions.list.getSnapshot().byId['draft' as SessionId]?.provisional).toBeUndefined()
    expect(runtime.sessions.list.getSnapshot().byId['draft' as SessionId]?.blank).toBe(false)
    await runtime.dispose()
  })

  it('disposes a scope without materializing a binding', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'scope-only' }, { current: false })
    const scope = runtime.sessions.scope('scope-only')
    expect(scope).toBeDefined()
    const release = vi.fn()
    scope?.effect(() => release, 'fixture scope release')

    runtime.releaseWorkspaceSource()
    await runtime.dispose()
    expect(release).toHaveBeenCalledOnce()
  })
})
