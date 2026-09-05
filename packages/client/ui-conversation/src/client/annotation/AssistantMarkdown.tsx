import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText, type MarkdownSelectionMapRef } from '@deepseek-ai/dsh-client-ui-primitives'
import { TextAnnotationTarget } from './TextAnnotationTarget.tsx'
import type { TextAnchor, TextAnnotation, TextAnnotationId } from '../contract/annotation.ts'

function markdownLabels(t: (key: string) => string): { code: { copyLabel: string; copiedLabel: string }; footnotes: string } {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('footnotes'),
  }
}

/**
 * Conversation-owned Markdown wrapper that hosts text-annotation selection.
 * @param props.blocks - Assistant text blocks joined into one Markdown source.
 * @param props.t - Conversation locale seat for fence chrome and annotation copy.
 * @param props.sourceId - Stable completed-message identity; absence keeps selection inert.
 * @param props.annotations - Unsent text annotations for this source.
 * @param props.annotationActions - Create verb; absence skips selection mapping.
 * @param props.streaming - Whether the Markdown source is still growing.
 * @returns Annotatable Markdown when a source and create verb are present.
 */
export function AssistantMarkdown({
  blocks, t, sourceId, annotations = [], annotationActions, streaming = false,
}: {
  blocks: readonly { kind: string; text?: string }[]
  t: (key: string) => string
  sourceId?: string
  annotations?: readonly TextAnnotation[]
  annotationActions?: { addTextAnnotation: (anchor: TextAnchor, note?: string) => TextAnnotationId }
  streaming?: boolean
}): ReactNode {
  const selectionMapRef = useRef<MarkdownSelectionMapRef['current']>(null)
  const labels = useMemo(() => markdownLabels(t), [t])
  const text = blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('')
  const body = (
    <MarkdownText
      text={text}
      streaming={streaming}
      labels={labels}
      {...(annotationActions === undefined ? {} : { selectionMapRef })}
    />
  )
  if (sourceId === undefined || annotationActions === undefined) return body
  return (
    <TextAnnotationTarget
      sourceId={sourceId}
      selectionMapRef={selectionMapRef}
      annotations={annotations.filter(item => item.kind === 'text')}
      add={(anchor, note) => annotationActions.addTextAnnotation(anchor, note)}
      t={t}
    >
      {body}
    </TextAnnotationTarget>
  )
}
