/** Public question presentation seam shared by non-Desktop Web compositions. */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { QuestionComposer } from './client/QuestionComposer.tsx'
import type { PendingQuestion, QuestionComposerProps } from './client/contract/slots.ts'
import { en, zh } from './client/locales.ts'

/** Locale ids supported by the shared question presentation. */
export type QuestionPresentationLocale = 'zh' | 'en'

const COMMON = {
  zh: { submit: '提交', submitting: '正在提交…' },
  en: { submit: 'Submit', submitting: 'Submitting…' },
} as const

/**
 * Bind the question dictionaries without constructing a Client Runtime.
 * @param locale - selected product locale.
 * @returns translator accepted by the shared question component.
 */
export function questionPresentationTranslate(locale: QuestionPresentationLocale): TranslateNS<'question'> {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  const common: Record<string, string> = COMMON[locale]
  const translate: TranslateNS<'question'> = key => dictionary[key] ?? common[key] ?? key
  return translate
}

/** Props for the shared Ask User takeover. */
export interface QuestionPresentationProps {
  /** Desktop-authoritative pending question carrier. */
  wait: PendingQuestion
  /** Shared question translator. */
  t: TranslateNS<'question'>
  /** Disable settlement while the composition lacks current mutation authority. */
  disabled?: boolean | undefined
}

/** Render and settle Ask User through the same QuestionComposer used by Desktop. */
export function QuestionPresentation({ wait, t, disabled = false }: QuestionPresentationProps): ReactNode {
  const store = {
    getSnapshot: () => ({
      requestKey: wait.key,
      progress: { index: 0, drafts: wait.questions.map(() => ({ selected: [], custom: '', skipped: false })) },
    }),
    subscribe: () => () => {},
    actions: {
      replace: () => {},
      clear: () => {},
    },
  }
  return (
    <fieldset disabled={disabled}>
      <QuestionComposer
        {
          ...{
            matched: wait,
            t,
            useStore: ((selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) =>
              selector(store.getSnapshot())) as QuestionComposerProps['useStore'],
            actions: store.actions,
          } as QuestionComposerProps
        }
      />
    </fieldset>
  )
}
