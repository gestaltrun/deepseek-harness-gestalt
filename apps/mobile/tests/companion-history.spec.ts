// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANION_HISTORY_PAGE_SIZE,
  createCompanionSession,
  groupCompanionSessions,
  pageCompanionHistory,
  projectMobileCompanionHistory,
  type CompanionSessionSummary,
} from '../src/companion-history.ts'
import { MobileBrowse } from '../src/MobileBrowse.tsx'

afterEach(() => { cleanup() })

const history: readonly CompanionSessionSummary[] = [
  { id: 's1', title: 'Alpha', workspace: 'Work', summary: 'alpha summary', live: true, transcript: ['hello'] },
  { id: 's2', title: 'Beta', project: 'Tools', summary: 'beta summary' },
  { id: 's3', title: 'Gamma', summary: 'ungrouped summary' },
]

describe('Mobile Companion browse projection', () => {
  it('groups Workspace and project rows and leaves unlabeled Sessions in Ungrouped', () => {
    expect(groupCompanionSessions(history)).toEqual({
      groups: [
        { name: 'Work', sessions: [history[0]] },
        { name: 'Tools', sessions: [history[1]] },
      ],
      ungrouped: [history[2]],
    })
  })

  it('pages history at the phone ceiling and reports spill', () => {
    const many = Array.from({ length: COMPANION_HISTORY_PAGE_SIZE + 3 }, (_, index) => ({
      id: `id-${String(index)}`,
      title: `T${String(index)}`,
      summary: 'row',
    }))
    expect(pageCompanionHistory(many, 0).visible).toHaveLength(COMPANION_HISTORY_PAGE_SIZE)
    expect(pageCompanionHistory(many, 0).spilled).toBe(3)
    expect(pageCompanionHistory(many, 1).visible).toHaveLength(3)
    expect(pageCompanionHistory(many, 1).spilled).toBe(0)
  })

  it('projects Mobile history identically to Desktop-confirmed history', () => {
    expect(projectMobileCompanionHistory(history)).toEqual(history)
  })

  it('shows the selected Desktop, connection state, and opens a live transcript full-screen', () => {
    render(createElement(MobileBrowse, { desktopName: 'Studio Mac', connection: 'online', sessions: history }))
    expect(screen.getByText('Studio Mac')).toBeTruthy()
    expect(screen.getByText('Remote Online')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByText('Ungrouped')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(screen.getByText('hello')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(screen.getByRole('button', { name: /Gamma/ }))
    expect(screen.getByText('ungrouped summary')).toBeTruthy()
  })

  it('creates a Workspace Session or Ungrouped Session and ignores a repeated operation id', () => {
    const committed = new Set<string>()
    const workspace = createCompanionSession(history, committed, {
      operationId: 'op-work',
      title: 'New Work',
      workspace: 'Work',
      devicePrincipalId: 'device-1',
    })
    committed.add('op-work')
    expect(workspace.created).toBe(true)
    expect(groupCompanionSessions(workspace.sessions).groups[0]?.sessions.map(session => session.title))
      .toContain('New Work')
    const replay = createCompanionSession(workspace.sessions, committed, {
      operationId: 'op-work',
      title: 'Duplicate',
      workspace: 'Work',
      devicePrincipalId: 'device-1',
    })
    expect(replay.created).toBe(false)
    expect(replay.sessions).toHaveLength(workspace.sessions.length)
    const ungrouped = createCompanionSession(workspace.sessions, committed, {
      operationId: 'op-ungrouped',
      title: 'Loose',
      devicePrincipalId: 'device-1',
    })
    expect(ungrouped.sessions.at(-1)).toMatchObject({ title: 'Loose' })
    expect(ungrouped.sessions.at(-1)?.workspace).toBeUndefined()
  })

  it('exposes Workspace-targeted and global Ungrouped create actions without a voice control', () => {
    const created: Array<{ workspace?: string }> = []
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac',
      connection: 'online',
      sessions: history,
      onCreate: (input) => { created.push(input) },
    }))
    fireEvent.click(screen.getByRole('button', { name: '在 Work 新建 Session' }))
    fireEvent.click(screen.getByRole('button', { name: '新建 Ungrouped Session' }))
    fireEvent.change(screen.getByLabelText('Workspace 名称'), { target: { value: 'Docs' } })
    fireEvent.click(screen.getByRole('button', { name: '在新 Workspace 新建 Session' }))
    expect(created).toEqual([{ workspace: 'Work' }, {}, { workspace: 'Docs' }])
    expect(screen.queryByRole('button', { name: /voice|语音/i })).toBeNull()
  })

  it('opens a created Session into the conversation composer after Desktop confirmation', () => {
    const submitted: Array<{ id: string; text: string }> = []
    const created = createCompanionSession([], new Set(), {
      operationId: 'session-composer',
      title: 'Ungrouped Session',
      devicePrincipalId: 'device-1',
    })
    render(createElement(MobileBrowse, {
      desktopName: 'Studio Mac',
      connection: 'online',
      sessions: created.sessions,
      onSubmit: (sessionId, text) => { submitted.push({ id: sessionId, text }) },
    }))
    fireEvent.click(screen.getByRole('button', { name: /Ungrouped Session/ }))
    fireEvent.change(screen.getByLabelText('继续会话'), { target: { value: 'hello from Mobile' } })
    fireEvent.submit(screen.getByLabelText('继续会话').closest('form')!)
    expect(submitted).toEqual([{ id: 'session-composer', text: 'hello from Mobile' }])
  })
})
