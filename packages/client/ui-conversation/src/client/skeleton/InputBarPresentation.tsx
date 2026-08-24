/** Owner-defined narrow InputBar presentation shared by Desktop and direct Web compositions. */

import { forwardRef, type ChangeEventHandler, type ClipboardEventHandler, type CompositionEventHandler } from 'react'
import type { KeyboardEventHandler, MouseEventHandler, ReactNode, RefObject, SelectHTMLAttributes } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './InputBar.module.css'

/** DOM editor contract used by both the full Desktop InputBar and the narrow composer. */
export interface InputBarEditorProps {
  draft: string
  backdrop?: ReactNode | undefined
  disabled?: boolean | undefined
  readOnly?: boolean | undefined
  phase: string
  placeholder: string
  ariaLabel?: string | undefined
  ariaHasPopup?: SelectHTMLAttributes<HTMLTextAreaElement>['aria-haspopup']
  ariaExpanded?: boolean | undefined
  scrollRef?: RefObject<HTMLDivElement> | undefined
  mirrorRef?: RefObject<HTMLDivElement> | undefined
  onChange: ChangeEventHandler<HTMLTextAreaElement>
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement> | undefined
  onSelect?: SelectHTMLAttributes<HTMLTextAreaElement>['onSelect']
  onCopy?: ClipboardEventHandler<HTMLTextAreaElement> | undefined
  onCut?: ClipboardEventHandler<HTMLTextAreaElement> | undefined
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement> | undefined
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement> | undefined
}

/** Shared textarea/backdrop/mirror implementation. */
export const InputBarEditor = forwardRef<HTMLTextAreaElement, InputBarEditorProps>(function InputBarEditor({
  draft, backdrop = draft, disabled = false, readOnly = false, phase, placeholder,
  ariaLabel, ariaHasPopup, ariaExpanded, scrollRef, mirrorRef,
  onChange, onKeyDown, onSelect, onCopy, onCut, onPaste, onCompositionStart, onCompositionEnd,
}, ref) {
  return (
    <div ref={scrollRef} className={css.scroll} data-input-scroll>
      <div className={css.grow}>
        <div
          aria-hidden
          className={clsx(css.backdrop, disabled && css.backdropDisabled)}
          data-input-backdrop
          data-disabled={disabled || undefined}
        >
          {backdrop}
        </div>
        <textarea
          ref={ref}
          className={css.input}
          value={draft}
          disabled={disabled}
          readOnly={readOnly}
          aria-label={ariaLabel}
          aria-haspopup={ariaHasPopup}
          aria-expanded={ariaExpanded}
          data-phase={phase}
          placeholder={placeholder}
          rows={2}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
        />
        <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${draft}\n`}</div>
      </div>
    </div>
  )
})

/** Shared primary send/stop button contract. */
export interface InputBarPrimaryActionProps {
  kind: 'send' | 'stop'
  label: string
  disabled: boolean
  onClick: () => void
  onMouseDown?: MouseEventHandler<HTMLButtonElement> | undefined
}

/** Shared primary send/stop button implementation. */
export function InputBarPrimaryAction({
  kind, label, disabled, onClick, onMouseDown,
}: InputBarPrimaryActionProps): ReactNode {
  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <button
        type="button"
        className={css.primary}
        aria-label={label}
        disabled={disabled}
        onMouseDown={onMouseDown}
        onClick={onClick}
      >
        {kind === 'stop' ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
          </svg>
        )}
      </button>
    </Tooltip>
  )
}

/** Minimal InputBar interface for compositions without Desktop-only command, annotation, or attachment owners. */
export interface InputBarPresentationProps {
  draft: string
  phase: string
  running: boolean
  busy: boolean
  disabled?: boolean | undefined
  placeholder: string
  onDraftChange: (draft: string) => void
  onSubmit: () => void
  onStop?: (() => void) | undefined
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement> | undefined
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined
  /** Latest composer-owned informational or failure notice. */
  notice?: { readonly level: 'info' | 'error'; readonly text: string } | undefined
  t: TranslateNS<'conversation'>
}

/** Narrow InputBar using the same editor and primary-action implementations as Desktop. */
export function InputBarPresentation({
  draft, phase, running, busy, disabled = false, placeholder,
  onDraftChange, onSubmit, onStop, onKeyDown, onPaste, notice, t,
}: InputBarPresentationProps): ReactNode {
  const locked = disabled || busy
  const primaryStops = running
  return (
    <div className={css.root}>
      {notice !== undefined && (
        <div className={css.notice} role={notice.level === 'error' ? 'alert' : 'status'}>{notice.text}</div>
      )}
      <div className={css.card} data-composer-card>
        <InputBarEditor
          draft={draft}
          phase={phase}
          disabled={disabled}
          readOnly={busy}
          placeholder={placeholder}
          onChange={(event) => { onDraftChange(event.target.value) }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className={css.row}>
          <div className={css.tools} />
          <div className={css.trailing}>
            <InputBarPrimaryAction
              kind={primaryStops ? 'stop' : 'send'}
              label={primaryStops ? t('input.stop') : t('input.send')}
              disabled={primaryStops ? disabled || onStop === undefined : locked || draft.trim() === ''}
              onClick={primaryStops ? () => { onStop?.() } : onSubmit}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
