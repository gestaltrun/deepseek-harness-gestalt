import { useMemo, useRef, type ReactNode } from 'react'
import type {
  ConversationSnapshot, PendingWait,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CompanionHostFailure } from '@deepseek-ai/dsh-remote-protocol'
import {
  AssistantMarkdown,
  ConversationApproval,
  ConversationComposer,
  ConversationNodePresentation,
  conversationPresentationTranslate,
  type ConversationPresentationLocale,
} from '@deepseek-ai/dsh-client-ui-conversation/presentation'
import { ToolPresentation } from '@deepseek-ai/dsh-client-ui-tool/presentation'
import { ImageGallery, messageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment/presentation'
import {
  QuestionPresentation, questionPresentationTranslate,
} from '@deepseek-ai/dsh-client-ui-user-questions/presentation'
import css from './MobileConversation.module.css'

/** Full-screen Mobile conversation props. */
export interface MobileConversationProps {
  /** Session title. */
  title: string
  /** Return to the list. */
  onBack: () => void
  /** Desktop-authoritative Session projection. */
  snapshot: ConversationSnapshot
  /** Product locale applied to all shared presentation components. */
  locale?: ConversationPresentationLocale | undefined
  /** Product theme selected by the Mobile shell. */
  theme?: 'light' | 'dark' | undefined
  /** Session-authorized historical-image loader. */
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  /** Session Workspace root used by shared Tool rows. */
  cwd?: string | undefined
  /** Desktop account home used by shared path summaries. */
  home?: string | undefined
  /** Submit a prompt through Desktop acceptance. */
  onSubmit?: ((text: string) => void | Promise<void>) | undefined
  /** Cancel active execution through Desktop cancellation. */
  onCancel?: (() => void) | undefined
  /** Select an attachment for encrypted transfer through Desktop. */
  onAttach?: ((file: File) => void) | undefined
  /** Load the preceding Desktop-authoritative history window. */
  onLoadOlder?: (() => void) | undefined
  /** Whether current foreground synchronization admits mutations. */
  mutationEnabled?: boolean | undefined
  /** Latest correlated Companion operation failure. */
  operationFailure?: CompanionHostFailure | undefined
}

/** Phone conversation using Desktop-authoritative projections and exported DSH Web presentation. */
export function MobileConversation({
  title,
  onBack,
  snapshot,
  locale = 'zh',
  theme = 'light',
  loadImage,
  cwd,
  home,
  onSubmit,
  onCancel,
  onAttach,
  onLoadOlder,
  mutationEnabled = false,
  operationFailure,
}: MobileConversationProps): ReactNode {
  const attachmentInput = useRef<HTMLInputElement>(null)
  const t = useMemo(() => conversationPresentationTranslate(locale), [locale])
  const tq = useMemo(() => questionPresentationTranslate(locale), [locale])
  const imageLabels = useMemo(() => messageImageLabels(t), [t])
  const renderMessageImages = ({ images, align }: {
    images: readonly { attachment: ImageAttachmentRef }[]
    align: 'start' | 'end'
  }): ReactNode => <ImageGallery images={images} load={loadImage} align={align} labels={imageLabels} />
  const renderTool = (node: Parameters<typeof ToolPresentation>[0]['block']): ReactNode => (
    <ToolPresentation block={node} cwd={cwd} home={home} t={t} />
  )
  const question = snapshot.pending.find((wait): wait is PendingWait<'question'> => wait.kind === 'question')
  const approval = snapshot.pending.find((wait): wait is PendingWait<'approval'> => wait.kind === 'approval')
  return (
    <section
      className={css.page}
      data-mobile-conversation="detail"
      data-locale={locale}
      data-theme={theme}
      data-ds-dark-theme={theme === 'dark' ? '' : undefined}
      lang={locale === 'zh' ? 'zh-CN' : 'en'}
    >
      <header className={css.header}>
        <button type="button" className={css.back} onClick={onBack}>{locale === 'zh' ? '返回' : 'Back'}</button>
        <h1>{title}</h1>
      </header>
      {operationFailure !== undefined && <p role="alert">{operationFailure.message}</p>}
      <div className={css.blocks} data-conversation-scroll="">
        {snapshot.openState === 'loading' && <p role="status">{t('chat.loadingHistory')}</p>}
        {snapshot.openState === 'error' && snapshot.openError !== null && (
          <p role="status">{t('chat.loadError', { message: snapshot.openError.message, code: snapshot.openError.code })}</p>
        )}
        {snapshot.hasMore && onLoadOlder !== undefined && (
          <button type="button" disabled={snapshot.loadingOlder || !mutationEnabled} onClick={onLoadOlder}>
            {snapshot.loadingOlder ? t('chat.loadingHistory') : t('chat.loadOlder')}
          </button>
        )}
        {snapshot.nodes.map(node => (
          <ConversationNodePresentation
            key={`${node.kind}:${String(node.seq)}`}
            node={node}
            renderMessageImages={renderMessageImages}
            renderTool={renderTool}
            t={t}
          />
        ))}
        {snapshot.partial !== null && (
          <AssistantMarkdown
            blocks={snapshot.partial.blocks}
            streaming
            renderMessageImages={renderMessageImages}
            t={t}
          />
        )}
        {snapshot.runningCalls.map(call => (
          <ToolPresentation key={call.callId} block={call} cwd={cwd} home={home} t={t} />
        ))}
      </div>
      <div className={css.composer}>
        {question !== undefined
          ? <QuestionPresentation wait={question} t={tq} disabled={!mutationEnabled} />
          : approval !== undefined
            ? <ConversationApproval wait={approval} snapshot={snapshot} t={t} disabled={!mutationEnabled} />
            : onSubmit !== undefined
              ? <ConversationComposer
                snapshot={snapshot}
                onSubmit={onSubmit}
                onCancel={onCancel}
                t={t}
                disabled={!mutationEnabled}
              />
              : null}
        {onAttach !== undefined && (
          <>
            <input
              ref={attachmentInput}
              type="file"
              aria-label={locale === 'zh' ? '添加附件' : 'Add attachment'}
              hidden
              disabled={!mutationEnabled}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file !== undefined && mutationEnabled) onAttach(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              disabled={!mutationEnabled}
              onClick={() => { if (mutationEnabled) attachmentInput.current?.click() }}
            >{locale === 'zh' ? '添加附件' : 'Add attachment'}</button>
          </>
        )}
      </div>
    </section>
  )
}
