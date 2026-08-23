// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileConversation } from '../src/MobileConversation.tsx'
import { MOBILE_TERMINAL_PREVIEW_LINES, previewTerminalLines } from '../src/mobile-content.ts'

afterEach(() => { cleanup() })

describe('Mobile conversation renderer', () => {
  it('renders shared Markdown, code, image, tool, diff, approval, and Ask User blocks', () => {
    render(createElement(MobileConversation, {
      title: 'Safe',
      onBack: () => {},
      blocks: [
        { kind: 'markdown', text: 'Hello markdown' },
        { kind: 'code', language: 'ts', text: 'const n = 1' },
        { kind: 'image', alt: 'diagram', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
        { kind: 'tool', name: 'read', args: { path: 'a.ts' }, result: { ok: true } },
        { kind: 'diff', path: 'a.ts', text: '-old\n+new' },
        { kind: 'approval', summary: 'Allow write' },
        { kind: 'ask-user', question: 'Continue?' },
      ],
    }))
    expect(screen.getByText('Hello markdown')).toBeTruthy()
    expect(screen.getByText('const n = 1')).toBeTruthy()
    expect(screen.getByAltText('diagram')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('Allow write')).toBeTruthy()
    expect(screen.getByText('Continue?')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
  })

  it('refuses composer mutations while Remote Offline', () => {
    const onSubmit = vi.fn()
    const onAttach = vi.fn()
    render(createElement(MobileConversation, {
      title: 'Offline',
      onBack: () => {},
      companionState: { token: 'tok', foreground: true, socketOpen: false, synchronized: false },
      onSubmit,
      onAttach,
      blocks: [{ kind: 'markdown', text: 'cached' }],
    }))
    expect(screen.getByRole('alert').textContent).toBe('Remote Offline 拒绝发送')
    expect(screen.getByLabelText('继续会话').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('添加附件').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('继续会话'), { target: { value: 'nope' } })
    fireEvent.submit(screen.getByLabelText('继续会话').closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('disables settlement until foreground reconnect and Desktop-authoritative sync', () => {
    const onSettled = vi.fn()
    render(createElement(MobileConversation, {
      title: 'Safe',
      onBack: () => {},
      companionState: { token: 'tok', foreground: true, socketOpen: true, synchronized: false },
      onSettled,
      blocks: [{ kind: 'approval', summary: 'Allow write', authorized: ['once', 'always'] }],
    }))
    const button = screen.getByRole('button', { name: '允许' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '始终允许' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('offers Desktop-authorized Ask User answers and hides cancel unless streaming', () => {
    const onSettled = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(createElement(MobileConversation, {
      title: 'Ask',
      onBack: () => {},
      companionState: { token: 'tok', foreground: true, socketOpen: true, synchronized: true },
      onSubmit: () => {},
      onCancel,
      onSettled,
      blocks: [{
        kind: 'ask-user',
        question: 'Which Desktop path?',
        interactionId: 'question-1',
        authorized: ['A', 'B'],
      }],
    }))
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ask-user',
      settled: { decision: 'B' },
    }))
    rerender(createElement(MobileConversation, {
      title: 'Ask',
      onBack: () => {},
      streaming: true,
      onSubmit: () => {},
      onCancel,
      blocks: [{ kind: 'markdown', text: 'streaming' }],
    }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('renders unknown tools as a generic read-only card and bounds terminal output', () => {
    const lines = Array.from({ length: MOBILE_TERMINAL_PREVIEW_LINES + 4 }, (_, index) => `line-${String(index)}`)
    render(createElement(MobileConversation, {
      title: 'Tools',
      onBack: () => {},
      blocks: [
        { kind: 'unknown-tool', name: 'mystery', args: { q: 1 }, result: { v: 2 } },
        { kind: 'terminal', summary: 'bash', lines },
      ],
    }))
    expect(screen.getByText('mystery')).toBeTruthy()
    expect(screen.getByText('{"q":1}')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('还有 4 行')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(previewTerminalLines(lines).spilled).toBe(4)
  })
})
