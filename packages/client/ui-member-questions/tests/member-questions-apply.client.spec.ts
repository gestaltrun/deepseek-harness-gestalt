// @vitest-environment jsdom
// The browser half on a real SlotRegistry: the plugin declares its services,
// registers the `member-question` dictionaries, and contributes its chain
// entry ahead of the shared question composer (priority -1); teardown empties
// the contribution (HMR safety).
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DetailsDocumentFocus } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { MemberQuestionCard, MemberQuestionRecords } from '../src/client/MemberQuestionCard.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { en as questionEn, zh as questionZh } from '@deepseek-ai/dsh-client-ui-user-questions/src/client/locales.ts'

describe('ui-member-questions browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the chain entry ahead of the shared composer and unregisters on teardown', async () => {
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    // The `question` dictionary is owned by dsh-client-ui-user-questions; the
    // bench registers it the way the shared composer's plugin would.
    locale.register('question', { zh: questionZh, en: questionEn })
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({ 'conversation.composer': { kind: 'chain', scope: 'session' } })
    const feature = await runtime.mount({ inject: [...inject], apply })
    try {
      const entries = runtime.slots.entries('conversation.composer')
      expect(entries).toHaveLength(2)
      const entry = entries[0]!
      expect(entry.component).toBe(MemberQuestionCard)
      // Elects before the shared question composer's default-priority entry.
      expect(entry.options.priority).toBe(-2)
      expect(entries[1]?.component).toBe(MemberQuestionRecords)
      expect(entries[1]?.options.priority).toBe(-1)

      // The dictionaries ride the standard locale seat.
      const memberT = locale.bind('member-question')
      expect(memberT('tag.remote')).toBe('远端')
      expect(memberT('collapsed.mark')).toBe('已收起')

      // The inject face binds the shared question dictionary for the mounted
      // presentation (stable per namespace).
      const injected = (entry.inject as unknown as () => { questionT: (key: string) => string })()
      expect(injected.questionT('nav.minimize')).toBe('收起问题卡片')
    } finally {
      await feature.dispose()
      await runtime.dispose()
    }
    expect(runtime.slots.entries('conversation.composer')).toHaveLength(0)
  })

  it('resolves a late details-focus service per gesture and stops after provider disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('question', { zh: questionZh, en: questionEn })
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({ 'conversation.composer': { kind: 'chain', scope: 'session' } })
    const feature = await runtime.mount({ inject: [...inject], apply })
    const entry = runtime.slots.entries('conversation.composer')[0]!
    const injected = (entry.inject as unknown as () => {
      focusDocument: (sessionId: SessionId, document: DetailsDocumentFocus) => void
    })()
    const sessionId = 'receiving-session' as SessionId
    const document = { path: 'brief.html', filename: 'brief.html', from: 'Alice' }
    const focus = vi.fn()
    try {
      // The optional provider may arrive after this plugin's fiber.
      expect(() => { injected.focusDocument(sessionId, document) }).not.toThrow()
      const disposeProvider = runtime.ctx.reflect.provide('detailsFocus', { focus })
      injected.focusDocument(sessionId, document)
      expect(focus).toHaveBeenCalledWith(sessionId, document)

      await disposeProvider()
      injected.focusDocument(sessionId, document)
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      await feature.dispose()
      await runtime.dispose()
    }
    expect(runtime.slots.entries('conversation.composer')).toHaveLength(0)
  })
})
