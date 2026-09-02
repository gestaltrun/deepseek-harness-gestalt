// @vitest-environment jsdom
// The member-question composite card: the chain selector claims exactly the
// member-question requests (plan-review and generic requests fall through),
// the Decision Brief banner renders the carrier's bounded faces, and the
// shared presentation's own minimize toggle folds the whole card to the
// 「远端 · 发起人」 strip without unmounting (and so without spending) the
// presentation's drafts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcReceipt } from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { registerDomSnapshotSerializer } from '@deepseek-ai/dsh-client-test-runtime'
import {
  BACKGROUND_CLAMP, clampBackground, isMemberQuestionBatch, memberBriefOf, selectMemberQuestion,
  selectMemberQuestionRecords,
  type MemberQuestionComposerProps,
} from '../src/client/contract/slots.ts'
import { MemberQuestionCard, MemberQuestionDock, MemberQuestionRecords } from '../src/client/MemberQuestionCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as questionEn, zh as questionZh } from '@deepseek-ai/dsh-client-ui-user-questions/src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

registerDomSnapshotSerializer()

afterEach(cleanup)

const SID = 's1' as SessionId

/** Seat stub over a dictionary pair mirroring the real lookup chain: package dictionary, common vocabulary, `{name}` substitution. */
const seatOver = (dict: Record<string, string>, question: Record<string, string>, common: Record<string, string>) =>
  (namespace: 'member-question' | 'question') =>
    (key: string, params?: Record<string, unknown>): string => {
      const template = (namespace === 'member-question' ? dict : question)[key] ?? common[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match)
    }

const seat = seatOver(zh, questionZh, commonZh)

/** Framework standard-kit stubs: the card consumes only the locale seats. */
const kit = {
  sessionId: SID,
  session: undefined,
  useSession: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<ConversationSnapshot>,
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
  useProjection: (() => undefined) as never,
  useInput: ((selector: (state: { draft: string; phase: 'plain' }) => unknown) =>
    selector({ draft: '', phase: 'plain' })) as never,
  inputActions: { setDraft: () => undefined, submit: () => undefined } as never,
}

const NOW = 1_800_000_000_000

/** One member-question batch: the carried intent rides every question. */
const memberQuestions = (intent: Record<string, unknown>): MemberQuestionComposerProps['matched']['payload']['questions'] => [{
  id: 'remove-member',
  header: '成员管理',
  question: '将王小明移出项目吗？',
  detail: '该成员近 30 天无提交记录。',
  options: [
    { label: '移出 (recommended)', description: '收回项目访问权。' },
    { label: '保留', description: '保持只读成员身份。' },
  ],
  intent,
}] as MemberQuestionComposerProps['matched']['payload']['questions']

/** Carried Decision Brief fields: origin identity, materials, and the expiry instant. */
const projection = () => ({
  origin: {
    projectName: '千帆平台',
    originSessionTitle: '整理迭代计划',
    askerDisplayName: '王小明',
    askerRole: 'admin' as const,
  },
  references: [
    {
      path: 'docs/roster.md',
      reason: '当前成员名单与角色',
      cachedPath: '.dsh/member-questions/question-1/roster.md',
      content: '# 成员名单',
    },
    {
      path: 'reports/activity.csv',
      reason: '近 30 天活跃度',
      cachedPath: '.dsh/member-questions/question-1/activity.csv',
    },
  ],
  expiresAt: NOW + 125 * 1000,
})

/** Carrier fixture over a scripted respond carrier; the extras ride the shared intent. */
function memberWait(
  carriedOver: Record<string, unknown> = projection(),
  respond = vi.fn(() => Promise.resolve<RpcReceipt>({ accepted: true })),
) {
  const payload = {
    questions: memberQuestions({ kind: 'member-question', ...carriedOver }),
  }
  const carrier = new PendingWait(
    'question', RpcId('q-1'), SID, payload, respond)
  return { carrier, respond }
}

function genericWait(intent: undefined | { kind: 'plan-review'; approve: string }) {
  const payload = {
    questions: [{
      id: 'plain', question: '继续吗？',
      options: [{ label: '是' }, { label: '否' }],
      ...(intent === undefined ? {} : { intent }),
    }],
  }
  return new PendingWait('question', RpcId('q-2'), SID, payload, () => Promise.resolve<RpcReceipt>({ accepted: true }))
}

function renderCard(
  carrier: PendingWait<'question'>,
  focusDocument: MemberQuestionComposerProps['focusDocument'] = () => {},
  openReference: MemberQuestionComposerProps['openReference'] = () => {},
) {
  return render(
    <MemberQuestionCard
      matched={carrier}
      interactions={[carrier]}
      {...kit}
      t={seat('member-question')}
      questionT={seat('question')}
      focusDocument={focusDocument}
      openReference={openReference}
    />,
  )
}

/**
 * Tidy print-noise text before a snapshot: blank the shared answer field's
 * sizing mirrors (the mirror renders the draft plus a trailing newline to own
 * its grid row height, see QuestionComposer's AnswerField) and trim the
 * whitespace the shared pager's JSX text nodes carry, neither of which is
 * content the snapshots pin — both would otherwise trail snapshot lines as
 * whitespace the repository's text gates reject.
 */
function tidyDomForSnapshot(root: HTMLElement): void {
  root.querySelectorAll('[data-member-presentation] div[aria-hidden="true"]')
    .forEach((node) => { if (node.textContent?.trim() === '') node.textContent = '' })
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeValue !== node.nodeValue?.trim()) node.nodeValue = node.nodeValue?.trim() ?? ''
  }
}

describe('member-question routing', () => {
  it('renders the pending card or terminal bands in the additive product-composer dock', () => {
    const { carrier } = memberWait()
    const props = {
      ...kit,
      input: { draft: '', phase: 'plain' },
      session: { pending: [carrier], memberQuestionRecords: [] },
      t: seat('member-question'),
      questionT: seat('question'),
      focusDocument: () => {},
      openReference: () => {},
    }
    const pending = render(MemberQuestionDock(props as never))
    expect(pending.container.querySelector('[data-member-presentation]')).not.toBeNull()
    pending.unmount()
    const terminal = render(MemberQuestionDock({
      ...props,
      session: {
        pending: [],
        memberQuestionRecords: [{
          questionId: 'terminal', state: 'withdrawn', askedAt: 100, terminalAt: 200,
          intent: { kind: 'member-question', questionId: 'terminal' },
        }],
      },
    } as never))
    expect(terminal.container.querySelector('[data-record-state="withdrawn"]')).not.toBeNull()
    terminal.unmount()
    const empty = render(MemberQuestionDock({
      ...props,
      session: { pending: [] },
    } as never))
    expect(empty.container.innerHTML).toBe('')
  })

  it('claims only non-empty terminal record projections', () => {
    expect(selectMemberQuestionRecords({ session: undefined })).toBeNull()
    expect(selectMemberQuestionRecords({ session: {
      memberQuestionRecords: [],
    } as unknown as ConversationSnapshot })).toBeNull()
    const records = [{ questionId: 'q' }] as never
    expect(selectMemberQuestionRecords({ session: {
      memberQuestionRecords: records,
    } as unknown as ConversationSnapshot })).toBe(records)
  })

  it('claims a request whose whole batch declares the member-question intent', () => {
    const { carrier } = memberWait()
    expect(isMemberQuestionBatch(carrier.payload.questions)).toBe(true)
    expect(selectMemberQuestion({ interactions: [carrier] })).toBe(carrier)
  })

  it('keeps plan-review requests with the shared composer', () => {
    const carrier = genericWait({ kind: 'plan-review', approve: '是' })
    expect(selectMemberQuestion({ interactions: [carrier] })).toBeNull()
  })

  it('keeps intent-less requests with the generic flow', () => {
    const carrier = genericWait(undefined)
    expect(selectMemberQuestion({ interactions: [carrier] })).toBeNull()
  })

  it('declines a mixed batch to the generic flow', () => {
    const payload = {
      questions: [
        ...memberQuestions({ kind: 'member-question' }),
        { id: 'plain', question: '继续吗？', options: [{ label: '是' }] },
      ],
    }
    const carrier = new PendingWait(
      'question', RpcId('q-3'), SID, payload,
      () => Promise.resolve<RpcReceipt>({ accepted: true }))
    expect(selectMemberQuestion({ interactions: [carrier] })).toBeNull()
  })
})

describe('clampBackground and memberBriefOf', () => {
  it('clamps the background at the code-point budget without splitting a surrogate pair', () => {
    const emoji = '🚀'
    const long = emoji.repeat(BACKGROUND_CLAMP + 10)
    const clamped = clampBackground(long)
    expect(Array.from(clamped)).toHaveLength(BACKGROUND_CLAMP)
    expect(clampBackground('短背景')).toBe('短背景')
  })

  it('builds the brief from the carrier: clamped background, chip filenames, projection faces', () => {
    const { carrier } = memberWait({
      origin: projection().origin,
      references: projection().references,
      expiresAt: NOW + 3_600_000,
    })
    const brief = memberBriefOf(carrier)
    expect(brief.origin).toEqual(projection().origin)
    expect(brief.references).toEqual([
      {
        filename: 'roster.md',
        reason: '当前成员名单与角色',
        path: 'docs/roster.md',
        cachedPath: '.dsh/member-questions/question-1/roster.md',
        content: '# 成员名单',
      },
      {
        filename: 'activity.csv',
        reason: '近 30 天活跃度',
        path: 'reports/activity.csv',
        cachedPath: '.dsh/member-questions/question-1/activity.csv',
      },
    ])
    expect(brief.expiresAt).toBe(NOW + 3_600_000)
    // The carrier's detail is the background, byte-for-byte under the budget.
    expect(brief.background).toBe('该成员近 30 天无提交记录。')
  })

  it('renders the identity-lite brief when the projection has not landed', () => {
    const { carrier } = memberWait({})
    const brief = memberBriefOf(carrier)
    expect(brief.origin).toBeUndefined()
    expect(brief.expiresAt).toBeUndefined()
    expect(brief.references).toEqual([])
    expect(brief.background).toBe('该成员近 30 天无提交记录。')
  })

  it('omits an empty fallback background when neither carried background nor detail exists', () => {
    const carrier = new PendingWait('question', RpcId('q-empty'), SID, {
      questions: [{ id: 'plain', question: 'Continue?', intent: { kind: 'member-question' } as never }],
    }, () => Promise.resolve<RpcReceipt>({ accepted: true }))
    expect(memberBriefOf(carrier).background).toBeUndefined()
  })
})

describe('MemberQuestionCard', () => {
  it('renders the Decision Brief banner over the shared question presentation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { carrier } = memberWait()
      const { container } = renderCard(carrier)

      expect(screen.getByText('远端')).toBeTruthy()
      expect(screen.getByText('王小明')).toBeTruthy()
      expect(screen.getByText('管理员')).toBeTruthy()
      expect(screen.getByText('项目')).toBeTruthy()
      expect(screen.getByText('千帆平台')).toBeTruthy()
      expect(screen.getByText('来源会话')).toBeTruthy()
      expect(screen.getByText('整理迭代计划')).toBeTruthy()
      // Countdown formats as hh:mm:ss.
      expect(screen.getByText(/⏳ 00:02:05/)).toBeTruthy()
      expect(screen.getByText('背景')).toBeTruthy()
      expect(screen.getAllByText('该成员近 30 天无提交记录。').length).toBeGreaterThan(0)
      expect(screen.getByText('材料')).toBeTruthy()
      expect(screen.getByText('roster.md')).toBeTruthy()
      expect(screen.getByText('当前成员名单与角色')).toBeTruthy()
      // The shared presentation keeps its native flow: pagination, recommendation, options.
      expect(screen.getByText('将王小明移出项目吗？')).toBeTruthy()
      expect(screen.getByText('1 / 1')).toBeTruthy()
      expect(screen.getByText('推荐')).toBeTruthy()
      expect(screen.getByRole('radio', { name: '移出' })).toBeTruthy()
      expect(screen.getByPlaceholderText('输入你的答案')).toBeTruthy()
      expect(container.querySelector('[data-folded]')).toBeNull()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('falls back to the initial avatar and the expired label on their boundary faces', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { carrier } = memberWait({
        origin: { ...projection().origin, askerDisplayName: 'Alice', askerRole: 'owner' },
        expiresAt: NOW - 1000,
      })
      renderCard(carrier)
      // No avatar URL: the display name's first code point stands in.
      expect(screen.getByText('A', { selector: 'span' })).toBeTruthy()
      expect(screen.getByText('所有者')).toBeTruthy()
      expect(screen.getByText('已过期')).toBeTruthy()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('renders an avatar URL and tolerates an empty fallback display name', () => {
    const withImage = memberWait({
      origin: { ...projection().origin, askerAvatarUrl: 'https://example.test/avatar.png' },
      expiresAt: NOW + 1_000,
    }).carrier
    const first = renderCard(withImage)
    expect(first.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/avatar.png')
    cleanup()
    const emptyName = memberWait({
      origin: { ...projection().origin, askerDisplayName: '' },
      expiresAt: NOW + 1_000,
    }).carrier
    expect(renderCard(emptyName).container.querySelector('span[aria-hidden="true"]')?.textContent).toBe('')
  })

  it('updates the display-only countdown while mounted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      renderCard(memberWait().carrier)
      expect(screen.getByText(/00:02:05/u)).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(screen.getByText(/00:02:04/u)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders hour-scale countdowns and the member role', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { carrier } = memberWait({
        origin: { ...projection().origin, askerRole: 'member' },
        expiresAt: NOW + 2 * 3_600_000 + 60_000,
      })
      const { container } = renderCard(carrier)
      expect(container.textContent).toContain('02:01:00')
      expect(screen.getByText('成员')).toBeTruthy()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('folds with the presentation minimize toggle and unfolds from the strip, drafts intact', async () => {
    const { carrier } = memberWait()
    const { container } = renderCard(carrier)

    fireEvent.click(screen.getByRole('button', { name: '收起问题卡片' }))
    await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeTruthy() })
    // The whole card folded: the presentation stays mounted but hidden, and
    // the strip carries the collapse mark.
    expect(screen.getByText('远端 · 王小明')).toBeTruthy()
    expect(screen.getByText('已收起')).toBeTruthy()
    const presentation = container.querySelector('[data-member-presentation]')
    expect(presentation?.className).toContain('bodyHidden')

    // Revealing from the strip shows the presentation still minimized — the
    // shared component's own maximize toggle stays the way back in.
    fireEvent.click(screen.getByRole('button', { name: '远端 · 王小明' }))
    await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeNull() })
    expect(screen.getByRole('button', { name: '展开问题卡片' })).toBeTruthy()

    // Re-expanding the presentation clears the linkage state.
    fireEvent.click(screen.getByRole('button', { name: '展开问题卡片' }))
    await waitFor(() => { expect(screen.getByText('将王小明移出项目吗？')).toBeTruthy() })
    expect(screen.getByRole('button', { name: '收起问题卡片' })).toBeTruthy()
  })

  it('opens a referenced document through Files and restores the decision beside the open details panel', async () => {
    const openReference = vi.fn()
    const { carrier } = memberWait()
    const { container } = renderCard(carrier, undefined, openReference)

    fireEvent.click(screen.getByRole('button', { name: /roster\.md/ }))
    expect(openReference).toHaveBeenCalledWith(
      SID, '.dsh/member-questions/question-1/roster.md', 'roster.md',
    )
    fireEvent.click(screen.getByRole('button', { name: /activity\.csv/u }))
    expect(openReference).toHaveBeenLastCalledWith(
      SID, '.dsh/member-questions/question-1/activity.csv', 'activity.csv',
    )

    // Panel opens → the card folds to its strip; panel closes → restored.
    // The linkage rides the persistent details column's aria-expanded. The
    // panel mounts first, so the attribute flips are observed mutations.
    const panel = document.createElement('div')
    panel.setAttribute('data-details-panel', '')
    document.body.appendChild(panel)
    try {
      panel.setAttribute('aria-expanded', 'true')
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeTruthy() })
      expect(screen.getByText('远端 · 王小明')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: '远端 · 王小明' }))
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeNull() })
      expect(panel.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('将王小明移出项目吗？')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: '收起问题卡片' }))
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '远端 · 王小明' }))
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeNull() })
      fireEvent.click(screen.getByRole('button', { name: '展开问题卡片' }))
      await waitFor(() => { expect(screen.getByText('将王小明移出项目吗？')).toBeTruthy() })

      panel.setAttribute('aria-expanded', 'false')
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeNull() })
      panel.setAttribute('aria-expanded', 'true')
      await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeTruthy() })
    } finally {
      panel.remove()
    }
  })

  it('does not open a chip without a receiver-owned cached path', () => {
    const openReference = vi.fn()
    const { carrier } = memberWait({
      origin: projection().origin,
      references: [{ path: 'docs/roster.md', reason: '当前成员名单与角色' }],
    })
    renderCard(carrier, undefined, openReference)
    fireEvent.click(screen.getByRole('button', { name: /roster\.md/ }))
    expect(openReference).not.toHaveBeenCalled()
  })

  it('snapshots the full banner and the shared presentation (light)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { carrier } = memberWait()
      const { container } = renderCard(carrier)
      tidyDomForSnapshot(container)
      expect(container).toMatchSnapshot()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('renders answered-elsewhere terminal metadata as a passive record band', () => {
    const intent = memberQuestions({ kind: 'member-question', ...projection() })[0]?.intent
    if (intent?.kind !== 'member-question') throw new Error('member-question test intent missing')
    render(<MemberQuestionRecords matched={[{
      questionId: 'question-1',
      state: 'answered-elsewhere',
      askedAt: NOW - 1_000,
      terminalAt: NOW,
      intent,
      settledByDeviceName: 'Office Mac',
    }]} t={seat('member-question')} />)
    expect(screen.getByText('已在 Office Mac 回答')).toBeTruthy()
    expect(document.querySelector('[data-record-state="answered-elsewhere"] time')?.getAttribute('datetime'))
      .toBe(new Date(NOW).toISOString())
  })

  it('renders every terminal state and the answered-elsewhere device fallback', () => {
    const intent = memberQuestions({ kind: 'member-question', ...projection() })[0]?.intent
    if (intent?.kind !== 'member-question') throw new Error('member-question test intent missing')
    const states = ['answered', 'declined', 'expired', 'withdrawn', 'superseded'] as const
    render(<MemberQuestionRecords matched={[
      ...states.map((state, index) => ({
        questionId: `question-${String(index)}`, state, askedAt: NOW - 1_000,
        terminalAt: NOW + index, intent,
      })),
      {
        questionId: 'question-elsewhere', state: 'answered-elsewhere' as const,
        askedAt: NOW - 1_000, terminalAt: NOW + 10, intent,
      },
    ]} t={seat('member-question')} />)
    expect(screen.getByText('已回答')).toBeTruthy()
    expect(screen.getByText('已拒绝')).toBeTruthy()
    expect(screen.getByText('已过期')).toBeTruthy()
    expect(screen.getByText('已撤回')).toBeTruthy()
    expect(screen.getByText('已被新问题取代')).toBeTruthy()
    expect(screen.getByText('已在 成员 回答')).toBeTruthy()
    cleanup()
    expect(render(<MemberQuestionRecords matched={[]} t={seat('member-question')} />).container.innerHTML).toBe('')
  })

  it('snapshots the full banner under the dark theme attribute', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    document.documentElement.setAttribute('data-ds-dark-theme', 'dark')
    try {
      const { carrier } = memberWait()
      const { container } = renderCard(carrier)
      tidyDomForSnapshot(container)
      expect(container).toMatchSnapshot()
    } finally {
      document.documentElement.removeAttribute('data-ds-dark-theme')
      vi.restoreAllMocks()
    }
  })

  it('snapshots the identity-lite banner and the folded strip', async () => {
    const { carrier } = memberWait({})
    const { container } = renderCard(carrier)
    tidyDomForSnapshot(container)
    expect(container).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: '收起问题卡片' }))
    await waitFor(() => { expect(container.querySelector('[data-folded]')).toBeTruthy() })
    // No origin rides the carrier: the strip names the generic member face.
    expect(screen.getByText('远端 · 成员')).toBeTruthy()
    tidyDomForSnapshot(container)
    expect(container).toMatchSnapshot()
  })

  it('snapshots the English copy', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { carrier } = memberWait()
      const seatEn = seatOver(en, questionEn, commonEn)
      const { container } = render(
        <MemberQuestionCard
          matched={carrier}
          interactions={[carrier]}
          {...kit}
          t={seatEn('member-question')}
          questionT={seatEn('question')}
          focusDocument={() => {}}
          openReference={() => {}}
        />,
      )
      expect(screen.getByText('Remote')).toBeTruthy()
      expect(screen.getByText('Project')).toBeTruthy()
      tidyDomForSnapshot(container)
      expect(container).toMatchSnapshot()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
