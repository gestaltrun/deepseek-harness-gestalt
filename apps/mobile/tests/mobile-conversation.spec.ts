// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  EMPTY_CHAT_SNAPSHOT,
  EMPTY_CONVERSATION_VIEWS,
  PendingWait,
  type ConversationNode,
  type ConversationSnapshot,
  type SessionId,
  type ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationPresentationTranslate } from '@deepseek-ai/dsh-client-ui-conversation/presentation'
import { questionPresentationTranslate } from '@deepseek-ai/dsh-client-ui-user-questions/presentation'
import { MobileConversation } from '../src/MobileConversation.tsx'

afterEach(() => { cleanup() })

const SID = 'session-mobile' as SessionId
const imageLoader = async (): Promise<string> => 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

function snapshot(
  nodes: readonly ConversationNode[],
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    sessionId: SID,
    views: EMPTY_CONVERSATION_VIEWS,
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes,
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

function tool(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-1',
    call: { name: 'edit', argsRaw: '{"file_path":"src/a.ts"}' },
    callTime: 2_000,
    content: [{ type: 'text', text: 'updated' }],
    isError: false,
    callView: null,
    resultView: {
      card: 'diff',
      diffs: [{ path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
    },
    subCalls: [],
    ...overrides,
  }
}

describe('Mobile shared Session presentation', () => {
  it('keeps history loading disabled until the current generation admits mutations', () => {
    const onLoadOlder = vi.fn()
    const view = render(createElement(MobileConversation, {
      title: 'History', onBack: () => {}, locale: 'en', loadImage: imageLoader,
      snapshot: snapshot([], { hasMore: true }), onLoadOlder, mutationEnabled: false,
    }))
    const load = screen.getByRole('button', { name: 'Load earlier' })
    expect(load.hasAttribute('disabled')).toBe(true)
    fireEvent.click(load)
    expect(onLoadOlder).not.toHaveBeenCalled()

    view.rerender(createElement(MobileConversation, {
      title: 'History', onBack: () => {}, locale: 'en', loadImage: imageLoader,
      snapshot: snapshot([], { hasMore: true }), onLoadOlder, mutationEnabled: true,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('renders Desktop-authoritative Markdown, code, diff, unknown Tool, and failures through shared Web components', () => {
    render(createElement(MobileConversation, {
      title: 'Shared Session',
      onBack: () => {},
      locale: 'en',
      loadImage: imageLoader,
      snapshot: snapshot([
        { kind: 'user', seq: 0, time: 500, content: [{ type: 'text', text: 'Shared user' }], source: null },
        {
          kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1,
          blocks: [{ kind: 'text', text: '**Shared Markdown**\n\n```ts\nconst value = 1\n```' }],
        },
        tool(),
        tool({
          seq: 4,
          callId: 'call-unknown',
          call: { name: 'future_tool', argsRaw: '{"query":"long value"}' },
          resultView: null,
          content: [{ type: 'text', text: '{"answer":42}' }],
        }),
        {
          kind: 'context', seq: 5, time: 5_000, content: [{ type: 'text', text: 'Injected context' }],
          source: null, provenance: { role: 'inject', label: 'AGENTS.md' }, form: null,
        },
        {
          kind: 'model-retry', seq: 6, time: 6_000, retryId: 'mobile-retry' as never,
          turn: 1, step: 1, retryState: 'cancelled', provider: 'mock', mode: 'normal',
          policyKey: 'mock-normal', retry: 1, maxRetries: 2, delayMs: 500,
          failure: { code: 'TRANSPORT', message: 'retry failure' },
        },
        {
          kind: 'command', seq: 7, time: 7_000, commandId: 'mobile-command' as never,
          name: 'plan', args: '', outcome: { kind: 'success', text: 'Plan mode entered' },
        },
        {
          kind: 'compaction', seq: 8, time: 8_000, summary: 'Retained facts', summaryEventSeq: 7,
          shadowedItemCount: 4, shadowedTokenCount: 900,
        },
        { kind: 'turn-error', seq: 9, time: 9_000, turn: 1, step: 1, message: 'Host refused', code: 'HOST_400' },
        { kind: 'turn-max-tokens', seq: 10, time: 10_000, turn: 1, step: 1 },
      ]),
    }))

    expect(screen.getByText('Shared Markdown').tagName).toBe('STRONG')
    expect(screen.getByText('Shared user')).toBeTruthy()
    expect(document.querySelector('pre code')?.textContent).toContain('const value = 1')
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText(/future_tool/)).toBeTruthy()
    expect(screen.getByText('Host refused')).toBeTruthy()
    expect(screen.getByText('HOST_400')).toBeTruthy()
    expect(document.querySelector('[data-mobile-conversation="detail"] [data-tool="future_tool"]')).not.toBeNull()
    expect(document.querySelector('[data-toolview="file-mutation"] [data-tool="edit"]')).not.toBeNull()
    expect(document.querySelector('[data-toolview="generic"] [data-tool="future_tool"]')).not.toBeNull()
    expect(document.querySelector('[data-context-source]')?.textContent).toBe('AGENTS.md')
    expect(screen.getByText(/retry failure/)).toBeTruthy()
    expect(document.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(document.querySelector('[data-compaction-icon="context"]')).not.toBeNull()

    const diffRow = document.querySelector('[data-tool="edit"] [data-expandable]')
    expect(diffRow).not.toBeNull()
    fireEvent.click(diffRow as HTMLElement)
    expect(document.querySelector('[data-mobile-conversation="detail"] [data-diff]')).not.toBeNull()
  })

  it('renders shared image loading and bounded terminal presentation without terminal input', async () => {
    const loadImage = vi.fn(async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')
    const attachment = {
      attachmentId: 'image-mobile' as never,
      mediaType: 'image/gif' as const,
      bytes: 35,
      width: 1,
      height: 1,
      name: 'diagram.gif',
    }
    render(createElement(MobileConversation, {
      title: 'Media',
      onBack: () => {},
      locale: 'en',
      loadImage,
      snapshot: snapshot([
        {
          kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1,
          blocks: [{ kind: 'image', attachment }],
        },
        tool({
          callId: 'call-terminal',
          call: { name: 'bash', argsRaw: '{"command":"pnpm test"}' },
          callView: { card: 'terminal', title: 'pnpm test', description: 'Run tests' },
          resultView: { card: 'terminal', output: Array.from({ length: 300 }, (_, index) => `line-${String(index)}`).join('\n'), exitCode: 0 },
        }),
      ]),
    }))

    await waitFor(() => { expect(screen.getByAltText('diagram.gif')).toBeTruthy() })
    expect(loadImage).toHaveBeenCalledWith(attachment)
    expect(document.querySelector('[data-toolview="bash"]')).not.toBeNull()
    const terminalRow = document.querySelector('[data-toolview="bash"] [data-expandable]')
    expect(terminalRow).not.toBeNull()
    fireEvent.click(terminalRow as HTMLElement)
    expect(document.querySelector('[data-terminal]')).not.toBeNull()
    expect(terminalRow?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('renders shared Approval and Ask User flows from authoritative pending waits', () => {
    const approve = vi.fn(async () => ({ accepted: true as const }))
    const answer = vi.fn(async () => ({ accepted: true as const }))
    const approval = new PendingWait('approval', 'rpc-approval' as never, SID, {
      approvalId: 'approval-1' as never,
      toolName: 'bash',
      reason: 'Allow write',
    }, approve)
    const question = new PendingWait('question', 'rpc-question' as never, SID, {
      questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }],
    }, answer)

    const { rerender } = render(createElement(MobileConversation, {
      title: 'Interactions', onBack: () => {}, locale: 'en', snapshot: snapshot([], { pending: [approval] }),
      loadImage: imageLoader,
      mutationEnabled: true,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(approve).toHaveBeenCalledOnce()

    rerender(createElement(MobileConversation, {
      title: 'Interactions', onBack: () => {}, locale: 'en', snapshot: snapshot([], { pending: [question] }),
      loadImage: imageLoader,
      mutationEnabled: true,
    }))
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(answer).toHaveBeenCalledOnce()
  })

  it('keeps phone navigation while shared copy follows locale and theme', async () => {
    const onSubmit = vi.fn()
    const view = render(createElement(MobileConversation, {
      title: '窄屏会话',
      onBack: () => {},
      locale: 'zh',
      theme: 'dark',
      loadImage: imageLoader,
      snapshot: snapshot([], {
        openState: 'error', openError: { code: 'bad-request', message: '请求无效', details: { issues: [] } },
      }),
      onSubmit,
      mutationEnabled: true,
    }))
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy()
    expect(screen.getByPlaceholderText('给智能体发消息')).toBeTruthy()
    expect(screen.getByText(/历史加载失败/)).toBeTruthy()
    expect(view.container.querySelector('[data-theme="dark"]')).not.toBeNull()
    expect(screen.queryByText(/Settings|设置|Terminal|终端|Model|模型/)).toBeNull()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => { expect(onSubmit).toHaveBeenCalledWith('继续') })
  })

  it('binds both locale dictionaries, common labels, fallbacks, and template parameters', () => {
    const en = conversationPresentationTranslate('en')
    const zh = conversationPresentationTranslate('zh')
    expect(en('input.send')).toBe('Send message')
    expect(Reflect.apply(zh, undefined, ['loading'])).toBe('加载中…')
    expect(Reflect.apply(en, undefined, ['extension.missing'])).toBe('extension.missing')
    expect(en('chat.loadError', { message: 'bad', code: 'E' })).toContain('bad')
    expect(en('chat.loadError', { message: 'bad' })).toContain('{code}')

    const enQuestion = questionPresentationTranslate('en')
    const zhQuestion = questionPresentationTranslate('zh')
    expect(enQuestion('nav.next')).toBe('Next question')
    expect(zhQuestion('submit')).toBe('提交')
    expect(enQuestion('extension.missing')).toBe('extension.missing')
    expect(enQuestion('nav.next', {})).toBe('Next question')
  })

  it('delegates stop, keyboard editing, paste, undo, redo, and rejected submissions through the shared composer', async () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn(async () => { throw 'rejected' })
    const view = render(createElement(MobileConversation, {
      title: 'Composer', onBack: () => {}, locale: 'en',
      snapshot: snapshot([], { running: true }), onSubmit, onCancel,
      loadImage: imageLoader,
      mutationEnabled: true,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(onCancel).toHaveBeenCalledOnce()

    view.rerender(createElement(MobileConversation, {
      title: 'Composer', onBack: () => {}, locale: 'en', snapshot: snapshot([]), onSubmit, onCancel,
      loadImage: imageLoader,
      mutationEnabled: true,
    }))
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'first', selectionStart: 5 } })
    fireEvent.keyDown(textbox, { key: 'z', metaKey: true })
    fireEvent.keyDown(textbox, { key: 'z', metaKey: true, shiftKey: true })
    fireEvent.keyDown(textbox, { key: 'ArrowUp' })
    fireEvent.keyDown(textbox, { key: 'Escape' })
    fireEvent.keyDown(textbox, { key: ' ' })
    fireEvent.paste(textbox, {
      clipboardData: {
        items: [],
        getData: () => ' pasted',
      },
    })
    fireEvent.select(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    await waitFor(() => { expect(onSubmit).toHaveBeenCalled() })
  })

  it('keeps shared composer mutations disabled before current-generation synchronization', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(createElement(MobileConversation, {
      title: 'Reconnect',
      onBack: () => {},
      locale: 'en',
      loadImage: imageLoader,
      snapshot: snapshot([], { running: true }),
      onSubmit,
      onCancel,
      mutationEnabled: false,
    }))
    const input = screen.getByRole('textbox')
    const stop = screen.getByRole('button', { name: 'Stop generating' })
    expect(input.hasAttribute('disabled')).toBe(true)
    expect(stop.hasAttribute('disabled')).toBe(true)
    fireEvent.click(stop)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('passes the real selected File to the encrypted attachment callback', () => {
    const onAttach = vi.fn()
    const file = new File([Uint8Array.of(0, 255, 1)], 'actual.bin', { type: 'application/octet-stream' })
    render(createElement(MobileConversation, {
      title: 'Attachment',
      onBack: () => {},
      locale: 'zh',
      snapshot: snapshot([]),
      loadImage: imageLoader,
      onSubmit: () => {},
      onAttach,
      mutationEnabled: true,
    }))
    fireEvent.change(screen.getByLabelText('添加附件'), { target: { files: [file] } })
    expect(onAttach).toHaveBeenCalledWith(file)
  })
})
