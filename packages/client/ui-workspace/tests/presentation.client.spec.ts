import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { expandedSessionGroups, workspacePresentationTranslate } from '../src/presentation.tsx'

describe('public Workspace presentation seam', () => {
  it('binds English labels and preserves unresolved owner parameters', () => {
    const t = workspacePresentationTranslate('en')
    expect(t('group.ungrouped')).toBe('Ungrouped')
    expect(t('sessions.expand', { n: 3 })).toBe('Show 3 more sessions')
    expect(t('sessions.expand', {})).toBe('Show {n} more sessions')
  })

  it('binds Chinese and unknown labels with resolved template parameters', () => {
    const t = workspacePresentationTranslate('zh')
    expect(t('group.ungrouped')).toBe('未分组')
    expect(t('sessions.expand', { n: 2 })).toBe('展开其余 2 个会话')
    expect(Reflect.apply(t, undefined, ['extension.unknown'])).toBe('extension.unknown')
  })

  it('derives fully expanded groups through the Desktop grouping owner', () => {
    const sessionId = 'presentation-session' as SessionId
    const workspaceId = 'presentation-workspace' as WorkspaceId
    const sessions: SessionListState = {
      ids: [sessionId],
      byId: {
        [sessionId]: {
          id: sessionId, displayTitle: 'Presentation Session', running: false, blank: false, updatedAt: 1,
        },
      },
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    const workspaces: readonly WorkspaceView[] = [{
      workspaceId,
      path: '/work',
      title: 'Work',
      sessionIds: [sessionId],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }]

    expect(expandedSessionGroups(sessions, workspaces)).toEqual([
      expect.objectContaining({ key: workspaceId, expanded: true, sessions: [expect.objectContaining({ id: sessionId })] }),
    ])
  })
})
