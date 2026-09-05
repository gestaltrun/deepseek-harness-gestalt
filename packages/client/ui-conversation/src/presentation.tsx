/** Public presentation seam shared by Web compositions that do not mount the Desktop page shell. */

import { useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { JsonBlock, MarkdownText, projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ConversationNode, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
} from './client/contract/records.ts'
import type { InputEffect } from './client/contract/input.ts'
import { SubmitMachine } from './client/input/machine.ts'
import { InputBarPresentation } from './client/skeleton/InputBarPresentation.tsx'
import { en, zh } from './client/locales.ts'
import type { RenderMessageImages } from './client/contract/slots.ts'

/** Locale ids supported by the shared Web presentation. */
export type ConversationPresentationLocale = 'zh' | 'en'

const COMMON = {
  zh: {
    copy: '复制',
    copied: '复制成功',
    loading: '加载中…',
    'message.unknownSurface': '未知 surface 事件：{type}',
    'json.truncated': '… 已截断，共 {total} 字符',
    footnotes: '脚注',
  },
  en: {
    copy: 'Copy',
    copied: 'Copied',
    loading: 'Loading…',
    'message.unknownSurface': 'Unknown surface event: {type}',
    'json.truncated': '… truncated, {total} characters total',
    footnotes: 'Footnotes',
  },
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
  const translate = ((key: string, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? common[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match)
  }) as TranslateNS<'conversation'>
  return translate
}

function presentationCopy(
  t: TranslateNS<'conversation'>,
  key: string,
  params?: Record<string, unknown>,
): string {
  return (t as (lookup: string, values?: Record<string, unknown>) => string)(key, params)
}

function markdownLabels(t: TranslateNS<'conversation'>): { code: { copyLabel: string; copiedLabel: string }; footnotes: string } {
  return {
    code: { copyLabel: presentationCopy(t, 'copy'), copiedLabel: presentationCopy(t, 'copied') },
    footnotes: presentationCopy(t, 'footnotes'),
  }
}

/** Props for the shared user-message renderer. */
export interface ConversationUserMessageProps {
  /** Desktop-authoritative message content. */
  content: readonly unknown[]
  /** Shared image renderer bound to the current Session's authorized loader. */
  renderMessageImages: RenderMessageImages
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
}

/** Render a user message through the same bubble implementation as Desktop. */
export function ConversationUserMessage({ content, renderMessageImages, t }: ConversationUserMessageProps): ReactNode {
  const texts: string[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const record = block as { type?: string; text?: string }
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text)
    else rest.push(block)
  }
  const text = texts.join('')
  return (
    <div>
      {renderMessageImages({ images: [], align: 'end' })}
      {text !== '' && <div>{projectUserText(text, [])}</div>}
      {rest.map((block, index) => (
        <JsonBlock
          key={index}
          label={presentationCopy(t, 'message.unknownSurface', { type: 'block' })}
          payload={block}
          truncatedLabel={total => presentationCopy(t, 'json.truncated', { total })}
        />
      ))}
    </div>
  )
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
  return (
    <div role="status">
      {node.kind === 'turn-error' ? node.message : t('placeholder.unavailable')}
    </div>
  )
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
        <>
          {node.blocks.map((block, index) => {
            if (block.kind === 'text') {
              return <MarkdownText key={index} text={block.text} streaming={false} labels={markdownLabels(t)} />
            }
            if (block.kind === 'image') {
              return (
                <div key={index}>
                  {renderMessageImages({ images: [{ attachment: block.attachment }], align: 'start' })}
                </div>
              )
            }
            return (
              <JsonBlock
                key={index}
                label={presentationCopy(t, 'message.unknownSurface', { type: block.kind })}
                payload={block}
                truncatedLabel={total => presentationCopy(t, 'json.truncated', { total })}
              />
            )
          })}
        </>
      )
    case 'tool-result':
      return renderTool(node)
    case 'turn-error':
    case 'turn-max-tokens':
      return <ConversationFailure node={node} t={t} />
    case 'context':
    case 'model-retry':
    case 'command':
    case 'compaction':
      return (
        <JsonBlock
          label={presentationCopy(t, 'message.unknownSurface', { type: node.kind })}
          payload={node}
          truncatedLabel={total => presentationCopy(t, 'json.truncated', { total })}
        />
      )
    case 'unknown':
      return (
        <JsonBlock
          label={presentationCopy(t, 'message.unknownSurface', { type: node.type })}
          payload={node.data}
          truncatedLabel={total => presentationCopy(t, 'json.truncated', { total })}
        />
      )
    /* v8 ignore next -- every current Conversation Node kind is handled above. */
    default: return assertNever(node)
  }
}

/** Pending Approval carrier accepted by the shared takeover. */
export interface ConversationApprovalWait {
  /** Domain discriminator. */
  readonly kind: 'approval'
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string | undefined
  /**
   * Resolve the Host waterfall with the user's decision.
   * @param outcome - supported interactive decision.
   * @returns settlement promise.
   */
  answer(outcome: 'allowed-once' | 'rejected'): Promise<void>
}

/** Props for the shared Approval takeover. */
export interface ConversationApprovalProps {
  /** Desktop-authoritative pending Approval carrier. */
  wait: ConversationApprovalWait
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
  /** Disable settlement while the composition lacks current mutation authority. */
  disabled?: boolean | undefined
}

/**
 * Render and settle an Approval through the same composer takeover as Desktop.
 * @param props - authoritative pending Approval, translator, and mutation state.
 * @returns shared Approval takeover.
 */
export function ConversationApproval({ wait, t, disabled = false }: ConversationApprovalProps): ReactNode {
  return (
    <div>
      <p>{wait.reason ?? t('placeholder.unavailable')}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { void wait.answer('allowed-once') }}
      >
        {t('input.send')}
      </button>
    </div>
  )
}

/** Props for the shared standalone composer adapter. */
export interface ConversationComposerProps {
  /** Desktop-authoritative Session projection controlling run and removal state. */
  snapshot: SessionSnapshot
  /** Submit one prompt through the composition's authority adapter. */
  onSubmit: (text: string) => void | Promise<void>
  /** Cancel the active Desktop turn when supplied. */
  onCancel?: (() => void) | undefined
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
  /** Disable edits and mutations while the composition lacks current authority. */
  disabled?: boolean | undefined
  /** Owner-supplied controls placed in the shared InputBar's leading tool row. */
  tools?: ReactNode | undefined
}

function isNotice(effect: InputEffect): effect is Extract<InputEffect, { type: 'notice' }> {
  return effect.type === 'notice'
}

function settleEffects(
  machine: SubmitMachine,
  effects: readonly InputEffect[],
  publish: () => void,
  publishNotice: (notice: Extract<InputEffect, { type: 'notice' }> | undefined) => void,
  setDraft: (draft: string) => void,
  setBusy: (busy: boolean) => void,
  onSubmit: ConversationComposerProps['onSubmit'],
): void {
  for (const effect of effects) {
    if (effect.type !== 'default-sink') continue
    setBusy(true)
    publishNotice(undefined)
    void Promise.resolve().then(() => onSubmit(effect.draft)).then(
      () => {
        const settled = machine.dispatch({
          type: 'sink-settled', attempt: effect.attempt, ok: true,
        })
        setDraft('')
        setBusy(false)
        publishNotice(settled.find(isNotice))
        publish()
      },
      (cause: unknown) => {
        const settled = machine.dispatch({
          type: 'sink-settled',
          attempt: effect.attempt,
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        })
        setBusy(false)
        publishNotice(settled.find(isNotice))
        publish()
      },
    )
  }
}

/**
 * Render the standard InputBar over a local SubmitMachine while delegating submission and cancellation.
 * The adapter owns draft mechanics only; the supplied Session projection remains authoritative for run state.
 * @param props - authoritative projection, transport actions, translator, and mutation state.
 * @returns shared InputBar presentation with owner-defined draft mechanics.
 */
export function ConversationComposer({
  snapshot, onSubmit, onCancel, t, disabled = false, tools,
}: ConversationComposerProps): ReactNode {
  const machineRef = useRef<SubmitMachine>()
  const machine = machineRef.current ?? new SubmitMachine()
  machineRef.current = machine
  const [draft, setDraft] = useState('')
  const [, setPhase] = useState(machine.state.phase)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [notice, setNotice] = useState<Extract<InputEffect, { type: 'notice' }>>()
  const markBusy = useCallback((next: boolean) => {
    busyRef.current = next
    setBusy(next)
  }, [])
  const publish = useCallback(() => { setPhase(machine.state.phase) }, [machine])
  const dispatch = useCallback((event: Parameters<SubmitMachine['dispatch']>[0]) => {
    const effects = machine.dispatch(event)
    publish()
    settleEffects(machine, effects, publish, setNotice, setDraft, markBusy, onSubmit)
  }, [machine, markBusy, onSubmit, publish])
  const composing = useRef(false)
  const submit = useCallback(() => { dispatch({ type: 'enter', mode: 'queue', draft }) }, [dispatch, draft])
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && event.shiftKey) return
    if ((event.metaKey || event.ctrlKey) && (event.key === 'z' || event.key === 'Z' || event.key === 'y')) {
      event.preventDefault()
      return
    }
    if (event.key !== 'Enter' || composing.current || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (event.repeat || busyRef.current || snapshot.removed) return
    submit()
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (busyRef.current || snapshot.removed) return
    const text = event.clipboardData.getData('text/plain')
    if (text === '') return
    event.preventDefault()
    const start = event.currentTarget.selectionStart
    const end = event.currentTarget.selectionEnd
    setDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`)
  }
  return (
    <div
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
    >
      <InputBarPresentation
        draft={draft}
        phase={machine.state.phase}
        running={snapshot.running}
        busy={busy}
        disabled={snapshot.removed || disabled}
        placeholder={t(snapshot.removed ? 'placeholder.unavailable' : 'placeholder.default')}
        onDraftChange={(next) => {
          setDraft(next)
          dispatch({ type: 'draft-changed', draft: next })
        }}
        onSubmit={submit}
        onStop={onCancel}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        notice={notice}
        tools={tools}
        t={t}
      />
    </div>
  )
}
