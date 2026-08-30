// @vitest-environment jsdom
// Details-panel document focus: the three-way render dispatch of the
// 'conversation.details.document' seat fallback (markdown / restricted html
// preview / bare file tab), the seat's owner currency, and the channel's
// write-and-clear behavior on the shared chat store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { DetailsDocumentFocus, DetailsDocumentOwnerProps, DetailsSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { zh } from '../src/client/locales.ts'

// Mirrors the real lookup chain (conversation namespace, then common).
const t = makeTranslate(zh, commonZh)

const SID = 's1' as SessionId

/** Minimal framework seat for direct DetailsPanel host tests. */
const SessionProviderStub: SessionProviderComponent = ({ children }) => children(SID)

/** Captures the document seat's owner currency instead of importing an occupant. */
function renderDocumentSeatProbe(owners?: DetailsDocumentOwnerProps[]): DetailsSlotProps['renderSlot'] {
  return (key, owner) => {
    if (key === 'conversation.details.document') owners?.push(owner as unknown as DetailsDocumentOwnerProps)
    return <div data-testid="document-details-seat" />
  }
}

/** Unoccupied seat: renders the owner-supplied fallback (the three-way dispatch). */
function renderUnoccupiedFallback(): DetailsSlotProps['renderSlot'] {
  return (_key, _owner, opts) => opts?.fallback ?? null
}

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** jsdom has no ResizeObserver; stubbed for parity with the other suites. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render the panel with one focused document and the given seat renderer. */
function renderFocused(
  document: DetailsDocumentFocus,
  renderSlot: DetailsSlotProps['renderSlot'] = renderUnoccupiedFallback(),
) {
  const snap = snapshotBase()
  const chat = createChatStore().create()
  chat.actions.focusDocument(document)
  const emptyList = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  const emptyWorkspaces = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return render(
    <DetailsPanel
      SessionProvider={SessionProviderStub}
      renderSlot={renderSlot}
      sessionId={SID}
      useSession={bindSnapshotSelector({ getSnapshot: () => snap, subscribe: () => () => {} })}
      useSessions={bindSnapshotSelector(emptyList)}
      useWorkspaces={bindSnapshotSelector(emptyWorkspaces)}
      useProjection={(() => undefined)}
      useInput={(() => { throw new Error('unused') })}
      inputActions={{} as DetailsSlotProps['inputActions']}
      useStore={bindSnapshotSelector(chat)}
      actions={chat.actions}
      closeDetails={vi.fn()}
      t={t}
    />,
  )
}

describe('details document focus', () => {
  it('renders a focused markdown document through the markdown renderer', () => {
    const view = renderFocused({
      path: 'docs/roster.md', filename: 'roster.md', from: '王小明',
      content: '# 成员名单\n\n张三 · 管理员',
    })
    expect(view.container.querySelector('h1')?.textContent).toBe('成员名单')
    expect(view.container.textContent).toContain('张三 · 管理员')
  })

  it('renders a focused html document as the sandboxed restricted preview', () => {
    const view = renderFocused({
      path: 'reports/brief.html', filename: 'brief.html', from: '王小明',
      content: '<html><body><p>决策简报</p></body></html>',
    })
    // Amber warning strip, verbatim.
    expect(view.container.textContent).toContain('受限预览 · 脚本与网络请求已禁用')
    const frame = view.container.querySelector('iframe')
    expect(frame).not.toBeNull()
    // Sandboxed without the script grant: relayed markup cannot execute or
    // reach the network through the frame.
    expect(frame?.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(frame?.getAttribute('srcdoc')).toContain('决策简报')
  })

  it('renders an unrenderable document as a bare file tab without a download affordance', () => {
    const view = renderFocused({
      path: 'reports/activity.csv', filename: 'activity.csv', from: '王小明',
    })
    expect(view.container.textContent).toContain('activity.csv')
    expect(view.container.textContent).toContain('来自 王小明')
    // Identity only: no download button, link, or inline body container.
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.container.querySelector('button[class*="download"]')).toBeNull()
    expect(view.container.querySelector('iframe')).toBeNull()
  })

  it('hands the focused document to the document seat as the owner currency', () => {
    const owners: DetailsDocumentOwnerProps[] = []
    const focus: DetailsDocumentFocus = { path: 'docs/plan.md', filename: 'plan.md', from: '李四' }
    const view = renderFocused(focus, renderDocumentSeatProbe(owners))
    expect(view.container.querySelector('[data-testid="document-details-seat"]')).not.toBeNull()
    expect(owners).toHaveLength(1)
    expect(owners[0]?.document).toBe(focus)
  })

  it('clears the focus when the panel closes and when a tool is selected', () => {
    const chat = createChatStore().create()
    chat.actions.focusDocument({ path: 'docs/plan.md', filename: 'plan.md', from: '李四' })
    expect(chat.getSnapshot().documentFocus).not.toBeNull()
    chat.actions.clearDocumentFocus()
    expect(chat.getSnapshot().documentFocus).toBeNull()
    chat.actions.focusDocument({ path: 'docs/plan.md', filename: 'plan.md', from: '李四' })
    // The two panel bodies are mutually exclusive: a tool selection replaces
    // any focused document.
    chat.actions.select({ turnSeq: 2, stepSeq: 1, callId: 'c1', toolName: 'read' })
    expect(chat.getSnapshot().documentFocus).toBeNull()
  })
})
