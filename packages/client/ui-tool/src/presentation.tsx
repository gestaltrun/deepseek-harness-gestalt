/** Public Tool presentation seam for Web compositions outside the Desktop page shell. */

import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallOwnerProps, ToolPresentationViewProps } from './client/contract/slots.ts'
import { BuiltinToolview } from './client/tool/toolviews/builtins.tsx'
import { GenericToolCard } from './client/tool/toolviews/GenericToolCard.tsx'

/** Props for one authoritative Tool lifecycle tree. */
export interface ToolPresentationProps {
  /** Desktop-authoritative running or settled root call. */
  block: ToolCallBlock
  /** Session Workspace root used for path and terminal presentation. */
  cwd?: string | undefined
  /** Desktop account home used to abbreviate paths. */
  home?: string | undefined
  /** Open a file through the Mobile authority adapter; absent keeps paths read-only. */
  openFile?: ((path: string) => void) | undefined
  /** Inspect a call through an optional product route. */
  inspectCall?: ((callId: string) => void) | undefined
  /** Shared conversation translator. */
  t: TranslateNS<'conversation'>
}

const NOOP_OPEN_FILE = (_path: string): void => {}
const NOOP_LOAD_IMAGE: MessageImageLoader = async () => ''

function callName(block: ToolCallBlock): string {
  return 'kind' in block ? block.call?.name ?? '' : block.name
}

function ToolPresentationBranch({
  block, cwd, home, openFile, inspectCall, t,
}: ToolPresentationProps): ReactNode {
  const owner: ToolCallOwnerProps = {
    callId: block.callId,
    toolName: callName(block),
    block,
    openFile: openFile ?? NOOP_OPEN_FILE,
    loadImage: NOOP_LOAD_IMAGE,
    ...(cwd === undefined ? {} : { cwd }),
    ...(home === undefined ? {} : { home }),
    ...(inspectCall === undefined ? {} : { inspect: () => { inspectCall(block.callId) } }),
  }
  return (
    <div>
      <BuiltinToolview
        {...owner as ToolPresentationViewProps}
        t={t}
        fallback={<GenericToolCard {...owner} t={t} />}
      />
      {block.subCalls.map(child => (
        <ToolPresentationBranch
          key={child.callId}
          block={child}
          cwd={cwd}
          home={home}
          openFile={openFile}
          inspectCall={inspectCall}
          t={t}
        />
      ))}
    </div>
  )
}

/**
 * Render one Tool lifecycle through the same keyed built-in roster as Desktop.
 * Unknown wire Tool names alone use GenericToolCard.
 */
export function ToolPresentation(props: ToolPresentationProps): ReactNode {
  return <ToolPresentationBranch {...props} />
}
