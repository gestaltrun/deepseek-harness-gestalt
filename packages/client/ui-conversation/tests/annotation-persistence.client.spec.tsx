// @vitest-environment jsdom
/** Annotation Draft persistence: store mirror/restore, last-writer tabs, stale anchors, rejection restoration. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createTextAnchor, TextAnnotationId } from '../src/client/annotation/model.ts'
import type { PersistedAnnotationDraft } from '../src/client/annotation/model.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locales.ts'
import { createChatStore } from '../src/client/stores.ts'
import type { SessionInputDeps } from '../src/client/input/facade.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { InputHub } from '../src/client/input/hub.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Compiler labels required by every shell construction (the hub always supplies them). */
const LABELS = {
  heading: (index: number) => `Annotation ${index}`,
  quote: (value: string) => `Quoted text: “${value}”`,
  note: (value: string) => `Note: ${value}`,
  image: (name: string, x: number, y: number) => `Image “${name}” at ${x.toFixed(1)}%, ${y.toFixed(1)}%`,
  overflow: 'Request exceeds context capacity',
}

function makeShell(deps: Partial<SessionInputDeps> = {}): SessionInputShell {
  return new SessionInputShell({
    actx: {} as Context,
    defaultSink: vi.fn(() => Promise.resolve({ kind: 'success' as const })),
    annotationLabels: LABELS,
    ...deps,
  })
}

describe('annotation draft persistence', () => {
  it('mirrors the live draft into the per-Session store and restores it after remount', () => {
    localStorage.clear()
    const store = createChatStore().create('sess-1')
    const shell = makeShell()
    shell.bindAnnotationMirror((value) => { store.actions.setAnnotationDraft(value) })
    expect(store.store.getSnapshot().annotationDraft).toBeNull()

    const anchor = createTextAnchor('message-1:0', 'Exact quotation', 'Exact quotation', 0)
    const first = shell.actions.addTextAnnotation(anchor, 'one')
    shell.actions.addTextAnnotation({ ...anchor, quote: 'Exact quotation' }, 'two')
    shell.actions.updateTextAnnotation(first, 'one revised')
    const persisted = store.store.getSnapshot().annotationDraft
    expect(persisted?.annotations.map(item => [item.id, item.note])).toEqual([
      [first, 'one revised'],
      [TextAnnotationId('annotation-2'), 'two'],
    ])
    expect(persisted?.nextSeq).toBe(3)

    // Remount: a fresh shell over the same persisted value adopts identities,
    // order, and the id sequence (no reuse of a live identity).
    const revived = makeShell()
    const rehydrated = JSON.parse(
      localStorage.getItem('dsh.conversation.chat.sess-1') ?? 'null',
    ) as { annotationDraft: PersistedAnnotationDraft | null } | null
    expect(rehydrated?.annotationDraft?.annotations).toEqual(persisted?.annotations)
    revived.restoreAnnotationDraft(rehydrated?.annotationDraft ?? { annotations: [], nextSeq: 1 })
    expect(revived.snapshot.annotations.map(item => item.note)).toEqual(['one revised', 'two'])
    const minted = revived.actions.addTextAnnotation(anchor, '')
    const restoredIds = revived.snapshot.annotations.map(item => item.id).slice(0, 2)
    expect(restoredIds).not.toContain(minted)
  })

  // Admission clearing rides the same publish→mirror path (empty draft ⇒
  // null); the assembled admission flow is owned by annotation-persistence.e2e.ts.
  it('clears the persisted draft when the last annotation is deleted', () => {
    localStorage.clear()
    const store = createChatStore().create('sess-2')
    const shell = makeShell()
    shell.bindAnnotationMirror((value) => { store.actions.setAnnotationDraft(value) })
    const anchor = createTextAnchor('message-1:0', 'Exact quotation', 'Exact quotation', 0)
    shell.actions.addTextAnnotation(anchor, 'note')
    expect(store.store.getSnapshot().annotationDraft).not.toBeNull()
    shell.actions.removeTextAnnotation(shell.snapshot.annotations[0]!.id)
    expect(store.store.getSnapshot().annotationDraft).toBeNull()
  })

  it('discards the complete draft in one action: annotations, persisted value, and every Draft Mark', () => {
    localStorage.clear()
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    const deleteMark = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: deleteMark } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const store = createChatStore().create('sess-discard')
    const shell = makeShell()
    shell.bindAnnotationMirror((value) => { store.actions.setAnnotationDraft(value) })
    const first = createTextAnchor('message-1:0', 'Alpha bold omega', 'Alpha', 0)
    const second = createTextAnchor('message-1:0', 'Alpha bold omega', 'omega', 11)
    shell.actions.addTextAnnotation(first, 'one')
    shell.actions.addTextAnnotation(second, 'two')
    expect(store.store.getSnapshot().annotationDraft?.annotations).toHaveLength(2)

    const props = {
      blocks: [{ kind: 'text' as const, text: 'Alpha **bold** omega' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: { addTextAnnotation: () => TextAnnotationId('unused') },
    }
    const view = render(
      <AssistantMarkdown
        {...props}
        annotations={shell.snapshot.annotations}
      />,
    )
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges).toHaveLength(2)

    shell.actions.discardTextAnnotations()
    expect(shell.snapshot.annotations).toEqual([])
    expect(store.store.getSnapshot().annotationDraft).toBeNull()
    view.rerender(
      <AssistantMarkdown
        {...props}
        annotations={shell.snapshot.annotations}
      />,
    )
    expect(deleteMark).toHaveBeenLastCalledWith('annotation-draft-mark')
  })

  it('ignores a malformed persisted value instead of adopting garbage', () => {
    const shell = makeShell()
    shell.restoreAnnotationDraft({ annotations: [{ id: TextAnnotationId('x'), kind: 'text' }], nextSeq: 2 } as unknown as PersistedAnnotationDraft)
    expect(shell.snapshot.annotations).toEqual([])
    const anchor = createTextAnchor('message-1:0', 'Exact quotation', 'Exact quotation', 0)
    expect(shell.actions.addTextAnnotation(anchor, '').length).toBeGreaterThan(0)
  })

  it('keeps independent same-key instances unsynchronized with deterministic last-writer-wins', () => {
    localStorage.clear()
    const handle = createChatStore()
    const tabA = handle.create('sess-lww')
    const tabB = handle.create('sess-lww')
    const anchor = createTextAnchor('message-1:0', 'Exact quotation', 'Exact quotation', 0)
    const annotation = { id: TextAnnotationId('annotation-1'), kind: 'text' as const, anchor, note: 'a' }
    const other = { id: TextAnnotationId('annotation-1'), kind: 'text' as const, anchor, note: 'b' }

    tabA.actions.setAnnotationDraft({ annotations: [annotation], nextSeq: 2 })
    // No live synchronization: tabB keeps its resident state while tabA writes.
    expect(tabB.store.getSnapshot().annotationDraft).toBeNull()
    // The later write from tabB owns the shared storage entry (last writer wins).
    tabB.actions.setAnnotationDraft({ annotations: [other], nextSeq: 2 })
    expect(tabA.store.getSnapshot().annotationDraft?.annotations[0]?.note).toBe('a')
    const stored = JSON.parse(localStorage.getItem('dsh.conversation.chat.sess-lww') ?? 'null') as {
      annotationDraft: PersistedAnnotationDraft | null
    }
    expect(stored.annotationDraft?.annotations[0]?.note).toBe('b')
    // A fresh instance (a tab opened last) rehydrates exactly that value.
    expect(handle.create('sess-lww').store.getSnapshot().annotationDraft?.annotations[0]?.note).toBe('b')
  })

  it('surfaces a stale anchor as a visible error while preserving the rest of the draft', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const stale = createTextAnchor('message-1:0', 'Text that no longer exists here', 'no longer exists', 10)
    const live = createTextAnchor('message-1:0', 'Alpha bold omega', 'bold', 6)

    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'Alpha **bold** omega' }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[
          { id: TextAnnotationId('annotation-stale'), kind: 'text', anchor: stale, note: 'stale note' },
          { id: TextAnnotationId('annotation-live'), kind: 'text', anchor: live, note: '' },
        ]}
        annotationActions={{ addTextAnnotation: () => TextAnnotationId('unused') }}
      />,
    )

    expect(view.getByRole('alert').textContent).toContain('无法在原文中定位')
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['bold'])
  })

  it('rejects without overwriting newer input: exact snapshot back, draft edits during flight refused', async () => {
    const sendSession = vi.fn(async () => ({ kind: 'error' as const }))
    const rootCtx = {
      get: (name: string): unknown =>
        name === 'conversation'
          ? { sendSession, releaseDraftImage: vi.fn() }
          : undefined,
    }
    const hub = new InputHub(rootCtx as never, makeTranslate(zh, commonZh))
    const sessionFace = {
      sessionId: 'sess-reject',
      getSnapshot: () => ({ queue: [] }),
      subscribe: () => () => {},
    }
    const shell = hub.shellFor({
      sessionId: 'sess-reject',
      session: sessionFace,
      ctx: { effect: (): (() => void) => () => {} },
    } as never)
    shell.setDraft('Please revise this.')
    const anchor = createTextAnchor('message-1:0', 'Exact quotation', 'Exact quotation', 0)
    shell.actions.addTextAnnotation(anchor, 'Original note')

    const compiled = 'Please revise this.\n\n注释 1\n引用：“Exact quotation”\n批示：Original note'
    shell.submit('queue')
    expect(sendSession).toHaveBeenCalledWith(
      expect.objectContaining({}),
      compiled,
      [],
      'queue',
      expect.any(AbortSignal),
      [],
    )
    // Newer text typed during the attempt must not enter the snapshot.
    shell.setDraft('A later edit must not win.')
    expect(shell.snapshot.draft).toBe('Please revise this.')

    await vi.waitFor(() => { expect(shell.snapshot.annotationSubmitting).toBe(false) })
    expect(shell.snapshot.draft).toBe('Please revise this.')
    expect(shell.snapshot.annotations).toEqual([
      { id: TextAnnotationId('annotation-1'), kind: 'text', anchor, note: 'Original note' },
    ])
  })
})
