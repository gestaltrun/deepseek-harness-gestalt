/** Public Tool presentation seam for Web compositions outside the Desktop page shell. */

import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DirectToolCallTree } from './client/tool/ToolCallTree.tsx'
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

/**
 * Render one Tool lifecycle through the same keyed built-in roster as Desktop.
 * Unknown wire Tool names alone use GenericToolCard.
 */
export function ToolPresentation({
  block, cwd, home, openFile, inspectCall, t,
}: ToolPresentationProps): ReactNode {
  return (
    <DirectToolCallTree
      block={block}
      cwd={cwd}
      home={home}
      openFile={openFile}
      inspectCall={inspectCall}
      renderCall={owner => (
        <BuiltinToolview {...owner} t={t} fallback={<GenericToolCard {...owner} t={t} />} />
      )}
    />
  )
}
