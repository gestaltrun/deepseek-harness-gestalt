// @vitest-environment jsdom
// The member-question composite card: the chain selector claims exactly the
// member-question requests (plan-review and generic requests fall through),
// the Decision Brief banner renders the carrier's bounded faces, and the
// shared presentation's own minimize toggle folds the whole card to the
// 「远端 · 发起人」 strip without unmounting (and so without spending) the
// presentation's drafts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  type MemberQuestionComposerProps,
} from '../src/client/contract/slots.ts'
import { MemberQuestionCard } from '../src/client/MemberQuestionCard.tsx'
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
  useInput: (() => { throw new Error('unused') }) as never,
  inputActions: { setDraft: () => { throw new Error('unused') }, submit: () => { throw new Error('unused') } } as never,
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
    { path: 'docs/roster.md', reason: '当前成员名单与角色', content: '# 成员名单' },
    { path: 'reports/activity.csv', reason: '近 30 天活跃度' },
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
) {
  return render(
    <MemberQuestionCard
      matched={carrier}
      interactions={[carrier]}
      {...kit}
      t={seat('member-question')}
      questionT={seat('question')}
      focusDocument={focusDocument}
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
      { filename: 'roster.md', reason: '当前成员名单与角色', path: 'docs/roster.md', content: '# 成员名单' },
      { filename: 'activity.csv', reason: '近 30 天活跃度', path: 'reports/activity.csv' },
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

  it('focuses a referenced document and restores the decision beside the open details panel', async () => {
    const focusDocument = vi.fn()
    const { carrier } = memberWait()
    const { container } = renderCard(carrier, focusDocument)

    // Chip click focuses that document: identity, provenance, and the inline
    // body for the renderable kind.
    fireEvent.click(screen.getByRole('button', { name: /roster\.md/ }))
    expect(focusDocument).toHaveBeenCalledWith(SID, {
      path: 'docs/roster.md', filename: 'roster.md', from: '王小明', content: '# 成员名单',
    })

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
