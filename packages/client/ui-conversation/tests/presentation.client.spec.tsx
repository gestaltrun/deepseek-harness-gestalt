// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
  type ConversationSnapshot,
  type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  ConversationComposer,
  ConversationNodePresentation,
  conversationPresentationTranslate,
} from '../src/presentation.tsx'

afterEach(cleanup)

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: 'presentation-session' as SessionId,
    views: EMPTY_CONVERSATION_VIEWS,
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...overrides,
  }
}

describe('public conversation presentation seam', () => {
  it('renders unknown keyed nodes through the shared localized JSON fallback', () => {
    render(createElement(ConversationNodePresentation, {
      node: {
        kind: 'unknown', seq: 1, time: 1, type: 'surface/future', data: 'x'.repeat(20_001),
      },
      renderMessageImages: vi.fn(),
      renderTool: vi.fn(),
      t: conversationPresentationTranslate('en'),
    }))

    fireEvent.click(screen.getByRole('button', { name: /Unknown surface event: surface\/future/ }))
    expect(screen.getByText(/truncated.*20003/i)).toBeTruthy()
  })

  it('submits and retains rejected text through the narrow shared InputBar contract', async () => {
    const onSubmit = vi.fn(async () => { throw new Error('Desktop refused') })
    render(createElement(ConversationComposer, {
      snapshot: snapshot(),
      onSubmit,
      t: conversationPresentationTranslate('en'),
    }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'submit me' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(onSubmit).toHaveBeenCalledWith('submit me') })
    expect((input as HTMLTextAreaElement).value).toBe('submit me')
    expect(document.querySelector('[data-input-backdrop]')?.textContent).toContain('submit me')
    expect((await screen.findByRole('alert')).textContent).toContain('Desktop refused')
  })

  it('settles a synchronous transport refusal and re-enables the retained draft', async () => {
    const onSubmit = vi.fn(() => { throw new Error('mutation channel unavailable') })
    render(createElement(ConversationComposer, {
      snapshot: snapshot(),
      onSubmit,
      t: conversationPresentationTranslate('en'),
    }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'retry me' } })

    expect(() => { fireEvent.keyDown(input, { key: 'Enter' }) }).not.toThrow()
    await waitFor(() => { expect(input.hasAttribute('disabled')).toBe(false) })
    expect((input as HTMLTextAreaElement).value).toBe('retry me')
  })

  it('uses the same primary action for Desktop-authoritative running state', () => {
    const onCancel = vi.fn()
    render(createElement(ConversationComposer, {
      snapshot: snapshot({ running: true }),
      onSubmit: vi.fn(),
      onCancel,
      t: conversationPresentationTranslate('zh'),
    }))
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('preserves draft rules across keyboard, composition, paste, and unavailable states', async () => {
    let resolveSubmit: (() => void) | undefined
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { resolveSubmit = resolve }))
    const view = render(createElement(ConversationComposer, {
      snapshot: snapshot(),
      onSubmit,
      t: conversationPresentationTranslate('en'),
    }))
    const input = screen.getByRole('textbox')

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Z', metaKey: true, shiftKey: true })
    fireEvent.keyDown(input, { key: 'y', ctrlKey: true })
    fireEvent.paste(input, { clipboardData: { getData: () => '' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'send once' } })
    fireEvent.keyDown(input, { key: 'Enter', repeat: true })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(onSubmit).toHaveBeenCalledWith('send once') })
    fireEvent.keyDown(input, { key: 'z', metaKey: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.paste(input, { clipboardData: { getData: () => 'busy paste' } })

    resolveSubmit?.()
    await waitFor(() => { expect((input as HTMLTextAreaElement).value).toBe('') })
    view.rerender(createElement(ConversationComposer, {
      snapshot: snapshot({ removed: true }),
      onSubmit,
      t: conversationPresentationTranslate('en'),
    }))
    expect(screen.getByPlaceholderText('Session unavailable')).toBeTruthy()
  })
})
