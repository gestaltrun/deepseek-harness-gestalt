import { describe, expect, it, vi } from 'vitest'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import { parseCompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'
import {
  DesktopCompanionLiveProjectionSource,
} from '../src/companion-live-projection.ts'
import { projectDesktopCompanionLiveSession } from '../src/companion-product.ts'
import type { DesktopHostRpc } from '../src/host-rpc.ts'

describe('Desktop Companion live projection', () => {
  it('projects full detail only for the opened Session and bounded summaries for every pairing', () => {
    const source = new DesktopCompanionLiveProjectionSource()
    const first = parsePersonalPairingId('pairing-first')
    const second = parsePersonalPairingId('pairing-second')
    const opened = parseCompanionSessionId('session-opened')
    const hidden = parseCompanionSessionId('session-hidden')
    const firstChanges: unknown[] = []
    const secondChanges: unknown[] = []
    source.connect(first, (change) => { firstChanges.push(change) }, () => {})
    source.connect(second, (change) => { secondChanges.push(change) }, () => {})
    source.observe(first, opened)
    firstChanges.splice(0)
    secondChanges.splice(0)

    source.changed(opened)
    source.changed(hidden)

    expect(firstChanges).toEqual([
      { type: 'session', sessionId: opened, includeConversation: true, observationEpoch: 1 },
      { type: 'session', sessionId: hidden, includeConversation: false, observationEpoch: 1 },
    ])
    expect(secondChanges).toEqual([
      { type: 'session', sessionId: opened, includeConversation: false, observationEpoch: 0 },
      { type: 'session', sessionId: hidden, includeConversation: false, observationEpoch: 0 },
    ])
  })

  it('clears observation on disconnect and forces every live channel to reconnect after Host stream loss', () => {
    const source = new DesktopCompanionLiveProjectionSource()
    const pairingId = parsePersonalPairingId('pairing-lifecycle')
    const sessionId = parseCompanionSessionId('session-lifecycle')
    const changed = vi.fn()
    const disconnect = vi.fn()
    const dispose = source.connect(pairingId, changed, disconnect)
    source.observe(pairingId, sessionId)
    changed.mockClear()
    source.fail(new Error('Host stream lost'))

    expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({ message: 'Host stream lost' }))
    dispose()
    source.changed(sessionId)
    expect(changed).not.toHaveBeenCalled()
    expect(source.observedSession(pairingId)).toBeUndefined()
  })

  it('invalidates detailed work when the pairing switches or closes its observed Session', () => {
    const source = new DesktopCompanionLiveProjectionSource()
    const pairingId = parsePersonalPairingId('pairing-observation-epoch')
    const first = parseCompanionSessionId('session-first')
    const second = parseCompanionSessionId('session-second')
    const changes: import('../src/companion-live-projection.ts').DesktopCompanionLiveProjectionChange[] = []
    source.connect(pairingId, (change) => { changes.push(change) }, () => {})
    source.observe(pairingId, first)
    const detailed = changes.at(-1)
    if (detailed === undefined) throw new Error('expected detailed observation change')
    expect(source.retainsConversation(pairingId, detailed)).toBe(true)

    source.observe(pairingId, second)
    expect(source.retainsConversation(pairingId, detailed)).toBe(false)
    const switched = changes.at(-1)
    if (switched === undefined) throw new Error('expected switched observation change')
    expect(source.retainsConversation(pairingId, switched)).toBe(true)

    source.observe(pairingId)
    expect(source.retainsConversation(pairingId, switched)).toBe(false)
  })

  it('requests one authoritative surface baseline for every authenticated connection', () => {
    const source = new DesktopCompanionLiveProjectionSource()
    const changes: unknown[] = []
    source.connect(parsePersonalPairingId('pairing-surface-first'), (change) => { changes.push(change) }, () => {})
    source.connect(parsePersonalPairingId('pairing-surface-second'), (change) => { changes.push(change) }, () => {})

    source.surfaceChanged()

    expect(changes).toEqual([{ type: 'surface' }, { type: 'surface' }])
  })

  it('projects an opened streaming tail while hidden Sessions avoid history bytes', async () => {
    const opened = parseCompanionSessionId('session-opened')
    const calls: string[] = []
    let archivedSessionIds: string[] = []
    const host: DesktopHostRpc = {
      call: vi.fn(async (method: string) => {
        calls.push(method)
        if (method === 'session.list') return { ok: true, value: { items: [
          { sessionId: 'session-hidden', updatedAt: 10, running: true, blank: false },
          { sessionId: opened, updatedAt: 20, running: true, blank: false },
        ] } }
        if (method === 'workspace.list') return { ok: true, value: { items: [{
          workspaceId: 'workspace-live', path: '/work', title: 'Work',
          sessionIds: [opened], createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        }], archivedSessionIds } }
        if (method === 'session.history') return { ok: true, value: { events: [
          { event: { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } } },
          { event: { type: 'assistant/chunk', seq: 1, time: 2, data: {
            turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
          } } },
          { event: { type: 'assistant/chunk', seq: 2, time: 3, data: {
            turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'live output' },
          } } },
        ], hasMore: false } }
        throw new Error(`unexpected Host method ${method}`)
      }),
    }
    const hidden = await projectDesktopCompanionLiveSession(
      parseCompanionSessionId('session-hidden'), false, liveDependencies(host), new AbortController().signal,
    )
    expect(hidden).toMatchObject({
      sessionId: 'session-hidden', position: 0,
      summary: { running: true }, workspaces: [],
    })
    expect(hidden).not.toHaveProperty('conversation')
    expect(calls).toEqual(['session.list', 'workspace.list'])

    calls.splice(0)
    archivedSessionIds = ['session-hidden']
    const detailed = await projectDesktopCompanionLiveSession(
      opened, true, liveDependencies(host), new AbortController().signal,
    )
    expect(detailed).toMatchObject({
      sessionId: opened,
      position: 0,
      conversation: {
        sessionId: opened,
        partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'live output' }] },
      },
    })
    expect(calls).toEqual(['session.list', 'workspace.list', 'session.history'])

    calls.splice(0)
    archivedSessionIds = [opened]
    await expect(projectDesktopCompanionLiveSession(
      opened, true, liveDependencies(host), new AbortController().signal,
    )).resolves.toEqual({ sessionId: opened, removed: true })
  })
})

function liveDependencies(host: DesktopHostRpc) {
  return {
    host,
    pendingInteractions: () => [],
  }
}
