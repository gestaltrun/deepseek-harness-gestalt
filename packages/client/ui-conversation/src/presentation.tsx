/** Public presentation seam shared by Web compositions that do not mount the Desktop page shell. */

import { useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import type {
  ConversationNode, ConversationSnapshot, PendingWait, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputEffect, InputState } from './client/input/contract.ts'
import { AssistantMarkdown } from './client/chat/AssistantMarkdown.tsx'
import {
  ModelRetryItem, TurnErrorItem, TurnMaxTokensItem, UserStyleBubble,
} from './client/chat/MessageItem.tsx'
import { ContextInjectionRow } from './client/chat/ContextInjectionRow.tsx'
import { CompactionItem } from './client/chat/CompactionItem.tsx'
import { GenericCommandCard } from './client/chat/GenericCommandCard.tsx'
import {
  ApprovalPresentation, approvalCommandOf,
} from './client/skeleton/ApprovalPanel.tsx'
import { PendingApproval } from './client/contract/slots.ts'
import { InputBarPresentation } from './client/skeleton/InputBarPresentation.tsx'
import { InputMachine } from './client/input/machine.ts'
import { en, zh } from './client/locales.ts'

/** Locale ids supported by the shared Web presentation. */
export type ConversationPresentationLocale = 'zh' | 'en'

const COMMON = {
  zh: { copy: '复制', copied: '复制成功', loading: '加载中…' },
  en: { copy: 'Copy', copied: 'Copied', loading: 'Loading…' },
} as const

/* v8 ignore next 3 -- closed-union defaults only defend future source widening. */
function assertNever(_value: never): never {
  throw new Error('Unsupported Conversation Node')
}

/**
 * Bind the shared conversation dictionaries without constructing a Client Runtime.
 * @param locale - selected product locale.
 * @returns translator accepted by the exported conversation components.
 */
export function conversationPresentationTranslate(
  locale: ConversationPresentationLocale,
): TranslateNS<'conversation'> {
  const dictionary: Record<string, string> = locale === 'zh' ? zh : en
  const common: Record<string, string> = COMMON[locale]
  const translate: TranslateNS<'conversation'> = (key, params) => {
    const template = dictionary[key] ?? common[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match)
  }
  return translate
}

/** Props for the shared user-message renderer. */
export interface ConversationUserMessageProps {
  /** Desktop-authoritative message content. */
  content: readonly unknown[]
  /** Shared image renderer bound to the current Session's authorized loader. */
  renderMessageImages: Parameters<typeof UserStyleBubble>[0]['renderMessageImages']
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
}

/** Render a user message through the same bubble implementation as Desktop. */
export function ConversationUserMessage({ content, renderMessageImages, t }: ConversationUserMessageProps): ReactNode {
  return <UserStyleBubble content={content} renderMessageImages={renderMessageImages} t={t} />
}

/** Props for the shared turn-failure renderer. */
export interface ConversationFailureProps {
  /** Desktop-authoritative turn failure. */
  node: TurnErrorNode | TurnMaxTokensNode
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
}

/** Render a terminal turn outcome through the same implementation as Desktop. */
export function ConversationFailure({ node, t }: ConversationFailureProps): ReactNode {
  return node.kind === 'turn-error' ? <TurnErrorItem node={node} t={t} /> : <TurnMaxTokensItem t={t} />
}

/** Props for the authoritative keyed Conversation Node presentation seam. */
export interface ConversationNodePresentationProps {
  /** One Desktop-authoritative finalized Conversation Node. */
  node: ConversationNode
  /** Shared image renderer bound to the current Session. */
  renderMessageImages: ConversationUserMessageProps['renderMessageImages']
  /** Tool owner adapter; Tool presentation remains in its owning package. */
  renderTool: (node: ToolResultNode) => ReactNode
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
}

/**
 * Render every finalized Conversation Node through the implementations owned by Desktop Web.
 * @param props - authoritative node and its owner adapters.
 * @returns keyed Desktop Web presentation for the node.
 */
export function ConversationNodePresentation({
  node, renderMessageImages, renderTool, t,
}: ConversationNodePresentationProps): ReactNode {
  switch (node.kind) {
    case 'user':
    case 'steering':
      return <ConversationUserMessage content={node.content} renderMessageImages={renderMessageImages} t={t} />
    case 'assistant':
      return (
        <AssistantMarkdown
          blocks={node.blocks}
          streaming={false}
          interrupted={node.interrupted}
          renderMessageImages={renderMessageImages}
          t={t}
          sourceId={node.messageId}
        />
      )
    case 'tool-result':
      return renderTool(node)
    case 'turn-error':
    case 'turn-max-tokens':
      return <ConversationFailure node={node} t={t} />
    case 'context':
      return (
        <ContextInjectionRow
          content={node.content}
          source={node.source}
          provenance={node.provenance}
          form={node.form}
          t={t}
        />
      )
    case 'model-retry':
      return <ModelRetryItem node={node} active={node.retryState === 'scheduled'} t={t} />
    case 'command':
      return <GenericCommandCard node={node} t={t} />
    case 'compaction':
      return <CompactionItem node={node} t={t} />
    case 'unknown':
      return (
        <JsonBlock
          label={t('message.unknownSurface', { type: node.type })}
          payload={node.data}
          truncatedLabel={total => t('json.truncated', { total })}
        />
      )
    /* v8 ignore next -- every current Conversation Node kind is handled above. */
    default: return assertNever(node)
  }
}

/** Props for the shared Approval takeover. */
export interface ConversationApprovalProps {
  /** Desktop-authoritative pending Approval carrier. */
  wait: PendingWait<'approval'>
  /** Current Desktop-authoritative Session projection used to find the paired command. */
  snapshot: ConversationSnapshot
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
  /** Disable settlement while the composition lacks current mutation authority. */
  disabled?: boolean | undefined
}

/**
 * Render and settle an Approval through the same composer takeover as Desktop.
 * @param props - authoritative pending Approval, projection, translator, and mutation state.
 * @returns shared Approval takeover.
 */
export function ConversationApproval({ wait, snapshot, t, disabled = false }: ConversationApprovalProps): ReactNode {
  const approval = new PendingApproval(wait)
  return (
    <ApprovalPresentation
      wait={wait}
      command={approvalCommandOf(snapshot, approval)}
      t={t}
      disabled={disabled}
    />
  )
}

/** Props for the shared standalone composer adapter. */
export interface ConversationComposerProps {
  /** Desktop-authoritative Session projection controlling run and removal state. */
  snapshot: ConversationSnapshot
  /** Submit one prompt through the composition's authority adapter. */
  onSubmit: (text: string) => void | Promise<void>
  /** Cancel the active Desktop turn when supplied. */
  onCancel?: (() => void) | undefined
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
  /** Disable edits and mutations while the composition lacks current authority. */
  disabled?: boolean | undefined
}

/** Execute InputMachine effects for the standalone composer. */
function isNotice(effect: InputEffect): effect is Extract<InputEffect, { type: 'notice' }> {
  return effect.type === 'notice'
}

function settleEffects(
  machine: InputMachine,
  effects: readonly InputEffect[],
  publish: () => void,
  publishNotice: (notice: Extract<InputEffect, { type: 'notice' }> | undefined) => void,
  onSubmit: ConversationComposerProps['onSubmit'],
): void {
  for (const effect of effects) {
    /* v8 ignore next -- the standalone adapter has no claim owner, so its only non-empty effect is default-sink. */
    if (effect.type !== 'default-sink') continue
    publishNotice(undefined)
    void Promise.resolve().then(() => onSubmit(effect.draft)).then(
      () => {
        const settled = machine.dispatch({ type: 'submit-settled', attempt: effect.attempt, ok: true })
        publishNotice(settled.find(isNotice))
        publish()
      },
      (cause: unknown) => {
        const settled = machine.dispatch({
          type: 'submit-settled', attempt: effect.attempt, ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        })
        publishNotice(settled.find(isNotice))
        publish()
      },
    )
  }
}

/**
 * Render the standard InputBar over a local InputMachine while delegating submission and cancellation.
 * The adapter owns draft mechanics only; the supplied Session projection remains authoritative for run state.
 * @param props - authoritative projection, transport actions, translator, and mutation state.
 * @returns shared InputBar presentation with owner-defined draft mechanics.
 */
export function ConversationComposer({ snapshot, onSubmit, onCancel, t, disabled = false }: ConversationComposerProps): ReactNode {
  const machineRef = useRef<InputMachine>()
  const machine = machineRef.current ?? new InputMachine()
  machineRef.current = machine
  const [input, setInput] = useState<InputState>(() => machine.state)
  const [notice, setNotice] = useState<Extract<InputEffect, { type: 'notice' }>>()
  const publish = useCallback(() => { setInput(machine.state) }, [machine])
  const dispatch = useCallback((event: Parameters<InputMachine['dispatch']>[0]) => {
    const effects = machine.dispatch(event)
    publish()
    settleEffects(machine, effects, publish, setNotice, onSubmit)
  }, [machine, onSubmit, publish])
  const composing = useRef(false)
  const submit = useCallback(() => { dispatch({ type: 'enter', mode: 'queue' }) }, [dispatch])
  const busy = input.phase === 'adjudicating' || input.phase === 'submitting'
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && event.shiftKey) return
    if ((event.metaKey || event.ctrlKey) && (event.key === 'z' || event.key === 'Z' || event.key === 'y')) {
      event.preventDefault()
      if (busy || snapshot.removed) return
      dispatch({ type: event.key === 'y' || event.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (event.key !== 'Enter' || composing.current || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (event.repeat || busy || snapshot.removed) return
    submit()
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (busy || snapshot.removed) return
    const text = event.clipboardData.getData('text/plain')
    if (text === '') return
    event.preventDefault()
    dispatch({
      type: 'paste-begin',
      text,
      selection: {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
    })
  }
  return (
    <div
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
    >
      <InputBarPresentation
        draft={input.draft}
        phase={input.phase}
        running={snapshot.running}
        busy={busy}
        disabled={snapshot.removed || disabled}
        placeholder={t(snapshot.removed ? 'placeholder.unavailable' : 'placeholder.default')}
        onDraftChange={(draft) => { dispatch({ type: 'draft-changed', draft }) }}
        onSubmit={submit}
        onStop={onCancel}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        notice={notice}
        t={t}
      />
    </div>
  )
}

export { AssistantMarkdown }
export type { AssistantMarkdownProps } from './client/chat/AssistantMarkdown.tsx'
export { InputBarPresentation }
export type { InputBarPresentationProps } from './client/skeleton/InputBarPresentation.tsx'
