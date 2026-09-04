/** Production JSONL restart evidence through the real Agent resume lifecycle. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ScheduleService from '../src/index.ts'
import {
  ScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
} from '../src/domain.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Reminder acknowledged.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of response) yield chunk
  }
}

async function mountPersistence(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function mountRuntime(root: string, adapter: RecordingAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(ScheduleService)
  return ctx
}

async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

function waitForDispatch(ctx: Context, sessionId: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const stop = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId
        || event.type !== 'schedule/change'
        || event.data.operation !== 'dispatch') return
      stop()
      resolve()
    })
  })
}

async function settleCurrentTasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** Read one stored session's header and full event log through a read handle. */
async function readStored(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: await handle.read() }
  } finally {
    await handle.close()
  }
}

describe('Schedule production JSONL restart', () => {
  it('pauses a cold overdue reminder without activation and preserves it across a Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-jsonl-cold-pause-'))
    roots.push(root)
    const sessionId = SessionId('schedule-jsonl-cold-pause')
    const first = await mountPersistence(root)
    const pending = first.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    pending.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: createAfterScheduleRecord(
        ScheduleId('schedule-1'), 'cold paused reminder', 1, Date.now() - 60_000,
      ),
    })
    await expect(first.sessions.flush(pending)).resolves.toBe(true)
    await disposeContext(first)

    const pausingAdapter = new RecordingAdapter()
    const pausing = await mountRuntime(root, pausingAdapter)
    const created: SessionId[] = []
    const sessionCreated: SessionId[] = []
    const sessionDisposed: SessionId[] = []
    pausing.on('agent/created', ({ agent }) => { created.push(agent.id) })
    pausing.on('session/created', (session) => { sessionCreated.push(session.id) })
    pausing.on('session/disposed', (session) => { sessionDisposed.push(session.id) })
    await expect(pausing.schedules.pause(sessionId, ScheduleId('schedule-1')))
      .resolves.toMatchObject({ id: 'schedule-1', state: 'paused' })
    expect(created).toEqual([])
    expect(sessionCreated).toEqual([])
    expect(sessionDisposed).toEqual([])
    expect(pausing.sessions.get(sessionId)).toBeUndefined()
    expect(pausingAdapter.requests).toEqual([])
    const pausedStored = await pausing.sessionPersistence.inspect(sessionId)
    expect(foldScheduleEvents(pausedStored.events, pausedStored.meta.seedLength ?? 0).paused)
      .toEqual([expect.objectContaining({ id: 'schedule-1' })])
    await disposeContext(pausing)

    const resumedAdapter = new RecordingAdapter()
    const restarted = await mountRuntime(root, resumedAdapter)
    const handle = await restarted.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await handle.agent.whenIdle()
    await settleCurrentTasks()
    expect(resumedAdapter.requests).toEqual([])
    expect(handle.agent.session.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toEqual([])

    const dispatched = waitForDispatch(restarted, sessionId)
    await expect(restarted.schedules.resume(sessionId, ScheduleId('schedule-1')))
      .resolves.toMatchObject({ id: 'schedule-1', state: 'overdue' })
    await dispatched
    await handle.agent.whenIdle()
    expect(resumedAdapter.requests).toHaveLength(1)
    expect(handle.agent.session.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    await handle.dispose()
    await disposeContext(restarted)
  })

  it('resumes one overdue reminder exactly once across fresh runtime mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-jsonl-'))
    roots.push(root)
    const sessionId = SessionId('schedule-jsonl-restart')
    const first = await mountPersistence(root)

    const pending = first.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    const pendingRecord = createAfterScheduleRecord(
      ScheduleId('schedule-1'), 'restart reminder', 1, Date.now() - 60_000,
    )
    pending.append('schedule/change', { version: 1, operation: 'create', schedule: pendingRecord })
    const seed = await first.sessionPersistence.create(pending.header)
    await seed.append(pending.snapshotEvents())
    await seed.close()
    await disposeContext(first)

    const dispatchingAdapter = new RecordingAdapter()
    const restarted = await mountRuntime(root, dispatchingAdapter)
    const dispatched = waitForDispatch(restarted, sessionId)
    const handle = await restarted.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await dispatched
    await handle.agent.whenIdle()
    await expect(restarted.sessions.flush(handle.agent.session)).resolves.toBe(true)
    const dispatchedStored = await readStored(restarted, sessionId)
    expect(foldScheduleEvents(dispatchedStored.events, dispatchedStored.inheritedEventCount).active)
      .toEqual([])
    const dispatches = dispatchedStored.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')
    expect(dispatches).toHaveLength(1)
    expect(dispatchingAdapter.requests).toHaveLength(1)
    await handle.dispose()
    await disposeContext(restarted)

    const replayAdapter = new RecordingAdapter()
    const replayed = await mountRuntime(root, replayAdapter)
    const replayHandle = await replayed.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await replayed.sessions.flush(replayHandle.agent.session)
    await replayHandle.agent.whenIdle()
    await settleCurrentTasks()
    await replayed.sessions.flush(replayHandle.agent.session)

    expect(replayAdapter.requests).toEqual([])
    expect(replayHandle.agent.session.snapshotEvents().filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    const replayedStored = await readStored(replayed, sessionId)
    expect(replayedStored.events.filter(event =>
      event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    await replayHandle.dispose()
    await disposeContext(replayed)
  })
})
